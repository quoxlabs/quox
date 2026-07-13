mod dom;
mod ffi_numbers;
mod form_controls;
mod interaction;
mod node_handles;
mod render;

use blitz_dom::{BaseDocument, DEFAULT_CSS, DocumentConfig, FontContext};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use ffi_numbers::{NumericArgumentError, positive_f32, uint32};
use form_controls::{CheckedControlStates, TextControlStates};
use interaction::staged_dispatch::DispatchStack;
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
    /// Resumable DOM dispatches paused while JavaScript invokes event listeners.
    dispatch_stack: DispatchStack,
    /// Stable public handles for Blitz's internally reusable slab node ids.
    node_handles: NodeHandles,
    /// Browser-facing live value/dirty state for value-mode form controls.
    text_controls: TextControlStates,
    /// Browser-facing checkedness, dirty state, and indeterminateness for every HTML input.
    checked_controls: CheckedControlStates,
}

const IME_REQUEST_CURSOR_AREA: u8 = 1 << 0;
const IME_REQUEST_ENABLED: u8 = 1 << 1;
const IME_REQUEST_CONTEXT_RESTART: u8 = 1 << 2;
const IME_REQUEST_SNAPSHOT_LEN: usize = 7;

struct ImeRequestState {
    desired_enabled: Option<bool>,
    acknowledged_enabled: Option<bool>,
    desired_cursor_area: Option<[f32; 4]>,
    acknowledged_cursor_area: Option<[f32; 4]>,
    desired_restart_generation: u64,
    acknowledged_restart_generation: u64,
    in_flight: Option<ImeRequestSnapshot>,
    next_snapshot_revision: Option<u32>,
}

impl Default for ImeRequestState {
    fn default() -> Self {
        Self {
            desired_enabled: None,
            acknowledged_enabled: None,
            desired_cursor_area: None,
            acknowledged_cursor_area: None,
            desired_restart_generation: 0,
            acknowledged_restart_generation: 0,
            in_flight: None,
            next_snapshot_revision: Some(1),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ImeRequestSnapshot {
    revision: u32,
    flags: u8,
    cursor_area: Option<[f32; 4]>,
    enabled: Option<bool>,
    restart_generation: u64,
}

impl ImeRequestSnapshot {
    fn wire_values(&self) -> [f64; IME_REQUEST_SNAPSHOT_LEN] {
        let mut values = [0.0; IME_REQUEST_SNAPSHOT_LEN];
        values[0] = f64::from(self.revision);
        values[1] = f64::from(self.flags);
        if let Some(area) = self.cursor_area {
            for (destination, source) in values[2..6].iter_mut().zip(area) {
                *destination = f64::from(source);
            }
        }
        values[6] = self.enabled.map_or(0.0, f64::from);
        values
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ImeRequestMailboxError {
    RevisionExhausted,
    NothingToAcknowledge,
    RevisionMismatch { expected: u32, actual: u32 },
}

impl std::fmt::Display for ImeRequestMailboxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RevisionExhausted => {
                formatter.write_str("quox: IME request revision space exhausted")
            }
            Self::NothingToAcknowledge => {
                formatter.write_str("quox: no IME request is awaiting acknowledgment")
            }
            Self::RevisionMismatch { expected, actual } => write!(
                formatter,
                "quox: IME request acknowledgment revision {actual} does not match {expected}"
            ),
        }
    }
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
        if state.desired_enabled == Some(enabled) {
            return;
        }
        if enabled && state.desired_enabled == Some(false) {
            // Every disable/enable edge identifies a new logical editor. Multiple edges before
            // one peek coalesce, while the generation prevents an edge arriving during an
            // in-flight native transaction from being cleared by that transaction's ack.
            state.desired_restart_generation = state
                .desired_restart_generation
                .checked_add(1)
                .expect("IME restart generation exhausted");
        }
        state.desired_enabled = Some(enabled);
    }

    fn request_restart(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.desired_restart_generation = state
            .desired_restart_generation
            .checked_add(1)
            .expect("IME restart generation exhausted");
        state.desired_enabled = Some(true);
    }

    fn request_cursor_area(&self, mut cursor_area: [f32; 4]) {
        if !cursor_area.iter().all(|value| value.is_finite()) {
            return;
        }
        cursor_area[2] = cursor_area[2].max(0.0);
        cursor_area[3] = cursor_area[3].max(0.0);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.desired_cursor_area != Some(cursor_area) {
            state.desired_cursor_area = Some(cursor_area);
        }
    }

    /// Peek one immutable native transaction without acknowledging it. Repeated peeks return the
    /// same revision until the host confirms every operation succeeded.
    fn peek_snapshot(
        &self,
    ) -> Result<Option<[f64; IME_REQUEST_SNAPSHOT_LEN]>, ImeRequestMailboxError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(snapshot) = &state.in_flight {
            return Ok(Some(snapshot.wire_values()));
        }

        // When native state is already disabled, any accumulated logical-editor restart edge is
        // satisfied without another disable/enable cycle.
        if state.acknowledged_enabled == Some(false) && state.desired_enabled == Some(false) {
            state.acknowledged_restart_generation = state.desired_restart_generation;
        }

        let cursor_area_changed = state.desired_cursor_area != state.acknowledged_cursor_area;
        let enabled_changed = state.desired_enabled != state.acknowledged_enabled;
        let restart_pending =
            state.desired_restart_generation > state.acknowledged_restart_generation;
        let context_restart = restart_pending
            && state.desired_enabled == Some(true)
            && state.acknowledged_enabled == Some(true);
        if !cursor_area_changed && !enabled_changed && !context_restart {
            return Ok(None);
        }

        let mut flags = 0;
        if cursor_area_changed {
            flags |= IME_REQUEST_CURSOR_AREA;
        }
        if enabled_changed {
            flags |= IME_REQUEST_ENABLED;
        }
        if context_restart {
            flags |= IME_REQUEST_CONTEXT_RESTART;
        }

        let revision = state
            .next_snapshot_revision
            .ok_or(ImeRequestMailboxError::RevisionExhausted)?;
        state.next_snapshot_revision = revision.checked_add(1);
        let snapshot = ImeRequestSnapshot {
            revision,
            flags,
            cursor_area: cursor_area_changed
                .then_some(state.desired_cursor_area)
                .flatten(),
            enabled: (enabled_changed || context_restart)
                .then_some(state.desired_enabled)
                .flatten(),
            restart_generation: state.desired_restart_generation,
        };
        let wire_values = snapshot.wire_values();
        state.in_flight = Some(snapshot);
        Ok(Some(wire_values))
    }

