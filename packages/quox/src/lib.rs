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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use vello::{AaSupport, Renderer, RendererOptions};
use wasm_bindgen::prelude::*;
use wgpu_context::WGPUContext;

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");
const FONT_CSS: &str = "html,body,*{font-family:'Liberation Sans',sans-serif;}";

fn initial_html(head: &str, body: &str) -> String {
    format!("<!DOCTYPE html><html><head>{head}</head><body>{body}</body></html>")
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
    state: RefCell<QuoxRendererState>,
}

struct QuoxRendererState {
    document: BaseDocument,
    width: u32,
    height: u32,
    context: WGPUContext,
    dev_id: usize,
    renderer: Renderer,
    redraw_requested: Arc<AtomicBool>,
    ime_requests: Arc<ImeRequestMailbox>,
    recorded_events: RecordedEvents,
}

#[derive(Default)]
struct PendingImeRequests {
    enabled: Option<bool>,
    cursor_area: Option<[f32; 4]>,
}

/// Thread-safe hand-off for shell requests produced synchronously inside Blitz. The host
/// drains these requests after dispatching an event or resolving layout and applies them to
/// the native window/IME context.
#[derive(Default)]
struct ImeRequestMailbox {
    pending: Mutex<PendingImeRequests>,
}

impl ImeRequestMailbox {
    fn request_enabled(&self, enabled: bool) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .enabled = Some(enabled);
    }

    fn request_cursor_area(&self, cursor_area: [f32; 4]) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cursor_area = Some(cursor_area);
    }

    fn take_enabled(&self) -> Option<bool> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .enabled
            .take()
    }

    fn take_cursor_area(&self) -> Option<[f32; 4]> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cursor_area
            .take()
    }
}

/// Notices Blitz-internal redraw requests (hover/active/focus/scroll/text-input state
/// changes) that `DummyShellProvider` would otherwise silently drop. Cursor-shape changes
/// are deferred, so `set_cursor` stays at the trait's no-op default.
struct QuoxShellProvider {
    redraw_requested: Arc<AtomicBool>,
    ime_requests: Arc<ImeRequestMailbox>,
}

impl ShellProvider for QuoxShellProvider {
    fn request_redraw(&self) {
        self.redraw_requested.store(true, Ordering::Relaxed);
    }

    fn set_ime_enabled(&self, is_enabled: bool) {
        self.ime_requests.request_enabled(is_enabled);
    }

    fn set_ime_cursor_area(&self, x: f32, y: f32, width: f32, height: f32) {
        self.ime_requests.request_cursor_area([x, y, width, height]);
    }
}

/// Compute the focused text editor's current composition/caret area in viewport pixels.
#[allow(
    clippy::cast_possible_truncation,
    reason = "Blitz's shell API uses f32 window coordinates while Parley geometry uses f64"
)]
fn focused_ime_cursor_area(document: &mut BaseDocument) -> Option<[f32; 4]> {
    let node_id = document.get_focussed_node_id()?;

    let mut ime_area = None;
    document.with_text_input(node_id, |mut driver| {
        driver.refresh_layout();
        ime_area = Some(driver.editor.ime_cursor_area());
    });
    let ime_area = ime_area?;

    let scale = document.viewport().scale_f64();
    let scroll = document.viewport_scroll();
    let node = document.get_node(node_id)?;

    let node_position = node.absolute_position(0.0, 0.0);
    let content_x =
        node_position.x + node.final_layout.border.left + node.final_layout.padding.left;
    let content_y = node_position.y
        + node.final_layout.border.top
        + node.final_layout.padding.top
        + node.text_input_v_centering_offset(scale) as f32;
    let x = ((f64::from(content_x) - scroll.x) * scale + ime_area.x0) as f32;
    let y = ((f64::from(content_y) - scroll.y) * scale + ime_area.y0) as f32;
    let width = ime_area.width() as f32;
    let height = ime_area.height() as f32;

    Some([x, y, width, height])
}

