use super::QuoxRenderer;
use anyrender_vello::VelloScenePainter;
use blitz_paint::paint_scene;
use vello::wgpu::{CompositeAlphaMode, PresentMode, SurfaceTarget, TextureFormat, TextureUsages};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::{JsCast, prelude::*};
use wgpu_context::{SurfaceRendererConfiguration, TextureConfiguration};

#[wasm_bindgen]
impl QuoxRenderer {
    /// Drop the cached WebGPU surface so the next render creates a fresh one.
    pub fn reset_surface(&self) {
        self.state.borrow_mut().canvas_surface = None;
    }

    /// Render the current document directly into a canvas-like WebGPU surface.
    pub async fn render_to_canvas(&self, surface_target: JsValue) -> Result<(), JsValue> {
        let needs_surface = self.state.borrow().canvas_surface.is_none();
        if needs_surface {
            // Deno.UnsafeWindowSurface is not an actual OffscreenCanvas, but
            // wgpu's web backend only needs the structural `getContext`,
            // `width`, and `height` members that both objects provide.
            let surface_target = surface_target.unchecked_into::<web_sys::OffscreenCanvas>();
            let (width, height, mut context) = {
                let mut state = self.state.borrow_mut();
                (
                    state.width,
                    state.height,
                    std::mem::take(&mut state.context),
                )
            };

            let surface_result = context
                .create_surface_renderer(
                    SurfaceTarget::OffscreenCanvas(surface_target),
                    SurfaceRendererConfiguration {
                        usage: TextureUsages::RENDER_ATTACHMENT,
                        formats: vec![TextureFormat::Rgba8Unorm, TextureFormat::Bgra8Unorm],
                        width,
                        height,
                        present_mode: PresentMode::AutoVsync,
                        desired_maximum_frame_latency: 2,
                        alpha_mode: CompositeAlphaMode::Auto,
                        view_formats: vec![],
                    },
                    Some(TextureConfiguration {
                        usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
                    }),
                )
                .await;

            let mut state = self.state.borrow_mut();
            state.context = context;
            let surface = surface_result
                .map_err(|e| JsValue::from_str(&format!("WebGPU canvas surface: {e:?}")))?;
            state.renderer = Renderer::new(
                surface.device(),
                RendererOptions {
                    use_cpu: false,
                    num_init_threads: None,
                    antialiasing_support: AaSupport::area_only(),
                    pipeline_cache: None,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("Vello renderer: {e:?}")))?;
            state.canvas_surface = Some(surface);
        }

        let mut state = self.state.borrow_mut();
        state.sync_layout();
        let w = state.width;
        let h = state.height;
        let mut scene = Scene::new();
        let mut painter = VelloScenePainter::new(&mut scene);
        paint_scene(&mut painter, &mut state.document, 1.0, w, h, 0, 0);

        let state = &mut *state;
        let surface = state
            .canvas_surface
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WebGPU canvas surface was not initialized"))?;
        if surface.config.width != w || surface.config.height != h {
            surface.resize(w, h);
        }

        surface
            .ensure_current_surface_texture()
            .map_err(|e| JsValue::from_str(&format!("WebGPU surface texture: {e:?}")))?;
        let texture_view = surface
            .target_texture_view()
            .map_err(|e| JsValue::from_str(&format!("WebGPU surface texture view: {e:?}")))?;

        state
            .renderer
            .render_to_texture(
                surface.device(),
                surface.queue(),
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

        drop(texture_view);
        surface
            .maybe_blit_and_present()
            .map_err(|e| JsValue::from_str(&format!("WebGPU present: {e:?}")))?;

        Ok(())
    }
}
