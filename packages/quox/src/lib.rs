mod dom;
mod interaction;
mod node_handles;
mod render;

use blitz_dom::{BaseDocument, DEFAULT_CSS, DocumentConfig, FontContext};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use interaction::RecordedEvents;
use linebender_resource_handle::Blob;
use node_handles::NodeHandles;
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
    /// Browser-style logical viewport dimensions used for input bounds.
    width: u32,
    height: u32,
    /// Exact physical target dimensions supplied by the window backend.
    framebuffer_width: u32,
    framebuffer_height: u32,
    device_pixel_ratio: f32,
    context: WGPUContext,
    dev_id: usize,
    renderer: Renderer,
    redraw_requested: Arc<AtomicBool>,
    ime_requests: Arc<ImeRequestMailbox>,
    recorded_events: RecordedEvents,
    /// Stable public handles for Blitz's internally reusable slab node ids.
    node_handles: NodeHandles,
}

const IME_REQUEST_CURSOR_AREA: u8 = 1 << 0;
const IME_REQUEST_ENABLED: u8 = 1 << 1;
const IME_REQUEST_CONTEXT_RESTART: u8 = 1 << 2;
const IME_REQUEST_SNAPSHOT_LEN: usize = 6;

#[derive(Default)]
struct ImeRequestState {
    desired_enabled: Option<bool>,
    delivered_enabled: Option<bool>,
    desired_cursor_area: Option<[f32; 4]>,
    delivered_cursor_area: Option<[f32; 4]>,
    context_restart_pending: bool,
}

/// Thread-safe hand-off for shell requests produced synchronously inside Blitz. The host
/// drains these requests after dispatching an event or resolving layout and applies them to
/// the native window/IME context.
#[derive(Default)]
struct ImeRequestMailbox {
    state: Mutex<ImeRequestState>,
}

impl ImeRequestMailbox {
    fn request_enabled(&self, enabled: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if enabled {
            // Blitz identifies a new logical editor by disabling the old editor before enabling
            // the new one. Preserve that edge even when both requests arrive before the host can
            // drain the mailbox and the final boolean is unchanged.
            if state.desired_enabled == Some(false) && state.delivered_enabled == Some(true) {
                state.context_restart_pending = true;
            }
        } else {
            state.context_restart_pending = false;
        }
        state.desired_enabled = Some(enabled);
    }

    fn request_cursor_area(&self, mut cursor_area: [f32; 4]) {
        if !cursor_area.iter().all(|value| value.is_finite()) {
            return;
        }
        cursor_area[2] = cursor_area[2].max(0.0);
        cursor_area[3] = cursor_area[3].max(0.0);
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .desired_cursor_area = Some(cursor_area);
    }

    /// Atomically drain the changed parts of the desired native IME state.
    ///
    /// The compact WASM-friendly snapshot is `[flags, x, y, width, height, enabled]`.
    /// Cursor geometry and enabled state have independent presence bits, allowing the host to
    /// apply geometry before an accompanying enable without racing two mailbox drains. A restart
    /// bit preserves a coalesced disable/enable handoff while the final enabled value stays true.
    fn take_snapshot(&self) -> Option<[f32; IME_REQUEST_SNAPSHOT_LEN]> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cursor_area_changed = state.desired_cursor_area != state.delivered_cursor_area;
        let enabled_changed = state.desired_enabled != state.delivered_enabled;
        let context_restart = state.context_restart_pending
            && state.desired_enabled == Some(true)
            && state.delivered_enabled == Some(true);
        if !cursor_area_changed && !enabled_changed && !context_restart {
            return None;
        }

