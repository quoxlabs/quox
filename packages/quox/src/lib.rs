use anyrender_vello::VelloScenePainter;
use blitz_dom::{
    BaseDocument, DEFAULT_CSS, Document, DocumentConfig, DocumentMutator, EventDriver,
    EventHandler, FontContext, LocalName, NodeData, QualName, ns,
};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_paint::paint_scene;
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent, DomEvent,
    DomEventData, EventState, KeyState, MouseEventButton, MouseEventButtons, Point as ElementPoint,
    PointerCoords, PointerDetails, UiEvent,
};
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use keyboard_types::{Code, Key, Location, Modifiers};
use linebender_resource_handle::Blob;
use std::cell::RefCell;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use wgpu_context::WGPUContext;

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");
const FONT_CSS: &str = "html,body,*{font-family:'Liberation Sans',sans-serif;}";

fn initial_html(head: &str, body: &str) -> String {
    format!("<!DOCTYPE html><html><head>{head}</head><body>{body}</body></html>")
}

fn html_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from(local_name),
    }
}

fn attr_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(),
        local: LocalName::from(local_name),
    }
}

fn invalid_node(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("Invalid DOM node id: {node_id}"))
}

fn invalid_element(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("DOM node id is not an element: {node_id}"))
}

/// Convert viewport-pixel coordinates (the space `mousemove` events report) into Blitz's
/// page-space coordinates (viewport coordinates plus the current scroll offset), or
/// `None` if the point is non-finite or outside the viewport bounds.
#[allow(
    clippy::cast_possible_truncation,
    reason = "Blitz stores scroll offsets as f64 but its hit-testing and pointer-event APIs require f32"
)]
fn viewport_point_to_page(
    x: f32,
    y: f32,
    width: u32,
    height: u32,
    scroll_x: f64,
    scroll_y: f64,
) -> Option<(f32, f32)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    if x < 0.0 || y < 0.0 || f64::from(x) >= f64::from(width) || f64::from(y) >= f64::from(height) {
        return None;
    }

    // Blitz stores viewport scroll offsets as f64, while its hit-testing and pointer-event
    // APIs require f32 coordinates. Keep the calculation at the wider precision and narrow
    // only at that API boundary.
    Some((
        (f64::from(x) + scroll_x) as f32,
        (f64::from(y) + scroll_y) as f32,
    ))
}

/// Build a `keyboard_types::Modifiers` set from the individual flags `winding` reports.
#[allow(clippy::fn_params_excessive_bools)]
fn build_modifiers(shift: bool, ctrl: bool, alt: bool, meta: bool, caps_lock: bool) -> Modifiers {
    let mut mods = Modifiers::empty();
    if shift {
        mods |= Modifiers::SHIFT;
    }
    if ctrl {
        mods |= Modifiers::CONTROL;
    }
    if alt {
        mods |= Modifiers::ALT;
    }
    if meta {
        mods |= Modifiers::META;
    }
    if caps_lock {
        mods |= Modifiers::CAPS_LOCK;
    }
    mods
}

/// Best-effort US-QWERTY character for physical-position codes that don't have a named
/// `keyboard_types::Key` (letters, digits, punctuation, space). Digits/punctuation ignore
/// `caps_lock` (real keyboards do too); only Shift picks their shifted symbol.
fn us_qwerty_char(code: &str, shift: bool, caps_lock: bool) -> Option<char> {
    if let Some(letter) = code.strip_prefix("Key") {
        let base = letter.chars().next()?.to_ascii_lowercase();
        let uppercase = shift ^ caps_lock;
        return Some(if uppercase {
            base.to_ascii_uppercase()
        } else {
            base
        });
    }

    let (unshifted, shifted) = match code {
        "Digit0" => ('0', ')'),
        "Digit1" => ('1', '!'),
        "Digit2" => ('2', '@'),
        "Digit3" => ('3', '#'),
        "Digit4" => ('4', '$'),
        "Digit5" => ('5', '%'),
        "Digit6" => ('6', '^'),
        "Digit7" => ('7', '&'),
        "Digit8" => ('8', '*'),
        "Digit9" => ('9', '('),
        "Minus" => ('-', '_'),
        "Equal" => ('=', '+'),
        "BracketLeft" => ('[', '{'),
        "BracketRight" => (']', '}'),
        "Backslash" => ('\\', '|'),
        "Semicolon" => (';', ':'),
        "Quote" => ('\'', '"'),
        "Comma" => (',', '<'),
        "Period" => ('.', '>'),
        "Slash" => ('/', '?'),
        "Backquote" => ('`', '~'),
        "Space" => (' ', ' '),
        _ => return None,
    };
    Some(if shift { shifted } else { unshifted })
}

