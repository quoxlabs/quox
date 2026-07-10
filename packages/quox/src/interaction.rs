use super::{QuoxRenderer, QuoxRendererState};
use blitz_dom::{Document, EventDriver, EventHandler};
use blitz_traits::events::{
    BlitzImeEvent, BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta,
    BlitzWheelEvent, DomEvent, DomEventData, EventState, KeyState, MouseEventButton,
    MouseEventButtons, Point as ElementPoint, PointerCoords, PointerDetails, UiEvent,
};
use keyboard_types::{Code, Key, Location, Modifiers};
use std::str::FromStr;
use std::sync::atomic::Ordering;
use wasm_bindgen::prelude::*;

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

/// Prefer the platform's layout-aware logical key, retaining parser-unknown strings as
/// character keys. Fall back to legacy physical-code synthesis only when the backend cannot
/// supply a logical key.
fn native_key(code: &str, logical_key: Option<&str>, shift: bool, caps_lock: bool) -> Key {
    match logical_key.filter(|key| !key.is_empty()) {
        Some(key) => Key::from_str(key).unwrap_or_else(|_| Key::Character(key.to_owned())),
        None => synthesize_key(code, shift, caps_lock),
    }
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
    logical_key: Option<&str>,
    text: Option<&str>,
    repeat: bool,
    state: KeyState,
) -> BlitzKeyEvent {
    BlitzKeyEvent {
        key: native_key(code, logical_key, shift_key, caps_lock),
        code: Code::from_str(code).unwrap_or(Code::Unidentified),
        modifiers: build_modifiers(shift_key, ctrl_key, alt_key, meta_key, caps_lock),
        location: Location::Standard,
        is_auto_repeating: repeat,
        is_composing: false,
        state,
        text: text.map(Into::into),
    }
}

/// A committed text payload is inserted by the following `Ime::Commit`, not by Blitz's
/// physical-key default action. Cancelling only this case preserves navigation, deletion,
/// shortcuts, Tab traversal, and other key defaults.
fn cancel_text_keydown_default(event: &DomEvent, event_state: &mut EventState) {
    if matches!(&event.data, DomEventData::KeyDown(data) if data.text.is_some()) {
        event_state.prevent_default();
    }
}

