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

/// Stable bit values used by the generated TypeScript keyboard bridge.
#[wasm_bindgen]
pub enum KeyModifierMask {
    Shift = 1,
    Alt = 2,
    Meta = 4,
    CapsLock = 8,
    AltGraph = 16,
    Accelerator = 32,
}

/// Stable event-state bit values used by the generated TypeScript keyboard bridge.
#[wasm_bindgen]
pub enum KeyEventFlag {
    Pressed = 1,
    Repeat = 2,
    Composing = 4,
    PreventDefault = 8,
}

#[wasm_bindgen]
pub enum PointerModifierMask {
    Shift = 1,
    Control = 2,
    Alt = 4,
    Meta = 8,
}

const KEY_MOD_SHIFT: u32 = KeyModifierMask::Shift as u32;
const KEY_MOD_ALT: u32 = KeyModifierMask::Alt as u32;
const KEY_MOD_META: u32 = KeyModifierMask::Meta as u32;
const KEY_MOD_CAPS_LOCK: u32 = KeyModifierMask::CapsLock as u32;
const KEY_MOD_ALT_GRAPH: u32 = KeyModifierMask::AltGraph as u32;
const KEY_MOD_ACCEL: u32 = KeyModifierMask::Accelerator as u32;
const KEY_MOD_KNOWN: u32 = KEY_MOD_SHIFT
    | KEY_MOD_ALT
    | KEY_MOD_META
    | KEY_MOD_CAPS_LOCK
    | KEY_MOD_ALT_GRAPH
    | KEY_MOD_ACCEL;

const KEY_EVENT_PRESSED: u32 = KeyEventFlag::Pressed as u32;
const KEY_EVENT_REPEAT: u32 = KeyEventFlag::Repeat as u32;
const KEY_EVENT_COMPOSING: u32 = KeyEventFlag::Composing as u32;
const KEY_EVENT_PREVENT_DEFAULT: u32 = KeyEventFlag::PreventDefault as u32;
const KEY_EVENT_KNOWN: u32 =
    KEY_EVENT_PRESSED | KEY_EVENT_REPEAT | KEY_EVENT_COMPOSING | KEY_EVENT_PREVENT_DEFAULT;
const POINTER_MOD_SHIFT: u32 = PointerModifierMask::Shift as u32;
const POINTER_MOD_CONTROL: u32 = PointerModifierMask::Control as u32;
const POINTER_MOD_ALT: u32 = PointerModifierMask::Alt as u32;
const POINTER_MOD_META: u32 = PointerModifierMask::Meta as u32;
const POINTER_MOD_KNOWN: u32 =
    POINTER_MOD_SHIFT | POINTER_MOD_CONTROL | POINTER_MOD_ALT | POINTER_MOD_META;

/// Build the modifier set used by Blitz's editor defaults. Quox itself exposes the exact
/// physical flags to JS; this projection deliberately maps the runtime platform accelerator to
/// `CONTROL`, because pinned Blitz chooses its action modifier at Rust compile time while this
/// crate is compiled once for WASM. In particular, `AltGr` and macOS physical Control must not be
/// mistaken for the platform accelerator.
fn build_editor_modifiers(bits: u32) -> Modifiers {
    let mut mods = Modifiers::empty();
    if bits & KEY_MOD_SHIFT != 0 {
        mods |= Modifiers::SHIFT;
    }
    if bits & KEY_MOD_ALT != 0 {
        mods |= Modifiers::ALT;
    }
    if bits & KEY_MOD_META != 0 {
        mods |= Modifiers::META;
    }
    if bits & KEY_MOD_CAPS_LOCK != 0 {
        mods |= Modifiers::CAPS_LOCK;
    }
    if bits & KEY_MOD_ALT_GRAPH != 0 {
        mods |= Modifiers::ALT_GRAPH;
    }
    if bits & KEY_MOD_ACCEL != 0 {
        mods |= Modifiers::CONTROL;
    }
    mods
}

fn build_pointer_modifiers(bits: u32) -> Modifiers {
    assert_eq!(
        bits & !POINTER_MOD_KNOWN,
        0,
        "unknown pointer modifier bits"
    );
    let mut mods = Modifiers::empty();
    if bits & POINTER_MOD_SHIFT != 0 {
        mods |= Modifiers::SHIFT;
    }
    if bits & POINTER_MOD_CONTROL != 0 {
        mods |= Modifiers::CONTROL;
    }
    if bits & POINTER_MOD_ALT != 0 {
        mods |= Modifiers::ALT;
    }
    if bits & POINTER_MOD_META != 0 {
        mods |= Modifiers::META;
    }
    mods
}

