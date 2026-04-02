use anyrender_vello::VelloScenePainter;
use blitz_dom::{DocumentConfig, FontContext};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use linebender_resource_handle::Blob;
use std::sync::Arc;
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use wgpu_context::WGPUContext;

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");

/// Prepend a `<style>` that names our embedded font explicitly so that blitz's
/// CSS resolver finds it (the generic-family map is empty on wasm32).
fn inject_font_css(html: &str) -> String {
    const STYLE: &str =
        "<style>html,body,*{font-family:'Liberation Sans',sans-serif;}</style>";
    if let Some(pos) = html.find("</head>") {
        format!("{}{}{}", &html[..pos], STYLE, &html[pos..])
    } else {
        format!("{STYLE}{html}")
    }
}

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
    html: String,
    width: u32,
    height: u32,
    context: WGPUContext,
    dev_id: usize,
    renderer: Renderer,
    font_ctx: FontContext,
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Initialise a renderer with the given HTML and viewport dimensions.
    ///
    /// Acquires a WebGPU device; must be `await`ed.
    pub async fn create(html: &str, width: u32, height: u32) -> Result<QuoxRenderer, JsValue> {
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

        Ok(QuoxRenderer {
            html: html.to_owned(),
            width: width.max(1),
            height: height.max(1),
            context,
            dev_id,
            renderer,
            font_ctx,
        })
    }

    /// Replace the HTML document being rendered.
    pub fn set_html(&mut self, html: &str) {
        self.html = html.to_owned();
    }

    /// Resize the rendering viewport.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
    }

    /// Render the current HTML and return a flat `width × height × 4`
    /// RGBA byte buffer (`TextureFormat::Rgba8Unorm`).
    pub async fn render(&mut self) -> Result<Vec<u8>, JsValue> {
        let w = self.width;
        let h = self.height;

        // Re-create the document each frame so HtmlDocument (which uses Rc
        // internally and is therefore not Send/Sync) never needs to be stored
        // in the struct.
        //
        // On wasm32-unknown-unknown fontique's system-font backend is a no-op,
        // so generic CSS families (sans-serif, etc.) have no mapping. Inject
        // an explicit font-family rule that names the font we embedded.
        let html_with_font = inject_font_css(&self.html);
        let mut doc = HtmlDocument::from_html(
            &html_with_font,
            DocumentConfig {
                base_url: Some("https://example.com".to_string()),
                net_provider: Some(Arc::new(DummyNetProvider::default())),
                shell_provider: Some(Arc::new(DummyShellProvider)),
                font_ctx: Some(self.font_ctx.clone()),
                ..Default::default()
            },
        );
        doc.set_viewport(Viewport::new(w, h, 1.0, ColorScheme::Light));
        doc.resolve(0.0);

        let device_handle = self.context.device_pool[self.dev_id].clone();

        let texture = device_handle.device.create_texture(&TextureDescriptor {
            label: Some("quox-target"),
            size: Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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
        paint_scene(&mut painter, &*doc, 1.0, w, h, 0, 0);

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
        let out_size = (padded_row_bytes as u64) * (h as u64);
        let gpu_buffer = device_handle.device.create_buffer(&BufferDescriptor {
            label: Some("quox-readback"),
            size: out_size,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder = device_handle
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("quox-copy") });
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