impl QuoxRendererState {
    /// Resolve layout for the current viewport state. Shared by `render()` and
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
        self.refresh_ime_cursor_area();
    }

    /// Publish the focused Parley editor's current composition/caret area in viewport pixels.
    /// Blitz currently publishes the entire input content box only when focus changes; querying
    /// Parley here keeps candidate-window placement current as the caret, preedit, scroll, or
    /// layout changes.
    fn refresh_ime_cursor_area(&mut self) {
        if let Some(cursor_area) = focused_ime_cursor_area(&mut self.document) {
            self.ime_requests.request_cursor_area(cursor_area);
        }
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
        let ime_requests = Arc::new(ImeRequestMailbox::default());

        let document = HtmlDocument::from_html(
            &initial_html(head, body),
            DocumentConfig {
                base_url: Some("https://example.com".to_string()),
                net_provider: Some(Arc::new(DummyNetProvider)),
                shell_provider: Some(Arc::new(QuoxShellProvider {
                    redraw_requested: Arc::clone(&redraw_requested),
                    ime_requests: Arc::clone(&ime_requests),
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
                dev_id,
                renderer,
                redraw_requested,
                ime_requests,
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

    /// Drain the latest request to enable or disable native IME handling, if Blitz issued one.
    pub fn take_ime_enabled(&self) -> Option<bool> {
        self.state.borrow().ime_requests.take_enabled()
    }

    /// Drain the latest native IME candidate-window area as `[x, y, width, height]` in viewport
    /// pixels, if Blitz or the focused Parley editor issued one.
    pub fn take_ime_cursor_area(&self) -> Option<Box<[f32]>> {
        self.state
            .borrow()
            .ime_requests
            .take_cursor_area()
            .map(Box::<[f32]>::from)
    }
}

#[cfg(test)]
mod tests {
    use super::{ImeRequestMailbox, focused_ime_cursor_area};
    use blitz_dom::{DocumentConfig, Point};
    use blitz_html::HtmlDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};

    #[test]
    fn ime_request_mailbox_keeps_latest_values_and_drains_them() {
        let mailbox = ImeRequestMailbox::default();

        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        mailbox.request_cursor_area([1.0, 2.0, 3.0, 4.0]);
        mailbox.request_cursor_area([5.0, 6.0, 7.0, 8.0]);

        assert_eq!(mailbox.take_enabled(), Some(false));
        assert_eq!(mailbox.take_enabled(), None);
        assert_eq!(mailbox.take_cursor_area(), Some([5.0, 6.0, 7.0, 8.0]));
        assert_eq!(mailbox.take_cursor_area(), None);
    }

    #[test]
    fn focused_ime_area_subtracts_viewport_scroll_exactly_once() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><input style=\"display:block;margin-top:100px;padding:4px\" value=\"abc\"></body></html>",
            DocumentConfig {
                viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
                ..Default::default()
            },
        )
        .into_inner();
        document.resolve(0.0);

        let input_id = document
            .tree()
            .iter()
            .find_map(|(id, node)| {
                node.element_data()
                    .is_some_and(|element| element.name.local.as_ref() == "input")
                    .then_some(id)
            })
            .expect("test document should contain an input");
        assert!(document.set_focus_to(input_id));

        let absolute_before = document
            .get_node(input_id)
            .expect("input should exist")
            .absolute_position(0.0, 0.0);
        let area_before =
            focused_ime_cursor_area(&mut document).expect("input should have an area");

        document.set_viewport_scroll(Point { x: 0.0, y: 37.0 });

        let absolute_after = document
            .get_node(input_id)
            .expect("input should exist")
            .absolute_position(0.0, 0.0);
        let area_after = focused_ime_cursor_area(&mut document).expect("input should have an area");

        // `absolute_position` includes element/ancestor scrolling but Blitz stores document
        // viewport scrolling separately. Its own `get_client_bounding_rect` and painter subtract
        // `viewport_scroll` after computing the absolute position, which this helper mirrors.
        assert_eq!(absolute_after, absolute_before);
        assert!((area_after[0] - area_before[0]).abs() < 0.001);
        assert!((area_after[1] - (area_before[1] - 37.0)).abs() < 0.001);
        assert_eq!(&area_after[2..], &area_before[2..]);
    }
}
