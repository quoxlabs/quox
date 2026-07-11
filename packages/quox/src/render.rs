use super::QuoxRenderer;
use anyrender_vello::VelloScenePainter;
use blitz_paint::paint_scene;
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, RenderParams, Scene};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl QuoxRenderer {
    /// Render the current HTML and return a flat framebuffer-width × framebuffer-height × 4
    /// RGBA byte buffer (`TextureFormat::Rgba8Unorm`).
    pub async fn render(&self) -> Result<Vec<u8>, JsValue> {
        let (_texture, gpu_buffer, row_bytes, padded_row_bytes, w, h) = {
            let mut state = self.state.borrow_mut();
            state.sync_layout();
            let w = state.framebuffer_width;
            let h = state.framebuffer_height;
            let scale = f64::from(state.device_pixel_ratio);

            let device_handle = state.context.device_pool[state.dev_id].clone();

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
            paint_scene(&mut painter, &mut state.document, scale, w, h, 0, 0);

            state
                .renderer
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

            (texture, gpu_buffer, row_bytes, padded_row_bytes, w, h)
        };

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