fn validate_key_abi(modifier_bits: u32, location: u32, event_flags: u32) {
    assert_eq!(
        modifier_bits & !KEY_MOD_KNOWN,
        0,
        "unknown key modifier bits"
    );
    assert_eq!(event_flags & !KEY_EVENT_KNOWN, 0, "unknown key event bits");
    assert!(location <= 3, "invalid DOM key location");
    if event_flags & KEY_EVENT_PRESSED == 0 {
        assert_eq!(
            event_flags & (KEY_EVENT_REPEAT | KEY_EVENT_PREVENT_DEFAULT),
            0,
            "key releases cannot repeat or suppress a keydown default"
        );
    }
}

fn logical_key(key: &str) -> Key {
    if key.is_empty() {
        Key::Unidentified
    } else {
        Key::from_str(key).unwrap_or(Key::Unidentified)
    }
}

fn is_insertable_text(text: &str) -> bool {
    !text.is_empty()
        && !text
            .chars()
            .any(|character| character <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&character))
}

fn key_location(location: u32) -> Location {
    match location {
        1 => Location::Left,
        2 => Location::Right,
        3 => Location::Numpad,
        _ => Location::Standard,
    }
}

fn preedit_cursor(
    text: &str,
    cursor_start: Option<usize>,
    cursor_end: Option<usize>,
) -> Option<(usize, usize)> {
    cursor_start.zip(cursor_end).filter(|(start, end)| {
        start <= end
            && *end <= text.len()
            && text.is_char_boundary(*start)
            && text.is_char_boundary(*end)
    })
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
    modifier_bits: u32,
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
        mods: build_pointer_modifiers(modifier_bits),
        details: PointerDetails::default(),
        // Overwritten internally by Blitz (relative to the hit target's bounding rect)
        // before it's read anywhere, so the value passed in here is irrelevant.
        element: ElementPoint { x: 0.0, y: 0.0 },
    })
}

fn key_event(
    code: &str,
    key: &str,
    modifier_bits: u32,
    location: u32,
    event_flags: u32,
) -> BlitzKeyEvent {
    BlitzKeyEvent {
        key: logical_key(key),
        code: Code::from_str(code).unwrap_or(Code::Unidentified),
        modifiers: build_editor_modifiers(modifier_bits),
        location: key_location(location),
        is_auto_repeating: event_flags & KEY_EVENT_REPEAT != 0,
        is_composing: event_flags & KEY_EVENT_COMPOSING != 0,
        state: if event_flags & KEY_EVENT_PRESSED != 0 {
            KeyState::Pressed
        } else {
            KeyState::Released
        },
        // Winding Commit is the sole text carrier. Keeping keyboard text empty prevents a
        // backend-specific key path from becoming a second insertion source.
        text: None,
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
    #[cfg(test)]
    input_count: usize,
}

/// Bridges Blitz's `EventHandler` hook (normally a no-op via `NoopEventHandler`) to a
/// `RecordedEvents` buffer, so the wasm boundary can tell the TS side which node/event kind
/// fired and let it invoke the matching JSX `onXxx` prop from `handlers.ts`'s registry.
struct RecordingEventHandler<'a> {
    recorded: &'a mut RecordedEvents,
    cancel_keydown_default: bool,
}

impl EventHandler for RecordingEventHandler<'_> {
    fn handle_event(
        &mut self,
        chain: &[usize],
        event: &mut DomEvent,
        _doc: &mut dyn Document,
        event_state: &mut EventState,
    ) {
        if self.cancel_keydown_default && matches!(event.data, DomEventData::KeyDown(_)) {
            event_state.prevent_default();
        }

        let Some(target) = chain.first().copied() else {
            return;
        };

        match &event.data {
            DomEventData::Click(_) => self.recorded.click = Some(target),
            DomEventData::DoubleClick(_) => self.recorded.double_click = Some(target),
            DomEventData::ContextMenu(_) => self.recorded.context_menu = Some(target),
            DomEventData::Input(_) => {
                self.recorded.input = Some(target);
                #[cfg(test)]
                {
                    self.recorded.input_count += 1;
                }
            }
            DomEventData::Focus(_) => self.recorded.focus = Some(target),
            DomEventData::Blur(_) => self.recorded.blur = Some(target),
            DomEventData::Scroll(_) => self.recorded.scroll = Some(target),
            _ => {}
        }
    }
}