/// Derive the best `keyboard_types::Key` for a DOM physical `code` string plus modifier
/// state. Tries `code.parse::<Key>()` first, which directly yields the correct answer for
/// every control/named key (DOM `code` and `key` spellings coincide for those). Falls back
/// to an explicit match for the Left/Right modifier codes and `NumpadEnter` (which don't
/// parse that way), then a best-effort US-QWERTY table for printable physical-position
/// codes. Anything still unmapped (e.g. `NumpadN` without `NumLock` state) is `Unidentified`.
fn synthesize_key(code: &str, shift: bool, caps_lock: bool) -> Key {
    if let Ok(key) = Key::from_str(code) {
        return key;
    }

    match code {
        "ShiftLeft" | "ShiftRight" => return Key::Shift,
        "ControlLeft" | "ControlRight" => return Key::Control,
        "AltLeft" | "AltRight" => return Key::Alt,
        "MetaLeft" | "MetaRight" => return Key::Meta,
        "NumpadEnter" => return Key::Enter,
        _ => {}
    }

    if let Some(ch) = us_qwerty_char(code, shift, caps_lock) {
        return Key::Character(ch.to_string());
    }

    Key::Unidentified
}

/// Map a `winding` button index (`left:0, middle:1, right:2`, matching the ordinals
/// `MouseEventButton` itself already uses for `Main`/`Auxiliary`/`Secondary`) to the
/// corresponding `MouseEventButton`.
fn mouse_button(button: u8) -> MouseEventButton {
    match button {
        1 => MouseEventButton::Auxiliary,
        2 => MouseEventButton::Secondary,
        3 => MouseEventButton::Fourth,
        4 => MouseEventButton::Fifth,
        _ => MouseEventButton::Main,
    }
}

fn pointer_coords(x: f32, y: f32, page_x: f32, page_y: f32) -> PointerCoords {
    PointerCoords {
        page_x,
        page_y,
        // No multi-monitor concept for a single window — best-effort screen == client.
        screen_x: x,
        screen_y: y,
        client_x: x,
        client_y: y,
    }
}

/// Build a `BlitzPointerEvent` for a mouse pointer at viewport-pixel `(x, y)`, or `None` if
/// the coordinates are non-finite or outside the viewport (mirrors `node_from_point`'s
/// guard).
fn pointer_event(
    state: &QuoxRendererState,
    x: f32,
    y: f32,
    button: MouseEventButton,
    buttons: u8,
) -> Option<BlitzPointerEvent> {
    let scroll = state.document.viewport_scroll();
    let (page_x, page_y) =
        viewport_point_to_page(x, y, state.width, state.height, scroll.x, scroll.y)?;

    Some(BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: pointer_coords(x, y, page_x, page_y),
        button,
        buttons: MouseEventButtons::from_bits_truncate(buttons),
        mods: Modifiers::empty(),
        details: PointerDetails::default(),
        // Overwritten internally by Blitz (relative to the hit target's bounding rect)
        // before it's read anywhere, so the value passed in here is irrelevant.
        element: ElementPoint { x: 0.0, y: 0.0 },
    })
}

