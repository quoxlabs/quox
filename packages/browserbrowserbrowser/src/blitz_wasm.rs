//! Full HTML/CSS paint in the page using **Blitz** (Stylo + Taffy + Vello) → RGBA → canvas `ImageData`.
//! Requires a browser with **WebGPU** support.

use anyrender_vello::VelloScenePainter;
use blitz_dom::DocumentConfig;
use blitz_dom::net::{Resource, ResourceLoadResponse};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use std::sync::Arc;
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{HtmlCanvasElement, ImageData};
use wgpu_context::WGPUContext;

use crate::PaintResult;

const MAX_PX_HEIGHT: u32 = 16_384;
const DEFAULT_FONT_URLS: &[&str] =
    &["https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"];

async fn fetch_bytes_with_cors(url: &str) -> Result<Vec<u8>, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no window"))?;
    let opts = web_sys::RequestInit::new();
    opts.set_method("GET");
    opts.set_mode(web_sys::RequestMode::Cors);
    let request = web_sys::Request::new_with_str_and_init(url, &opts)
        .map_err(|_| JsValue::from_str("invalid request"))?;
    let resp_val = JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(|_| JsValue::from_str("fetch failed"))?;
    let resp: web_sys::Response = resp_val
        .dyn_into()
        .map_err(|_| JsValue::from_str("bad response"))?;
    if !resp.ok() {
        return Err(JsValue::from_str(&format!("font HTTP {}", resp.status())));
    }
    let ab = JsFuture::from(
        resp.array_buffer()
            .map_err(|_| JsValue::from_str("font no body"))?,
    )
    .await
    .map_err(|_| JsValue::from_str("font read failed"))?;
    let arr = js_sys::Uint8Array::new(&ab);
    let mut out = vec![0u8; arr.length() as usize];
    arr.copy_to(&mut out);
    Ok(out)
}

fn inject_wasm_font_fallback(html: &str) -> String {
    let style = "<style>html,body,*{font-family:'Inter','Noto Sans','Roboto',sans-serif !important;}</style>";
    if html.contains("</head>") {
        html.replacen("</head>", &(style.to_string() + "</head>"), 1)
    } else {
        format!("{style}{html}")
    }
}