impl QuoxRendererState {
    /// Run one host dispatch inside a single `EventDriver`/recording scope. Keeping the scope
    /// reusable lets a native commit clear preedit and insert text atomically without resetting
    /// the generated DOM-event mailbox between the two Blitz events.
    fn with_event_driver(
        &mut self,
        cancel_keydown_default: bool,
        drive: impl FnOnce(&mut EventDriver<'_, RecordingEventHandler<'_>>),
    ) -> bool {
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
                    cancel_keydown_default,
                },
            );
            drive(&mut driver);
        }

        self.refresh_ime_cursor_area();

        self.redraw_requested.swap(false, Ordering::Relaxed)
    }

    fn dispatch(&mut self, event: UiEvent) -> bool {
        self.dispatch_with_policy(event, false)
    }

    fn dispatch_with_policy(&mut self, event: UiEvent, cancel_keydown_default: bool) -> bool {
        self.with_event_driver(cancel_keydown_default, |driver| {
            driver.handle_ui_event(event);
        })
    }

    /// Pinned Blitz's `UiEvent::AppleStandardKeybinding` path runs the default directly but
    /// leaves the resulting DOM `input` queued inside `EventDriver`. Entering through the public
    /// DOM-event path processes that queue and lets `RecordingEventHandler` expose the input.
    fn dispatch_apple_standard_keybinding(&mut self, command: &str) -> bool {
        let target = self
            .document
            .get_focussed_node_id()
            .unwrap_or_else(|| self.document.root_element().id);
        let event = DomEvent::new(
            target,
            DomEventData::AppleStandardKeybinding(command.into()),
        );
        self.with_event_driver(false, |driver| driver.handle_dom_event(event))
    }
}

