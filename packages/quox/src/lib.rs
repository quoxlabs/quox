use anyrender_vello::VelloScenePainter;
use blitz_dom::{FontContext, Point};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use linebender_resource_handle::Blob;
use std::sync::Arc;
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use wgpu_context::WGPUContext;

mod dom;

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Renders HTML documents to RGBA pixel buffers using WebGPU (Blitz + Vello).
///
/// Designed to run inside the Deno runtime, which provides native WebGPU
/// support. The caller is responsible for displaying the returned pixel data,
/// e.g. via X11 FFI using `XPutImage`.
#[wasm_bindgen]
pub struct QuoxRenderer {
    width: u32,
    height: u32,
    scroll_x: f64,
    scroll_y: f64,
    pub(crate) document: HtmlDocument,
    context: WGPUContext,
    dev_id: usize,
    renderer: Renderer,
}

#[wasm_bindgen]
#[allow(clippy::missing_errors_doc)]
impl QuoxRenderer {
    /// Initialise a renderer with a blank live document and viewport dimensions.
    ///
    /// Acquires a WebGPU device; must be `await`ed.
    pub async fn create(width: u32, height: u32) -> Result<QuoxRenderer, JsValue> {
        Self::create_renderer(width, height).await
    }

    /// Resize the rendering viewport.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
    }

    /// Scroll the viewport by the given pixel delta. Negative values scroll
    /// towards the top/left; the position is clamped to 0 at the origin.
    pub fn scroll(&mut self, delta_x: i32, delta_y: i32) {
        self.scroll_x = (self.scroll_x + f64::from(delta_x)).max(0.0);
        self.scroll_y = (self.scroll_y + f64::from(delta_y)).max(0.0);
    }

    /// Render the current HTML and return a flat `width × height × 4`
    /// RGBA byte buffer (`TextureFormat::Rgba8Unorm`).
    pub async fn render(&mut self) -> Result<Vec<u8>, JsValue> {
        let w = self.width;
        let h = self.height;

        self.document
            .set_viewport(Viewport::new(w, h, 1.0, ColorScheme::Light));
        self.document.resolve(0.0);

        let content = self.document.root_element().final_layout.size;
        self.scroll_x = self.scroll_x.min(scroll_limit(content.width, w));
        self.scroll_y = self.scroll_y.min(scroll_limit(content.height, h));
        self.document.set_viewport_scroll(Point {
            x: self.scroll_x,
            y: self.scroll_y,
        });

        let device_handle = self.context.device_pool[self.dev_id].clone();

        let texture = device_handle.device.create_texture(&TextureDescriptor {
            label: Some("quox-target"),
            size: Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT
                | TextureUsages::COPY_SRC
                | TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&TextureViewDescriptor::default());

        let mut scene = Scene::new();
        let mut painter = VelloScenePainter::new(&mut scene);
        paint_scene(&mut painter, &self.document, 1.0, w, h, 0, 0);

        self.renderer
            .render_to_texture(
                &device_handle.device,
                &device_handle.queue,
                &scene,
                &texture_view,
                &RenderParams {
                    base_color: vello::peniko::Color::WHITE,
                    width: w,
                    height: h,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("Vello render: {e:?}")))?;

        let row_bytes = w * 4;
        let padded_row_bytes = row_bytes.next_multiple_of(256);
        let out_size = u64::from(padded_row_bytes) * u64::from(h);
        let gpu_buffer = device_handle.device.create_buffer(&BufferDescriptor {
            label: Some("quox-readback"),
            size: out_size,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder =
            device_handle
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("quox-copy"),
                });
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &gpu_buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row_bytes),
                    rows_per_image: None,
                },
            },
            texture.size(),
        );
        device_handle.queue.submit([encoder.finish()]);

        let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
        let buf_slice = gpu_buffer.slice(..);
        let (tx, rx) = futures_intrusive::channel::shared::oneshot_channel();
        buf_slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let map_res = rx
            .receive()
            .await
            .ok_or_else(|| JsValue::from_str("map_async channel closed"))?;
        map_res.map_err(|e| JsValue::from_str(&format!("map_async: {e:?}")))?;

        {
            let mapped = buf_slice.get_mapped_range();
            let row_bytes_us = row_bytes as usize;
            let padded_us = padded_row_bytes as usize;
            for row in 0..(h as usize) {
                let src = row * padded_us;
                let dst = row * row_bytes_us;
                rgba[dst..dst + row_bytes_us].copy_from_slice(&mapped[src..src + row_bytes_us]);
            }
        }
        gpu_buffer.unmap();

        Ok(rgba)
    }
}

impl QuoxRenderer {
    async fn create_renderer(width: u32, height: u32) -> Result<QuoxRenderer, JsValue> {
        let mut context = WGPUContext::new();
        let dev_id = context
            .find_or_create_device(None)
            .await
            .map_err(|e| JsValue::from_str(&format!("WebGPU device: {e:?}")))?;

        let renderer = Renderer::new(
            &context.device_pool[dev_id].device,
            RendererOptions {
                use_cpu: false,
                num_init_threads: None,
                antialiasing_support: AaSupport::area_only(),
                pipeline_cache: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Vello renderer: {e:?}")))?;

        let mut font_ctx = FontContext::default();
        font_ctx
            .collection
            .register_fonts(Blob::new(Arc::new(LIBERATION_SANS) as _), None);
        let document = dom::blank_document(font_ctx.clone());

        Ok(QuoxRenderer {
            width: width.max(1),
            height: height.max(1),
            scroll_x: 0.0,
            scroll_y: 0.0,
            document,
            context,
            dev_id,
            renderer,
        })
    }
}

fn scroll_limit(content_length: f32, viewport_length: u32) -> f64 {
    (f64::from(content_length) - f64::from(viewport_length)).max(0.0)
}