pub async fn paint_blitz_async(
    canvas: &HtmlCanvasElement,
    html: &str,
    page_url: &str,
    css_w: f64,
    dpr: f64,
) -> Result<PaintResult, JsValue> {
    let html = inject_wasm_font_fallback(html);
    let dpr = dpr.max(1.0);
    let css_w = css_w.max(120.0);
    let phys_w = (css_w * dpr).round().max(1.0) as u32;

    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            base_url: Some(page_url.to_string()),
            net_provider: Some(Arc::new(DummyNetProvider::default())),
            shell_provider: Some(Arc::new(DummyShellProvider)),
            ..Default::default()
        },
    );

    let mut loaded_any_font = false;
    for url in DEFAULT_FONT_URLS {
        if let Ok(font_bytes) = fetch_bytes_with_cors(url).await {
            doc.load_resource(ResourceLoadResponse {
                request_id: 0,
                node_id: None,
                resolved_url: Some((*url).to_string()),
                result: Ok(Resource::Font(font_bytes.into())),
            });
            loaded_any_font = true;
            break;
        }
    }
    if !loaded_any_font {
        web_sys::console::warn_1(&JsValue::from_str(
            "blitz: failed to load fallback font; text may be blank",
        ));
    }

    // Measure pass: tall viewport so root scroll height is meaningful.
    let probe_h = 4096u32;
    doc.set_viewport(Viewport::new(
        phys_w,
        probe_h,
        dpr as f32,
        ColorScheme::Light,
    ));
    doc.resolve(0.0);

    let scroll_h = doc
        .root_element()
        .final_layout
        .scroll_height()
        .ceil()
        .max(1.0) as u32;
    // Some documents can transiently report near-zero height on first resolve in wasm.
    // If that happens, keep a visible probe height instead of rendering a 1px canvas.
    let phys_h = if scroll_h < 32 {
        probe_h.min(MAX_PX_HEIGHT)
    } else {
        scroll_h.min(MAX_PX_HEIGHT).max(1)
    };

    doc.set_viewport(Viewport::new(
        phys_w,
        phys_h,
        dpr as f32,
        ColorScheme::Light,
    ));
    doc.resolve(0.0);

    let mut context = WGPUContext::new();
    let dev_id = context
        .find_or_create_device(None)
        .await
        .map_err(|e| JsValue::from_str(&format!("WebGPU device: {e:?}")))?;
    let device_handle = context.device_pool[dev_id].clone();

    let texture = device_handle.device.create_texture(&TextureDescriptor {
        label: Some("blitz-wasm-target"),
        size: Extent3d {
            width: phys_w,
            height: phys_h,
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

    let mut renderer = Renderer::new(
        &device_handle.device,
        RendererOptions {
            use_cpu: false,
            num_init_threads: None,
            antialiasing_support: AaSupport::area_only(),
            pipeline_cache: None,
        },
    )
    .map_err(|e| JsValue::from_str(&format!("Vello renderer: {e:?}")))?;

    let mut scene = Scene::new();
    let scale = dpr;
    let mut painter = VelloScenePainter::new(&mut scene);
    paint_scene(&mut painter, &*doc, scale, phys_w, phys_h, 0, 0);

    renderer
        .render_to_texture(
            &device_handle.device,
            &device_handle.queue,
            &scene,
            &texture_view,
            &RenderParams {
                // White base avoids "invisible on transparent background" failures.
                base_color: vello::peniko::Color::WHITE,
                width: phys_w,
                height: phys_h,
                antialiasing_method: AaConfig::Area,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Vello render: {e:?}")))?;

    let row_bytes = phys_w * 4;
    let padded_row_bytes = row_bytes.next_multiple_of(256);
    let out_size = (padded_row_bytes as u64) * (phys_h as u64);
    let gpu_buffer = device_handle.device.create_buffer(&BufferDescriptor {
        label: Some("blitz-wasm-readback"),
        size: out_size,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let mut encoder =
        device_handle
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("blitz-copy"),
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

    let mut rgba = vec![0u8; (phys_w as usize) * (phys_h as usize) * 4];
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

    let mapped = buf_slice.get_mapped_range();
    let row_bytes_us = row_bytes as usize;
    let padded_us = padded_row_bytes as usize;
    for row in 0..(phys_h as usize) {
        let src_start = row * padded_us;
        let dst_start = row * row_bytes_us;
        rgba[dst_start..(dst_start + row_bytes_us)]
            .copy_from_slice(&mapped[src_start..(src_start + row_bytes_us)]);
    }
    drop(mapped);
    gpu_buffer.unmap();

    // Guard: if the frame is fully transparent, treat it as a render failure
    // so caller can fall back to the simple flow renderer.
    if !rgba.chunks_exact(4).any(|px| px[3] != 0) {
        return Err(JsValue::from_str("blitz produced fully transparent frame"));
    }

    canvas.set_width(phys_w);
    canvas.set_height(phys_h);
    let ctx: web_sys::CanvasRenderingContext2d = canvas
        .get_context("2d")
        .map_err(|_| JsValue::from_str("canvas 2d"))?
        .ok_or_else(|| JsValue::from_str("2d unsupported"))?
        .dyn_into()
        .map_err(|_| JsValue::from_str("2d context"))?;
    ctx.set_transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        .map_err(|_| JsValue::from_str("setTransform"))?;

    let data =
        ImageData::new_with_u8_clamped_array_and_sh(wasm_bindgen::Clamped(&rgba), phys_w, phys_h)
            .map_err(|e| JsValue::from_str(&format!("ImageData: {e:?}")))?;
    ctx.put_image_data(&data, 0.0, 0.0)
        .map_err(|_| JsValue::from_str("putImageData"))?;

    let height_css_px = phys_h as f64 / dpr;

    Ok(PaintResult { height_css_px })
}