fn drive_ime_commit<Handler: EventHandler>(driver: &mut EventDriver<'_, Handler>, text: &str) {
    driver.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(String::new(), None)));
    driver.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(text.to_owned())));
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
    pub fn dispatch_pointer_move(&self, x: f32, y: f32, buttons: u8, modifier_bits: u32) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) =
            pointer_event(&state, x, y, MouseEventButton::Main, buttons, modifier_bits)
        else {
            return false;
        };
        state.dispatch(UiEvent::PointerMove(event))
    }

    /// Feed a pointer-down event into Blitz (drives `:active`, click/double-click timing,
    /// drag-to-select start, and focusing a text input if one was hit). `button` matches
    /// `MouseEventButton`'s discriminants (`Main=0, Auxiliary=1, Secondary=2, Fourth=3,
    /// Fifth=4`); `buttons` is the currently-held bitmask. Returns whether a redraw was
    /// requested.
    pub fn dispatch_pointer_down(
        &self,
        x: f32,
        y: f32,
        button: u8,
        buttons: u8,
        modifier_bits: u32,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) = pointer_event(&state, x, y, mouse_button(button), buttons, modifier_bits)
        else {
            return false;
        };
        state.dispatch(UiEvent::PointerDown(event))
    }

    /// Feed a pointer-up event into Blitz (clears `:active`, ends drag/selection, and is
    /// the trigger Blitz uses internally to synthesize `click`/`contextmenu`/`dblclick`).
    /// Returns whether a redraw was requested.
    pub fn dispatch_pointer_up(
        &self,
        x: f32,
        y: f32,
        button: u8,
        buttons: u8,
        modifier_bits: u32,
    ) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(event) = pointer_event(&state, x, y, mouse_button(button), buttons, modifier_bits)
        else {
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
    pub fn dispatch_wheel(
        &self,
        x: f32,
        y: f32,
        delta_x: f64,
        delta_y: f64,
        buttons: u8,
        modifier_bits: u32,
    ) -> bool {
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
            mods: build_pointer_modifiers(modifier_bits),
        };
        state.dispatch(UiEvent::Wheel(event))
    }

    /// Feed a canonical native key event into Blitz. `modifier_bits` carries the editor-facing
    /// modifier projection plus its runtime accelerator; `event_flags` carries pressed/repeat/
    /// composing/default-cancellation state. Every insertion arrives through a following
    /// `dispatch_ime_commit`.
    pub fn dispatch_key_event(
        &self,
        code: &str,
        key: &str,
        modifier_bits: u32,
        location: u32,
        event_flags: u32,
    ) -> bool {
        validate_key_abi(modifier_bits, location, event_flags);
        let mut state = self.state.borrow_mut();
        let event = key_event(code, key, modifier_bits, location, event_flags);
        let cancel_keydown_default = event_flags & KEY_EVENT_PREVENT_DEFAULT != 0;
        if event.state.is_pressed() {
            state.dispatch_with_policy(UiEvent::KeyDown(event), cancel_keydown_default)
        } else {
            state.dispatch(UiEvent::KeyUp(event))
        }
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
        let cursor = preedit_cursor(text, cursor_start, cursor_end);
        self.state
            .borrow_mut()
            .dispatch(UiEvent::Ime(BlitzImeEvent::Preedit(
                text.to_owned(),
                cursor,
            )))
    }

    /// Commit native IME text to the focused Blitz text editor.
    pub fn dispatch_ime_commit(&self, text: &str) -> bool {
        if !is_insertable_text(text) {
            return false;
        }
        let mut state = self.state.borrow_mut();
        state.with_event_driver(false, |driver| drive_ime_commit(driver, text))
    }

    /// Forward an `AppKit` `doCommandBySelector:` edit through Blitz's existing selector map.
    pub fn dispatch_apple_standard_keybinding(&self, command: &str) -> bool {
        self.state
            .borrow_mut()
            .dispatch_apple_standard_keybinding(command)
    }

    /// Forward byte-counted surrounding-text deletion. Pinned Blitz currently accepts but does
    /// not apply this event; keeping the ABI wired avoids another host-boundary change once its
    /// editor implementation lands.
    pub fn dispatch_ime_delete_surrounding(&self, before_bytes: u32, after_bytes: u32) -> bool {
        self.state
            .borrow_mut()
            .dispatch(UiEvent::Ime(BlitzImeEvent::DeleteSurrounding {
                before_bytes: before_bytes as usize,
                after_bytes: after_bytes as usize,
            }))
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
        KEY_EVENT_COMPOSING, KEY_EVENT_PRESSED, KEY_EVENT_REPEAT, KEY_MOD_ACCEL, KEY_MOD_ALT,
        KEY_MOD_ALT_GRAPH, KEY_MOD_META, KEY_MOD_SHIFT, RecordedEvents, RecordingEventHandler,
        build_editor_modifiers, build_pointer_modifiers, drive_ime_commit, is_insertable_text,
        key_event, preedit_cursor, validate_key_abi, viewport_point_to_page,
    };
    use blitz_dom::{BaseDocument, DocumentConfig, EventDriver};
    use blitz_html::HtmlDocument;
    use blitz_traits::events::{BlitzImeEvent, DomEvent, DomEventData, UiEvent};
    use blitz_traits::shell::{ColorScheme, Viewport};
    use keyboard_types::{Key, Location, Modifiers};

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
        cancel_keydown_default: bool,
    ) {
        let mut driver = EventDriver::new(
            document,
            RecordingEventHandler {
                recorded,
                cancel_keydown_default,
            },
        );
        driver.handle_ui_event(event);
    }

    fn dispatch_dom_to_document(
        document: &mut BaseDocument,
        recorded: &mut RecordedEvents,
        event: DomEvent,
    ) {
        let mut driver = EventDriver::new(
            document,
            RecordingEventHandler {
                recorded,
                cancel_keydown_default: false,
            },
        );
        driver.handle_dom_event(event);
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
    fn key_event_uses_native_logical_key_and_carries_all_metadata() {
        let event = key_event(
            "KeyQ",
            "@",
            KEY_MOD_SHIFT | KEY_MOD_ALT,
            3,
            KEY_EVENT_PRESSED | KEY_EVENT_REPEAT | KEY_EVENT_COMPOSING,
        );

        assert_eq!(event.key, Key::Character("@".into()));
        assert_eq!(event.text, None);
        assert_eq!(event.location, Location::Numpad);
        assert!(event.is_auto_repeating);
        assert!(event.is_composing);
        assert!(event.state.is_pressed());

        assert_eq!(
            key_event("ShiftLeft", "Shift", 0, 1, 0).location,
            Location::Left
        );
        assert_eq!(
            key_event("ShiftRight", "Shift", 0, 2, 0).location,
            Location::Right
        );
        assert_eq!(
            key_event("KeyA", "a", 0, 99, 0).location,
            Location::Standard
        );
    }

    #[test]
    fn empty_logical_key_is_not_synthesized() {
        let event = key_event("KeyQ", "", 0, 0, KEY_EVENT_PRESSED);
        assert_eq!(event.key, Key::Unidentified);
        let event = key_event("KeyQ", "NotAKey", 0, 0, KEY_EVENT_PRESSED);
        assert_eq!(event.key, Key::Unidentified);
    }

    #[test]
    fn committed_text_rejects_control_ranges() {
        assert!(!is_insertable_text(""));
        assert!(!is_insertable_text("\u{3}"));
        assert!(!is_insertable_text("\u{85}"));
        assert!(is_insertable_text("ß日本"));
    }

    #[test]
    fn runtime_accelerator_maps_to_blitz_control_without_confusing_alt_graph() {
        let darwin_command = build_editor_modifiers(KEY_MOD_META | KEY_MOD_ACCEL);
        assert!(darwin_command.contains(Modifiers::CONTROL));
        assert!(darwin_command.contains(Modifiers::META));

        let darwin_physical_control = build_editor_modifiers(0);
        assert!(!darwin_physical_control.contains(Modifiers::CONTROL));

        let alt_graph = build_editor_modifiers(KEY_MOD_ALT | KEY_MOD_ALT_GRAPH);
        assert!(alt_graph.contains(Modifiers::ALT));
        assert!(alt_graph.contains(Modifiers::ALT_GRAPH));
        assert!(!alt_graph.contains(Modifiers::CONTROL));
    }

    #[test]
    fn pointer_modifiers_preserve_browser_control_and_meta_independently() {
        let modifiers = build_pointer_modifiers(
            super::POINTER_MOD_SHIFT | super::POINTER_MOD_CONTROL | super::POINTER_MOD_META,
        );
        assert!(modifiers.contains(Modifiers::SHIFT));
        assert!(modifiers.contains(Modifiers::CONTROL));
        assert!(modifiers.contains(Modifiers::META));
        assert!(!modifiers.contains(Modifiers::ALT));
    }

    #[test]
    #[should_panic(expected = "key releases cannot repeat")]
    fn key_abi_rejects_release_only_flag_violations() {
        validate_key_abi(0, 0, KEY_EVENT_REPEAT);
    }

    #[test]
    #[should_panic(expected = "unknown key modifier bits")]
    fn key_abi_rejects_values_that_would_have_wrapped_a_narrow_mask() {
        validate_key_abi(1 << 16, 0, KEY_EVENT_PRESSED);
    }

    #[test]
    #[should_panic(expected = "invalid DOM key location")]
    fn key_abi_rejects_values_that_would_have_wrapped_a_narrow_location() {
        validate_key_abi(0, 256, KEY_EVENT_PRESSED);
    }

    #[test]
    fn preedit_cursor_accepts_only_valid_utf8_byte_ranges() {
        assert_eq!(preedit_cursor("éx", Some(2), Some(3)), Some((2, 3)));
        assert_eq!(preedit_cursor("éx", Some(1), Some(3)), None);
        assert_eq!(preedit_cursor("éx", Some(3), Some(2)), None);
        assert_eq!(preedit_cursor("éx", Some(0), Some(4)), None);
        assert_eq!(preedit_cursor("éx", Some(0), None), None);
    }

    #[test]
    fn cancelled_text_input_keydown_then_ime_commit_inserts_exactly_once() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        let key = key_event("KeyS", "ß", 0, 0, KEY_EVENT_PRESSED);

        dispatch_to_document(&mut document, &mut recorded, UiEvent::KeyDown(key), true);
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(recorded.input, None);

        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Preedit("に".to_owned(), Some((0, 3)))),
            false,
        );
        recorded = RecordedEvents::default();
        let mut driver = EventDriver::new(
            &mut document,
            RecordingEventHandler {
                recorded: &mut recorded,
                cancel_keydown_default: false,
            },
        );
        drive_ime_commit(&mut driver, "ß");
        assert_eq!(input_raw_text(&mut document, input_id), "ß");
        assert_eq!(recorded.input, Some(input_id));
        assert_eq!(recorded.input_count, 1);
    }

    #[test]
    fn key_default_backspace_preserves_blitz_deletion() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Commit("a".to_owned())),
            false,
        );
        recorded = RecordedEvents::default();
        let key = key_event("Backspace", "Backspace", 0, 0, KEY_EVENT_PRESSED);

        dispatch_to_document(&mut document, &mut recorded, UiEvent::KeyDown(key), false);
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(recorded.input, Some(input_id));
    }

    #[test]
    fn apple_standard_command_processes_the_generated_input_event() {
        let (mut document, input_id) = focused_input_document();
        let mut recorded = RecordedEvents::default();
        dispatch_to_document(
            &mut document,
            &mut recorded,
            UiEvent::Ime(BlitzImeEvent::Commit("a".to_owned())),
            false,
        );
        recorded = RecordedEvents::default();

        dispatch_dom_to_document(
            &mut document,
            &mut recorded,
            DomEvent::new(
                input_id,
                DomEventData::AppleStandardKeybinding("deleteBackward:".into()),
            ),
        );

        assert_eq!(input_raw_text(&mut document, input_id), "");
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
            false,
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
            false,
        );
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(input_compose_range(&mut document, input_id), None);
        assert_eq!(recorded.input, None);
    }
}