/// Records, per dispatched `DomEvent`, the target node id for the handful of event kinds a
/// host application cares about invoking a JS-registered handler for. Populated by
/// `RecordingEventHandler` and drained by `QuoxRenderer::take_*_node()`.
#[derive(Default)]
pub(super) struct RecordedEvents {
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
        event_state: &mut EventState,
    ) {
        cancel_text_keydown_default(event, event_state);

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

impl QuoxRendererState {
    /// Feed a `UiEvent` into Blitz's event pipeline via a fresh `EventDriver`, using a
    /// `RecordingEventHandler` (rather than the `Document::handle_ui_event` default's
    /// `NoopEventHandler`) so JS-registered handlers can be invoked afterwards. Returns
    /// whether a redraw was requested as a result.
    fn dispatch(&mut self, event: UiEvent) -> bool {
        self.recorded_events = RecordedEvents::default();

        {
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
        }

        self.refresh_ime_cursor_area();

        self.redraw_requested.swap(false, Ordering::Relaxed)
    }
}

#[wasm_bindgen]
impl QuoxRenderer {
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
    /// `KeyboardEvent.code`-style physical key identifier. `logical_key` is the backend's
    /// layout-aware DOM `KeyboardEvent.key` value; when absent, Quox falls back to best-effort
    /// US-QWERTY synthesis. `text` is committed text that will be inserted by a separate
    /// `dispatch_ime_commit`, and `repeat` marks an auto-repeat press. Returns whether a redraw
    /// was requested.
    #[allow(
        clippy::fn_params_excessive_bools,
        clippy::needless_pass_by_value,
        clippy::too_many_arguments,
        reason = "the exported host-event ABI is intentionally flat, and wasm-bindgen requires owned optional strings"
    )]
    pub fn dispatch_key_down(
        &self,
        code: &str,
        shift_key: bool,
        ctrl_key: bool,
        alt_key: bool,
        meta_key: bool,
        caps_lock: bool,
        logical_key: Option<String>,
        text: Option<String>,
        repeat: bool,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let event = key_event(
            code,
            shift_key,
            ctrl_key,
            alt_key,
            meta_key,
            caps_lock,
            logical_key.as_deref(),
            text.as_deref(),
            repeat,
            KeyState::Pressed,
        );
        state.dispatch(UiEvent::KeyDown(event))
    }

    /// Feed a keyup event into Blitz. See `dispatch_key_down`. Returns whether a redraw was
    /// requested.
    #[allow(
        clippy::fn_params_excessive_bools,
        clippy::needless_pass_by_value,
        clippy::too_many_arguments,
        reason = "the exported host-event ABI is intentionally flat, and wasm-bindgen requires owned optional strings"
    )]
    pub fn dispatch_key_up(
        &self,
        code: &str,
        shift_key: bool,
        ctrl_key: bool,
        alt_key: bool,
        meta_key: bool,
        caps_lock: bool,
        logical_key: Option<String>,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let event = key_event(
            code,
            shift_key,
            ctrl_key,
            alt_key,
            meta_key,
            caps_lock,
            logical_key.as_deref(),
            None,
            false,
            KeyState::Released,
        );
        state.dispatch(UiEvent::KeyUp(event))
    }

    /// Notify Blitz that the native input method has become active.
    pub fn dispatch_ime_enabled(&self) -> bool {
        self.state
            .borrow_mut()
            .dispatch(UiEvent::Ime(BlitzImeEvent::Enabled))
    }

    /// Notify Blitz that the native input method has become inactive and clear any pending
    /// preedit text.
    pub fn dispatch_ime_disabled(&self) -> bool {
        self.state
            .borrow_mut()
            .dispatch(UiEvent::Ime(BlitzImeEvent::Disabled))
    }

    /// Update the native IME's preedit text. Cursor offsets are optional UTF-8 byte offsets;
    /// both must be present to expose a cursor/selection inside the preedit.
    pub fn dispatch_ime_preedit(
        &self,
        text: &str,
        cursor_start: Option<usize>,
        cursor_end: Option<usize>,
    ) -> bool {
        let cursor = cursor_start.zip(cursor_end);
        self.state
            .borrow_mut()
            .dispatch(UiEvent::Ime(BlitzImeEvent::Preedit(
                text.to_owned(),
                cursor,
            )))
    }

    /// Commit native IME text to the focused Blitz text editor.
    pub fn dispatch_ime_commit(&self, text: &str) -> bool {
        let mut state = self.state.borrow_mut();
        // Blitz follows winit's contract: an empty preedit immediately precedes Commit. Clear it
        // here as well so backends can expose the simpler commit-only entry point safely.
        let cleared_preedit =
            state.dispatch(UiEvent::Ime(BlitzImeEvent::Preedit(String::new(), None)));
        let committed = state.dispatch(UiEvent::Ime(BlitzImeEvent::Commit(text.to_owned())));
        cleared_preedit || committed
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
}

#[cfg(test)]
mod tests {
    use super::{
        RecordedEvents, RecordingEventHandler, cancel_text_keydown_default, key_event, native_key,
        synthesize_key, viewport_point_to_page,
    };
    use blitz_dom::{BaseDocument, DocumentConfig, EventDriver};
    use blitz_html::HtmlDocument;
    use blitz_traits::events::{
        BlitzImeEvent, DomEvent, DomEventData, EventState, KeyState, UiEvent,
    };
    use blitz_traits::shell::{ColorScheme, Viewport};
    use keyboard_types::Key;

    fn focused_input_document() -> (BaseDocument, usize) {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><input value=\"\"></body></html>",
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

        (document, input_id)
    }

    fn dispatch_to_document(
        document: &mut BaseDocument,
        recorded: &mut RecordedEvents,
        event: UiEvent,
    ) {
        let mut driver = EventDriver::new(document, RecordingEventHandler { recorded });
        driver.handle_ui_event(event);
    }

    fn input_raw_text(document: &mut BaseDocument, input_id: usize) -> String {
        let mut text = None;
        document.with_text_input(input_id, |driver| {
            text = Some(driver.editor.raw_text().to_owned());
        });
        text.expect("test node should remain a text input")
    }

    fn input_compose_range(document: &mut BaseDocument, input_id: usize) -> Option<(usize, usize)> {
        let mut range = None;
        document.with_text_input(input_id, |driver| {
            range = driver
                .editor
                .raw_compose()
                .as_ref()
                .map(|range| (range.start, range.end));
        });
        range
    }

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