#[allow(clippy::too_many_arguments, clippy::fn_params_excessive_bools)]
fn key_event(
    code: &str,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    caps_lock: bool,
    state: KeyState,
) -> BlitzKeyEvent {
    BlitzKeyEvent {
        key: synthesize_key(code, shift_key, caps_lock),
        code: Code::from_str(code).unwrap_or(Code::Unidentified),
        modifiers: build_modifiers(shift_key, ctrl_key, alt_key, meta_key, caps_lock),
        location: Location::Standard,
        is_auto_repeating: false,
        is_composing: false,
        state,
        text: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{synthesize_key, viewport_point_to_page};
    use keyboard_types::Key;

    #[test]
    fn rejects_non_finite_coordinates() {
        assert_eq!(
            viewport_point_to_page(f32::NAN, 10.0, 800, 600, 0.0, 0.0),
            None
        );
        assert_eq!(
            viewport_point_to_page(10.0, f32::INFINITY, 800, 600, 0.0, 0.0),
            None
        );
    }

    #[test]
    fn rejects_out_of_viewport_coordinates() {
        assert_eq!(viewport_point_to_page(-1.0, 10.0, 800, 600, 0.0, 0.0), None);
        assert_eq!(viewport_point_to_page(10.0, -1.0, 800, 600, 0.0, 0.0), None);
        assert_eq!(
            viewport_point_to_page(800.0, 10.0, 800, 600, 0.0, 0.0),
            None
        );
        assert_eq!(
            viewport_point_to_page(10.0, 600.0, 800, 600, 0.0, 0.0),
            None
        );
    }

    #[test]
    fn preserves_large_viewport_boundary_precision() {
        assert_eq!(
            viewport_point_to_page(16_777_216.0, 0.0, 16_777_217, 1, 0.0, 0.0),
            Some((16_777_216.0, 0.0))
        );
    }

    #[test]
    fn passes_through_unscrolled_coordinates() {
        assert_eq!(
            viewport_point_to_page(10.0, 20.0, 800, 600, 0.0, 0.0),
            Some((10.0, 20.0))
        );
    }

    #[test]
    fn adds_scroll_offset_to_reach_page_coordinates() {
        assert_eq!(
            viewport_point_to_page(10.0, 20.0, 800, 600, 50.0, 100.0),
            Some((60.0, 120.0))
        );
    }

    #[test]
    fn synthesizes_named_keys_from_code() {
        assert_eq!(synthesize_key("Enter", false, false), Key::Enter);
        assert_eq!(synthesize_key("ArrowLeft", false, false), Key::ArrowLeft);
        assert_eq!(synthesize_key("Backspace", false, false), Key::Backspace);
        assert_eq!(synthesize_key("Tab", false, false), Key::Tab);
    }

    #[test]
    fn synthesizes_modifier_keys_from_left_right_codes() {
        assert_eq!(synthesize_key("ShiftLeft", false, false), Key::Shift);
        assert_eq!(synthesize_key("ShiftRight", false, false), Key::Shift);
        assert_eq!(synthesize_key("ControlLeft", false, false), Key::Control);
        assert_eq!(synthesize_key("AltRight", false, false), Key::Alt);
        assert_eq!(synthesize_key("MetaLeft", false, false), Key::Meta);
        assert_eq!(synthesize_key("NumpadEnter", false, false), Key::Enter);
    }

    #[test]
    fn synthesizes_letters_with_shift_and_caps_lock() {
        assert_eq!(
            synthesize_key("KeyA", false, false),
            Key::Character("a".into())
        );
        assert_eq!(
            synthesize_key("KeyA", true, false),
            Key::Character("A".into())
        );
        assert_eq!(
            synthesize_key("KeyA", false, true),
            Key::Character("A".into())
        );
        // Shift + CapsLock cancel out, matching a real keyboard.
        assert_eq!(
            synthesize_key("KeyA", true, true),
            Key::Character("a".into())
        );
    }

    #[test]
    fn synthesizes_digits_and_punctuation_ignoring_caps_lock() {
        assert_eq!(
            synthesize_key("Digit1", false, false),
            Key::Character("1".into())
        );
        assert_eq!(
            synthesize_key("Digit1", true, false),
            Key::Character("!".into())
        );
        assert_eq!(
            synthesize_key("Digit1", false, true),
            Key::Character("1".into())
        );
        assert_eq!(
            synthesize_key("Comma", true, false),
            Key::Character("<".into())
        );
    }

    #[test]
    fn falls_back_to_unidentified_for_unmapped_codes() {
        assert_eq!(synthesize_key("Numpad5", false, false), Key::Unidentified);
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
    recorded_events: RecordedEvents,
}

/// Records, per dispatched `DomEvent`, the target node id for the handful of event kinds a
/// host application cares about invoking a JS-registered handler for. Populated by
/// `RecordingEventHandler` and drained by `QuoxRenderer::take_*_node()`.
#[derive(Default)]
struct RecordedEvents {
    click: Option<usize>,
    double_click: Option<usize>,
    context_menu: Option<usize>,
    input: Option<usize>,
    focus: Option<usize>,
    blur: Option<usize>,
    scroll: Option<usize>,
}

/// Bridges Blitz's `EventHandler` hook (normally a no-op via `NoopEventHandler`) to a
/// `RecordedEvents` buffer, so the wasm boundary can tell the TS side which node/event kind
/// fired and let it invoke the matching JSX `onXxx` prop from `handlers.ts`'s registry.
struct RecordingEventHandler<'a> {
    recorded: &'a mut RecordedEvents,
}

impl EventHandler for RecordingEventHandler<'_> {
    fn handle_event(
        &mut self,
        chain: &[usize],
        event: &mut DomEvent,
        _doc: &mut dyn Document,
        _event_state: &mut EventState,
    ) {
        let Some(target) = chain.first().copied() else {
            return;
        };

        match &event.data {
            DomEventData::Click(_) => self.recorded.click = Some(target),
            DomEventData::DoubleClick(_) => self.recorded.double_click = Some(target),
            DomEventData::ContextMenu(_) => self.recorded.context_menu = Some(target),
            DomEventData::Input(_) => self.recorded.input = Some(target),
            DomEventData::Focus(_) => self.recorded.focus = Some(target),
            DomEventData::Blur(_) => self.recorded.blur = Some(target),
            DomEventData::Scroll(_) => self.recorded.scroll = Some(target),
            _ => {}
        }
    }
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
    fn mutate_document<T>(
        &mut self,
        op: impl FnOnce(&mut DocumentMutator<'_>) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        let mut mutator = self.document.mutate();
        let result = op(&mut mutator);
        drop(mutator);

        result
    }

    fn ensure_node(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .map(|_| ())
            .ok_or_else(|| invalid_node(node_id))
    }

    fn ensure_element(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .ok_or_else(|| invalid_node(node_id))?
            .element_data()
            .map(|_| ())
            .ok_or_else(|| invalid_element(node_id))
    }

    fn child_element_by_tag(&self, parent_id: usize, tag_name: &str) -> Result<usize, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        parent
            .children
            .iter()
            .find_map(|child_id| {
                let child = self.document.get_node(*child_id)?;
                let element = child.element_data()?;
                (element.name.local.as_ref() == tag_name).then_some(*child_id)
            })
            .ok_or_else(|| JsValue::from_str(&format!("Missing <{tag_name}> element")))
    }

    fn optional_child_element_by_tag(
        &self,
        parent_id: usize,
        tag_name: &str,
    ) -> Result<Option<usize>, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        Ok(parent.children.iter().find_map(|child_id| {
            let child = self.document.get_node(*child_id)?;
            let element = child.element_data()?;
            (element.name.local.as_ref() == tag_name).then_some(*child_id)
        }))
    }

    /// Find the document's `<title>` element, if any. Mirrors the HTML spec's tolerance for a
    /// missing `<head>` (e.g. after `document.head.remove()`) by returning `None` rather than
    /// failing, so title lookups never break unrelated DOM operations.
    fn title_element(&self) -> Result<Option<usize>, JsValue> {
        let Some(head_id) =
            self.optional_child_element_by_tag(self.document.root_element().id, "head")?
        else {
            return Ok(None);
        };
        self.optional_child_element_by_tag(head_id, "title")
    }

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
    }

    /// Feed a `UiEvent` into Blitz's event pipeline via a fresh `EventDriver`, using a
    /// `RecordingEventHandler` (rather than the `Document::handle_ui_event` default's
    /// `NoopEventHandler`) so JS-registered handlers can be invoked afterwards. Returns
    /// whether a redraw was requested as a result.
    fn dispatch(&mut self, event: UiEvent) -> bool {
        self.recorded_events = RecordedEvents::default();

        let QuoxRendererState {
            document,
            recorded_events,
            ..
        } = self;
        let mut driver = EventDriver::new(
            document,
            RecordingEventHandler {
                recorded: recorded_events,
            },
        );
        driver.handle_ui_event(event);

        self.redraw_requested.swap(false, Ordering::Relaxed)
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
                dev_id,
                renderer,
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

    /// Return the id of the topmost DOM node at the given viewport-pixel coordinates
    /// (top-left origin, unscaled — the same space `mousemove` events report), or `None`
    /// if nothing is hit (e.g. the point is outside the viewport, or nothing is there).
    /// Forces a layout resolve first, then delegates to Blitz's own hit-testing — which
    /// still has a known TODO for z-index disambiguation among plain overlapping siblings
    /// (see Blitz's `Node::hit`), so overlapping-sibling ordering isn't fully guaranteed.
    pub fn node_from_point(&self, x: f32, y: f32) -> Option<usize> {
        let mut state = self.state.borrow_mut();
        state.sync_layout();

        let scroll = state.document.viewport_scroll();
        let (page_x, page_y) =
            viewport_point_to_page(x, y, state.width, state.height, scroll.x, scroll.y)?;
        state.document.hit(page_x, page_y).map(|hit| hit.node_id)
    }

    /// Feed a pointer-move event into Blitz (drives hover/`:hover`, cursor resolution, and
    /// drag/text-selection while `buttons` is non-zero). Does **not** force a layout
    /// resolve — feeds whatever layout the render loop last resolved, since forcing a full
    /// `resolve()` on every mouse-pixel of movement (far more often than the ~16ms render
    /// cadence) would be a real perf regression; staleness is bounded to about one frame.
    /// `buttons` is a `MouseEventButtons` bitmask (`Primary=1, Secondary=2, Auxiliary=4`).
    /// Returns whether a redraw was requested.
    pub fn dispatch_pointer_move(&self, x: f32, y: f32, buttons: u8) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) = pointer_event(&state, x, y, MouseEventButton::Main, buttons) else {
            return false;
        };
        state.dispatch(UiEvent::PointerMove(event))
    }

    /// Feed a pointer-down event into Blitz (drives `:active`, click/double-click timing,
    /// drag-to-select start, and focusing a text input if one was hit). `button` matches
    /// `MouseEventButton`'s discriminants (`Main=0, Auxiliary=1, Secondary=2, Fourth=3,
    /// Fifth=4`); `buttons` is the currently-held bitmask. Returns whether a redraw was
    /// requested.
    pub fn dispatch_pointer_down(&self, x: f32, y: f32, button: u8, buttons: u8) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) = pointer_event(&state, x, y, mouse_button(button), buttons) else {
            return false;
        };
        state.dispatch(UiEvent::PointerDown(event))
    }

    /// Feed a pointer-up event into Blitz (clears `:active`, ends drag/selection, and is
    /// the trigger Blitz uses internally to synthesize `click`/`contextmenu`/`dblclick`).
    /// Returns whether a redraw was requested.
    pub fn dispatch_pointer_up(&self, x: f32, y: f32, button: u8, buttons: u8) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) = pointer_event(&state, x, y, mouse_button(button), buttons) else {
            return false;
        };
        state.dispatch(UiEvent::PointerUp(event))
    }

    /// Feed a wheel event into Blitz, which scrolls whatever's currently hovered (bubbling
    /// to ancestors/the viewport if it can't scroll further) rather than always scrolling
    /// the whole viewport. `delta_x`/`delta_y` are pixel deltas (already scaled by the
    /// caller) — passed as `BlitzWheelDelta::Pixels`, which Blitz applies directly (unlike
    /// `Lines`, which it internally multiplies ×20). Returns whether a redraw was
    /// requested.
    pub fn dispatch_wheel(&self, x: f32, y: f32, delta_x: f64, delta_y: f64, buttons: u8) -> bool {
        let mut state = self.state.borrow_mut();
        let scroll = state.document.viewport_scroll();
        let Some((page_x, page_y)) =
            viewport_point_to_page(x, y, state.width, state.height, scroll.x, scroll.y)
        else {
            return false;
        };

        let event = BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(delta_x, delta_y),
            coords: pointer_coords(x, y, page_x, page_y),
            buttons: MouseEventButtons::from_bits_truncate(buttons),
            mods: Modifiers::empty(),
        };
        state.dispatch(UiEvent::Wheel(event))
    }

    /// Feed a keydown event into Blitz (drives text-input editing, Tab focus traversal,
    /// clipboard copy, and Enter-triggered form submission). `code` is a DOM
    /// `KeyboardEvent.code`-style physical key identifier; the corresponding `key`
    /// (character/named key) is synthesized from it plus the modifier flags — see
    /// `synthesize_key`. Returns whether a redraw was requested.
    #[allow(clippy::fn_params_excessive_bools)]
    pub fn dispatch_key_down(
        &self,
        code: &str,
        shift_key: bool,
        ctrl_key: bool,
        alt_key: bool,
        meta_key: bool,
        caps_lock: bool,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let event = key_event(
            code,
            shift_key,
            ctrl_key,
            alt_key,
            meta_key,
            caps_lock,
            KeyState::Pressed,
        );
        state.dispatch(UiEvent::KeyDown(event))
    }

    /// Feed a keyup event into Blitz. See `dispatch_key_down`. Returns whether a redraw was
    /// requested.
    #[allow(clippy::fn_params_excessive_bools)]
    pub fn dispatch_key_up(
        &self,
        code: &str,
        shift_key: bool,
        ctrl_key: bool,
        alt_key: bool,
        meta_key: bool,
        caps_lock: bool,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let event = key_event(
            code,
            shift_key,
            ctrl_key,
            alt_key,
            meta_key,
            caps_lock,
            KeyState::Released,
        );
        state.dispatch(UiEvent::KeyUp(event))
    }

    /// Clear Blitz's hover state (and reset the cursor), e.g. when the pointer leaves the
    /// window entirely and no further `mousemove` will arrive to naturally update hover.
    /// Returns whether a redraw was requested.
    pub fn clear_hover(&self) -> bool {
        let mut state = self.state.borrow_mut();
        state.document.clear_hover();
        state.redraw_requested.swap(false, Ordering::Relaxed)
    }

    /// Drain the node id a `click` fired on since the last dispatch, if any.
    pub fn take_click_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.click.take()
    }

    /// Drain the node id a `dblclick` fired on since the last dispatch, if any.
    pub fn take_double_click_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.double_click.take()
    }

    /// Drain the node id a `contextmenu` fired on since the last dispatch, if any.
    pub fn take_context_menu_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.context_menu.take()
    }

    /// Drain the node id an `input` fired on since the last dispatch, if any.
    pub fn take_input_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.input.take()
    }

    /// Drain the node id a `focus` fired on since the last dispatch, if any.
    pub fn take_focus_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.focus.take()
    }

    /// Drain the node id a `blur` fired on since the last dispatch, if any.
    pub fn take_blur_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.blur.take()
    }

    /// Drain the node id a `scroll` fired on since the last dispatch, if any.
    pub fn take_scroll_node(&self) -> Option<usize> {
        self.state.borrow_mut().recorded_events.scroll.take()
    }

    /// Remove a node from the retained document.
    pub fn remove_node(&self, node_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(node_id)?;
        state.mutate_document(|mutator| {
            mutator.remove_node(node_id);
            Ok(())
        })
    }

    // Append `child_id` to `parent_id`.
    pub fn append_child(&self, parent_id: usize, child_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(parent_id)?;
        state.ensure_node(child_id)?;
        state.mutate_document(|mutator| {
            mutator.append_children(parent_id, &[child_id]);
            Ok(())
        })
    }

    /// Return a node's text content.
    pub fn text_content(&self, node_id: usize) -> Result<String, JsValue> {
        let state = self.state.borrow();
        state
            .document
            .get_node(node_id)
            .map(blitz_dom::Node::text_content)
            .ok_or_else(|| invalid_node(node_id))
    }

    /// Return the document title.
    pub fn title(&self) -> Result<String, JsValue> {
        let state = self.state.borrow();
        match state.title_element()? {
            Some(node_id) => state
                .document
                .get_node(node_id)
                .map(blitz_dom::Node::text_content)
                .ok_or_else(|| invalid_node(node_id)),
            None => Ok(String::new()),
        }
    }

    /// Set an element attribute.
    pub fn set_attribute(&self, node_id: usize, name: &str, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.set_attribute(node_id, attr_name(name), value);
            Ok(())
        })
    }

    /// Create an element node in the retained document.
    pub fn create_element(&self, tag_name: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| {
            Ok(mutator.create_element(html_name(&tag_name.to_ascii_lowercase()), Vec::new()))
        })
    }

    /// Replace an element's children by parsing an HTML fragment through Blitz's mutator.
    pub fn set_inner_html(&self, node_id: usize, html: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.set_inner_html(node_id, html);
            Ok(())
        })
    }

    /// Create a text node in the retained document.
    pub fn create_text_node(&self, text: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| Ok(mutator.create_text_node(text)))
    }

    /// Return the root `<html>` element node id.
    pub fn document_element(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        Ok(state.document.root_element().id)
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&self, node_id: usize, name: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.clear_attribute(node_id, attr_name(name));
            Ok(())
        })
    }

    /// Replace a node's text content.
    pub fn set_text_content(&self, node_id: usize, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let is_text_node = {
            let node = state
                .document
                .get_node(node_id)
                .ok_or_else(|| invalid_node(node_id))?;
            matches!(&node.data, NodeData::Text(_))
        };

        state.mutate_document(|mutator| {
            if is_text_node {
                mutator.set_node_text(node_id, value);
            } else {
                mutator.remove_and_drop_all_children(node_id);
                if !value.is_empty() {
                    let text_id = mutator.create_text_node(value);
                    mutator.append_children(node_id, &[text_id]);
                }
            }

            Ok(())
        })
    }

    /// Replace the first document `<title>` text, creating the element in `<head>` if needed.
    /// Mirrors the HTML spec's `document.title` setter: if there is no `<head>` (e.g. after
    /// `document.head.remove()`), this is a no-op rather than an error.
    pub fn set_title(&self, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let Some(head_id) =
            state.optional_child_element_by_tag(state.document.root_element().id, "head")?
        else {
            return Ok(());
        };
        let existing_title_id = state.optional_child_element_by_tag(head_id, "title")?;

        state.mutate_document(|mutator| {
            let title_id = existing_title_id.unwrap_or_else(|| {
                let title_id = mutator.create_element(html_name("title"), Vec::new());
                mutator.append_children(head_id, &[title_id]);
                title_id
            });

            mutator.remove_and_drop_all_children(title_id);
            if !value.is_empty() {
                let text_id = mutator.create_text_node(value);
                mutator.append_children(title_id, &[text_id]);
            }

            Ok(())
        })
    }

    /// Return the document `<body>` node id.
    pub fn body(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "body")
    }

    /// Return the document `<head>` node id.
    pub fn head(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "head")
    }

    /// Render the current HTML and return a flat `width × height × 4`
    /// RGBA byte buffer (`TextureFormat::Rgba8Unorm`).
    pub async fn render(&self) -> Result<Vec<u8>, JsValue> {
        let (_texture, gpu_buffer, row_bytes, padded_row_bytes, w, h) = {
            let mut state = self.state.borrow_mut();
            state.sync_layout();
            let w = state.width;
            let h = state.height;

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
            paint_scene(&mut painter, &mut state.document, 1.0, w, h, 0, 0);

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