    /// Acknowledge only the currently peeked revision after all native setters succeeded.
    fn acknowledge_snapshot(&self, revision: u32) -> Result<(), ImeRequestMailboxError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let snapshot = state
            .in_flight
            .as_ref()
            .ok_or(ImeRequestMailboxError::NothingToAcknowledge)?;
        if snapshot.revision != revision {
            return Err(ImeRequestMailboxError::RevisionMismatch {
                expected: snapshot.revision,
                actual: revision,
            });
        }
        let snapshot = state
            .in_flight
            .take()
            .expect("the checked in-flight snapshot remains present");

        if snapshot.flags & IME_REQUEST_CURSOR_AREA != 0 {
            state.acknowledged_cursor_area = snapshot.cursor_area;
        }
        if let Some(enabled) = snapshot.enabled {
            state.acknowledged_enabled = Some(enabled);
            if enabled {
                state.acknowledged_restart_generation = state
                    .acknowledged_restart_generation
                    .max(snapshot.restart_generation);
            } else {
                // A successfully applied disable satisfies even restart edges requested while
                // this transaction was in flight; the following enable can be ordinary.
                state.acknowledged_restart_generation = state.desired_restart_generation;
            }
        }
        Ok(())
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
    /// Resolve layout for the current viewport state. Shared by `render()`, `node_from_point()`,
    /// and every trusted pointer/wheel occurrence so hit tests and input defaults never see
    /// arbitrarily stale geometry. Rendering follows layout with a stationary-pointer refresh,
    /// so layout-only target changes stage their boundary events before paint. Blitz's own
    /// `set_viewport` already re-clamps scroll on every call, so scroll position is owned entirely by `BaseDocument`
    /// (via `viewport_scroll()`/`scroll_by`) — quox keeps no mirror of it, which would otherwise
    /// clobber Blitz's own wheel-driven scroll updates.
    fn sync_layout(&mut self) {
        self.reconcile_form_controls();
        sync_document_layout(
            &mut self.document,
            self.framebuffer_width,
            self.framebuffer_height,
            self.device_pixel_ratio,
        );
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

/// Flush pending DOM/style changes into the geometry shared by painting and trusted hit tests.
/// Keeping this operation independent of the renderer makes the input-layout contract directly
/// testable without constructing a GPU device.
fn sync_document_layout(
    document: &mut BaseDocument,
    framebuffer_width: u32,
    framebuffer_height: u32,
    device_pixel_ratio: f32,
) {
    document.set_viewport(Viewport::new(
        framebuffer_width,
        framebuffer_height,
        device_pixel_ratio,
        ColorScheme::Light,
    ));
    document.resolve(0.0);
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Initialise a renderer with a live document and viewport dimensions.
    ///
    /// Acquires a WebGPU device; must be `await`ed.
    pub async fn create(
        width: f64,
        height: f64,
        head: &str,
        body: &str,
    ) -> Result<QuoxRenderer, JsValue> {
        let width = uint32(width, "width").map_err(NumericArgumentError::into_js)?;
        let height = uint32(height, "height").map_err(NumericArgumentError::into_js)?;
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

        let mut document = HtmlDocument::from_html(
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
        let mut text_controls = TextControlStates::default();
        text_controls.reconcile_document(&mut document);
        let mut checked_controls = CheckedControlStates::default();
        checked_controls.reconcile_document(&mut document);

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
                dispatch_stack: DispatchStack::default(),
                node_handles: NodeHandles::default(),
                text_controls,
                checked_controls,
            }),
        })
    }

    /// Resize the logical viewport and its physical rendering target independently.
    pub fn resize(
        &self,
        width: f64,
        height: f64,
        framebuffer_width: f64,
        framebuffer_height: f64,
        device_pixel_ratio: f64,
    ) -> Result<(), JsValue> {
        let width = uint32(width, "width").map_err(NumericArgumentError::into_js)?;
        let height = uint32(height, "height").map_err(NumericArgumentError::into_js)?;
        let framebuffer_width =
            uint32(framebuffer_width, "framebufferWidth").map_err(NumericArgumentError::into_js)?;
        let framebuffer_height = uint32(framebuffer_height, "framebufferHeight")
            .map_err(NumericArgumentError::into_js)?;
        let device_pixel_ratio = positive_f32(device_pixel_ratio, "devicePixelRatio")
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        state.width = width.max(1);
        state.height = height.max(1);
        state.framebuffer_width = framebuffer_width.max(1);
        state.framebuffer_height = framebuffer_height.max(1);
        state.device_pixel_ratio = device_pixel_ratio;
        Ok(())
    }

    /// Peek the current native IME transaction as
    /// `[revision, flags, x, y, width, height, enabled]` without acknowledging it.
    pub fn peek_ime_requests(&self) -> Result<Option<Box<[f64]>>, JsValue> {
        self.state
            .borrow()
            .ime_requests
            .peek_snapshot()
            .map(|snapshot| snapshot.map(Box::<[f64]>::from))
            .map_err(|error| js_sys::Error::new(&error.to_string()).into())
    }

    /// Confirm that every native operation in the peeked IME transaction succeeded.
    pub fn ack_ime_requests(&self, revision: f64) -> Result<(), JsValue> {
        let revision = uint32(revision, "revision").map_err(NumericArgumentError::into_js)?;
        if revision == 0 {
            return Err(NumericArgumentError::new(
                "revision",
                "be a positive unsigned 32-bit integer",
            )
            .into_js());
        }
        self.state
            .borrow()
            .ime_requests
            .acknowledge_snapshot(revision)
            .map_err(|error| js_sys::Error::new(&error.to_string()).into())
    }
}

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "IME wire snapshots contain exactly representable u32 revisions and f32-derived values"
)]
mod tests {
    use super::{
        IME_REQUEST_CONTEXT_RESTART, IME_REQUEST_CURSOR_AREA, IME_REQUEST_ENABLED,
        ImeRequestMailbox, focused_ime_cursor_area,
    };
    use blitz_dom::{DocumentConfig, Point};
    use blitz_html::HtmlDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};

    fn peek(mailbox: &ImeRequestMailbox) -> [f64; 7] {
        mailbox
            .peek_snapshot()
            .expect("peek should succeed")
            .expect("a snapshot should be pending")
    }

    fn acknowledge(mailbox: &ImeRequestMailbox, snapshot: [f64; 7]) {
        mailbox
            .acknowledge_snapshot(snapshot[0] as u32)
            .expect("acknowledgment should succeed");
    }

    #[test]
    fn ime_request_peek_retries_until_the_matching_revision_is_acknowledged() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        mailbox.request_cursor_area([1.0, 2.0, 3.0, 4.0]);

        let snapshot = peek(&mailbox);
        assert_eq!(snapshot, [1.0, 3.0, 1.0, 2.0, 3.0, 4.0, 1.0]);
        assert_eq!(peek(&mailbox), snapshot);
        assert!(mailbox.acknowledge_snapshot(2).is_err());
        assert_eq!(peek(&mailbox), snapshot);

        acknowledge(&mailbox, snapshot);
        assert_eq!(mailbox.peek_snapshot(), Ok(None));
    }

    #[test]
    fn requests_arriving_before_ack_survive_as_a_new_revision() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        mailbox.request_cursor_area([1.0, 2.0, 3.0, 4.0]);
        let first = peek(&mailbox);

        mailbox.request_enabled(false);
        mailbox.request_cursor_area([5.0, 6.0, 7.0, 8.0]);
        assert_eq!(peek(&mailbox), first);
        acknowledge(&mailbox, first);

        let second = peek(&mailbox);
        assert_eq!(second, [2.0, 3.0, 5.0, 6.0, 7.0, 8.0, 0.0]);
        acknowledge(&mailbox, second);
        assert_eq!(mailbox.peek_snapshot(), Ok(None));
    }

    #[test]
    fn editor_handoffs_coalesce_but_newer_generations_survive_ack() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        let initial = peek(&mailbox);
        acknowledge(&mailbox, initial);

        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        let first_restart = peek(&mailbox);
        assert_eq!(first_restart[1], f64::from(IME_REQUEST_CONTEXT_RESTART));

        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        acknowledge(&mailbox, first_restart);
        let second_restart = peek(&mailbox);
        assert_eq!(second_restart[1], f64::from(IME_REQUEST_CONTEXT_RESTART));
        assert_ne!(second_restart[0], first_restart[0]);
        acknowledge(&mailbox, second_restart);
        assert_eq!(mailbox.peek_snapshot(), Ok(None));
    }

    #[test]
    fn explicit_editor_restart_keeps_the_context_enabled() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        let initial = peek(&mailbox);
        acknowledge(&mailbox, initial);

        mailbox.request_restart();
        let restart = peek(&mailbox);
        assert_eq!(restart[1], f64::from(IME_REQUEST_CONTEXT_RESTART));
        assert_eq!(restart[6], 1.0);
    }

    #[test]
    fn acknowledged_disable_satisfies_a_newer_restart_edge() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        let initial = peek(&mailbox);
        acknowledge(&mailbox, initial);

        mailbox.request_enabled(false);
        let disable = peek(&mailbox);
        mailbox.request_enabled(true);
        acknowledge(&mailbox, disable);

        let enable = peek(&mailbox);
        assert_eq!(enable[1], f64::from(IME_REQUEST_ENABLED));
        assert_eq!(enable[6], 1.0);
        acknowledge(&mailbox, enable);
        assert_eq!(mailbox.peek_snapshot(), Ok(None));
    }

    #[test]
    fn final_disabled_state_supersedes_restart_and_cursor_values_are_sanitized() {
        let mailbox = ImeRequestMailbox::default();
        mailbox.request_enabled(true);
        let initial = peek(&mailbox);
        acknowledge(&mailbox, initial);

        mailbox.request_enabled(false);
        mailbox.request_enabled(true);
        mailbox.request_enabled(false);
        mailbox.request_cursor_area([f32::NAN, 1.0, 2.0, 3.0]);
        mailbox.request_cursor_area([5.0, 6.0, -7.0, -8.0]);
        let snapshot = peek(&mailbox);
        assert_eq!(
            snapshot,
            [
                2.0,
                f64::from(IME_REQUEST_CURSOR_AREA | IME_REQUEST_ENABLED),
                5.0,
                6.0,
                0.0,
                0.0,
                0.0,
            ]
        );
        acknowledge(&mailbox, snapshot);
        assert_eq!(mailbox.peek_snapshot(), Ok(None));
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