    #[test]
    fn prefers_layout_aware_logical_keys_and_falls_back_to_physical_synthesis() {
        assert_eq!(
            native_key("KeyQ", Some("ä"), false, false),
            Key::Character("ä".into())
        );
        assert_eq!(
            native_key("KeyQ", Some("ArrowDown"), false, false),
            Key::ArrowDown
        );
        assert_eq!(
            native_key("KeyQ", None, false, false),
            Key::Character("q".into())
        );
        assert_eq!(
            native_key("KeyQ", Some("ss"), false, false),
            Key::Character("ss".into())
        );
        assert_eq!(
            native_key("KeyQ", Some(""), false, false),
            Key::Character("q".into())
        );
    }

    #[test]
    fn key_event_carries_committed_text_and_repeat_state() {
        let event = key_event(
            "KeyQ",
            false,
            false,
            true,
            false,
            false,
            Some("@"),
            Some("@"),
            true,
            KeyState::Pressed,
        );

        assert_eq!(event.key, Key::Character("@".into()));
        assert_eq!(event.text.as_deref(), Some("@"));
        assert!(event.is_auto_repeating);
    }

    #[test]
    fn cancels_only_text_bearing_keydown_defaults() {
        let text_keydown = DomEvent::new(
            1,
            DomEventData::KeyDown(key_event(
                "KeyZ",
                false,
                false,
                false,
                false,
                false,
                Some("z"),
                Some("z"),
                false,
                KeyState::Pressed,
            )),
        );
        let navigation_keydown = DomEvent::new(
            1,
            DomEventData::KeyDown(key_event(
                "ArrowLeft",
                false,
                false,
                false,
                false,
                false,
                Some("ArrowLeft"),
                None,
                false,
                KeyState::Pressed,
            )),
        );
        let text_keyup = DomEvent::new(
            1,
            DomEventData::KeyUp(key_event(
                "KeyZ",
                false,
                false,
                false,
                false,
                false,
                Some("z"),
                Some("z"),
                false,
                KeyState::Released,
            )),
        );

        let mut text_keydown_state = EventState::default();
        cancel_text_keydown_default(&text_keydown, &mut text_keydown_state);
        assert!(text_keydown_state.is_cancelled());

        let mut navigation_keydown_state = EventState::default();
        cancel_text_keydown_default(&navigation_keydown, &mut navigation_keydown_state);
        assert!(!navigation_keydown_state.is_cancelled());

        let mut text_keyup_state = EventState::default();
        cancel_text_keydown_default(&text_keyup, &mut text_keyup_state);
        assert!(!text_keyup_state.is_cancelled());
    }

    #[test]
    fn text_keydown_then_ime_commit_inserts_exactly_once() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        let key = key_event(
            "KeyS",
            false,
            false,
            false,
            false,
            false,
            Some("ß"),
            Some("ß"),
            false,
            KeyState::Pressed,
        );

        dispatch_to_document(&mut document, &mut recorded, UiEvent::KeyDown(key));
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(recorded.input, None);

        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Commit("ß".to_owned())),
        );
        assert_eq!(input_raw_text(&mut document, input_id), "ß");
        assert_eq!(recorded.input, Some(input_id));
    }

    #[test]
    fn textless_legacy_keydown_preserves_blitz_default_insertion() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        let key = key_event(
            "KeyA",
            false,
            false,
            false,
            false,
            false,
            None,
            None,
            false,
            KeyState::Pressed,
        );

        dispatch_to_document(&mut document, &mut recorded, UiEvent::KeyDown(key));
        assert_eq!(input_raw_text(&mut document, input_id), "a");
        assert_eq!(recorded.input, Some(input_id));
    }

    #[test]
    fn utf8_preedit_updates_and_clears_without_emitting_input() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        let preedit = "に";

        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Preedit(
                preedit.to_owned(),
                Some((0, preedit.len())),
            )),
        );
        assert_eq!(input_raw_text(&mut document, input_id), preedit);
        assert_eq!(
            input_compose_range(&mut document, input_id),
            Some((0, preedit.len()))
        );
        assert_eq!(recorded.input, None);

        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Preedit(String::new(), None)),
        );
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(input_compose_range(&mut document, input_id), None);
        assert_eq!(recorded.input, None);
    }
}