        let mut flags = 0;
        let mut snapshot = [0.0; IME_REQUEST_SNAPSHOT_LEN];
        if cursor_area_changed {
            flags |= IME_REQUEST_CURSOR_AREA;
            if let Some(area) = state.desired_cursor_area {
                snapshot[1..5].copy_from_slice(&area);
            }
            state.delivered_cursor_area = state.desired_cursor_area;
        }
        if enabled_changed {
            flags |= IME_REQUEST_ENABLED;
            snapshot[5] = if state.desired_enabled.unwrap_or(false) {
                1.0
            } else {
                0.0
            };
            state.delivered_enabled = state.desired_enabled;
        }
        if context_restart {
            flags |= IME_REQUEST_CONTEXT_RESTART;
            snapshot[5] = 1.0;
        }
        state.context_restart_pending = false;
        snapshot[0] = f32::from(flags);
        Some(snapshot)
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

/// Compute the focused text editor's current composition/caret area in logical viewport units.
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
    let x = (((f64::from(content_x) - scroll.x) * scale + ime_area.x0) / scale) as f32;
    let y = (((f64::from(content_y) - scroll.y) * scale + ime_area.y0) / scale) as f32;
    let width = (ime_area.width() / scale) as f32;
    let height = (ime_area.height() / scale) as f32;

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
            self.framebuffer_width,
            self.framebuffer_height,
            self.device_pixel_ratio,
            ColorScheme::Light,
        ));
        self.document.resolve(0.0);
        self.refresh_ime_cursor_area();
    }

    /// Publish the focused Parley editor's composition/caret area in logical viewport units.
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
                framebuffer_width: width.max(1),
                framebuffer_height: height.max(1),
                device_pixel_ratio: 1.0,
                context,
                dev_id,
                renderer,
                redraw_requested,
                ime_requests,
                recorded_events: RecordedEvents::default(),
                node_handles: NodeHandles::default(),
            }),
        })
    }

    /// Resize the logical viewport and its physical rendering target independently.
    pub fn resize(
        &self,
        width: u32,
        height: u32,
        framebuffer_width: u32,
        framebuffer_height: u32,
        device_pixel_ratio: f32,
    ) {
        let mut state = self.state.borrow_mut();
        state.width = width.max(1);
        state.height = height.max(1);
        state.framebuffer_width = framebuffer_width.max(1);
        state.framebuffer_height = framebuffer_height.max(1);
        state.device_pixel_ratio = if device_pixel_ratio.is_finite() && device_pixel_ratio > 0.0 {
            device_pixel_ratio
        } else {
            1.0
        };
    }

    /// Atomically drain changed native IME requests as
    /// `[flags, x, y, width, height, enabled]`.
    pub fn take_ime_requests(&self) -> Option<Box<[f32]>> {
        self.state
            .borrow()
            .ime_requests
            .take_snapshot()
            .map(Box::<[f32]>::from)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        IME_REQUEST_CONTEXT_RESTART, IME_REQUEST_CURSOR_AREA, IME_REQUEST_ENABLED,
        ImeRequestMailbox, focused_ime_cursor_area,
    };
    use blitz_dom::{DocumentConfig, Point};
    use blitz_html::HtmlDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};

    #[test]
    fn ime_request_mailbox_coalesces_and_atomically_drains_changed_values() {
        let mailbox = ImeRequestMailbox::default();

        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        mailbox.request_cursor_area([1.0, 2.0, 3.0, 4.0]);
        mailbox.request_cursor_area([5.0, 6.0, 7.0, 8.0]);

        assert_eq!(
            mailbox.take_snapshot(),
            Some([
                f32::from(IME_REQUEST_CURSOR_AREA | IME_REQUEST_ENABLED),
                5.0,
                6.0,
                7.0,
                8.0,
                0.0,
            ])
        );
        assert_eq!(mailbox.take_snapshot(), None);

        // Repeating the delivered values is a no-op even after the previous snapshot drained.
        mailbox.request_enabled(false);
        mailbox.request_cursor_area([5.0, 6.0, 7.0, 8.0]);
        assert_eq!(mailbox.take_snapshot(), None);

        mailbox.request_enabled(true);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([f32::from(IME_REQUEST_ENABLED), 0.0, 0.0, 0.0, 0.0, 1.0])
        );

        mailbox.request_cursor_area([f32::NAN, 1.0, 2.0, 3.0]);
        assert_eq!(mailbox.take_snapshot(), None);
        mailbox.request_cursor_area([5.0, 6.0, -7.0, -8.0]);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([f32::from(IME_REQUEST_CURSOR_AREA), 5.0, 6.0, 0.0, 0.0, 0.0])
        );
    }

    #[test]
    fn ime_request_mailbox_preserves_same_surface_editor_restarts() {
        let mailbox = ImeRequestMailbox::default();

        mailbox.request_enabled(true);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([f32::from(IME_REQUEST_ENABLED), 0.0, 0.0, 0.0, 0.0, 1.0])
        );

        // A blur/focus handoff can happen synchronously inside one Blitz event dispatch. The
        // final boolean remains true, but the host still needs to restart the native context.
        mailbox.request_enabled(false);
        mailbox.request_cursor_area([10.0, 20.0, 3.0, 4.0]);
        mailbox.request_enabled(true);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([
                f32::from(IME_REQUEST_CURSOR_AREA | IME_REQUEST_CONTEXT_RESTART),
                10.0,
                20.0,
                3.0,
                4.0,
                1.0,
            ])
        );
        assert_eq!(mailbox.take_snapshot(), None);

        // Multiple handoffs before a drain only need one restart for the final editor.
        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([
                f32::from(IME_REQUEST_CONTEXT_RESTART),
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ])
        );

        // If the final editor is disabled, the ordinary disable supersedes a pending restart.
        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        assert_eq!(
            mailbox.take_snapshot(),
            Some([f32::from(IME_REQUEST_ENABLED), 0.0, 0.0, 0.0, 0.0, 0.0])
        );
        assert_eq!(mailbox.take_snapshot(), None);
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

        document.set_viewport(Viewport::new(1600, 1200, 2.0, ColorScheme::Light));
        document.resolve(0.0);
        let hidpi_area =
            focused_ime_cursor_area(&mut document).expect("input should have a HiDPI area");
        for (logical, hidpi) in area_before.into_iter().zip(hidpi_area) {
            assert!((logical - hidpi).abs() < 0.001);
        }

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
