mod dom;
mod interaction;
mod render;

use blitz_dom::{BaseDocument, DEFAULT_CSS, DocumentConfig, FontContext};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use interaction::RecordedEvents;
use linebender_resource_handle::Blob;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use vello::{AaSupport, Renderer, RendererOptions};
use wasm_bindgen::prelude::*;
use wgpu_context::{SurfaceRenderer, WGPUContext};

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");
const FONT_CSS: &str = "html,body,*{font-family:'Liberation Sans',sans-serif;}";

fn initial_html(head: &str, body: &str) -> String {
    format!("<!DOCTYPE html><html><head>{head}</head><body>{body}</body></html>")
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Renders HTML documents directly to native WebGPU surfaces using Blitz + Vello.
#[wasm_bindgen]
pub struct QuoxRenderer {
    state: RefCell<QuoxRendererState>,
}

struct QuoxRendererState {
    document: BaseDocument,
    width: u32,
    height: u32,
    context: WGPUContext,
    renderer: Renderer,
    canvas_surface: Option<SurfaceRenderer<'static>>,
    redraw_requested: Arc<AtomicBool>,
    recorded_events: RecordedEvents,
}

/// Notices Blitz-internal redraw requests (hover/active/focus/scroll/text-input state
/// changes) that `DummyShellProvider` would otherwise silently drop. Cursor-shape changes
/// are deferred, so `set_cursor` stays at the trait's no-op default.
struct QuoxShellProvider {
    redraw_requested: Arc<AtomicBool>,
}

impl ShellProvider for QuoxShellProvider {
    fn request_redraw(&self) {
        self.redraw_requested.store(true, Ordering::Relaxed);
    }
}

impl QuoxRendererState {
    /// Resolve layout for the current viewport state. Shared by rendering and
    /// `node_from_point()` so hit-testing never sees stale geometry — mirrors how browsers
    /// force a layout flush before geometry queries like `elementFromPoint`. Blitz's own
    /// `set_viewport` already re-clamps scroll on every call, so scroll position is owned
    /// entirely by `BaseDocument` (via `viewport_scroll()`/`scroll_by`) — quox keeps no
    /// mirror of it, which would otherwise clobber Blitz's own wheel-driven scroll updates.
    fn sync_layout(&mut self) {
        self.document.set_viewport(Viewport::new(
            self.width,
            self.height,
            1.0,
            ColorScheme::Light,
        ));
        self.document.resolve(0.0);
    }
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Initialise a renderer with a live document and viewport dimensions.
    ///
    /// Acquires a WebGPU device; must be `await`ed.
    pub async fn create(
        width: u32,
        height: u32,
        head: &str,
        body: &str,
    ) -> Result<QuoxRenderer, JsValue> {
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

        let redraw_requested = Arc::new(AtomicBool::new(false));

        let document = HtmlDocument::from_html(
            &initial_html(head, body),
            DocumentConfig {
                base_url: Some("https://example.com".to_string()),
                net_provider: Some(Arc::new(DummyNetProvider)),
                shell_provider: Some(Arc::new(QuoxShellProvider {
                    redraw_requested: Arc::clone(&redraw_requested),
                })),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ua_stylesheets: Some(vec![DEFAULT_CSS.to_string(), FONT_CSS.to_string()]),
                font_ctx: Some(font_ctx),
                ..Default::default()
            },
        )
        .into_inner();

        Ok(QuoxRenderer {
            state: RefCell::new(QuoxRendererState {
                document,
                width: width.max(1),
                height: height.max(1),
                context,
                renderer,
                canvas_surface: None,
                redraw_requested,
                recorded_events: RecordedEvents::default(),
            }),
        })
    }

    /// Resize the rendering viewport.
    pub fn resize(&self, width: u32, height: u32) {
        let mut state = self.state.borrow_mut();
        state.width = width.max(1);
        state.height = height.max(1);
    }
}
