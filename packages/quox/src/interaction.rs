use super::QuoxRenderer;
use crate::ffi_numbers::{
    NumericArgumentError, NumericResult, finite_f32, integer_range, known_mask, wasm_usize,
};
use blitz_dom::BaseDocument;
use blitz_traits::events::{
    BlitzInputEvent, BlitzKeyEvent, DomEvent, DomEventData, KeyState, MouseEventButton,
    MouseEventButtons, PointerCoords,
};
use keyboard_types::{Code, Key, Location, Modifiers};
use std::num::NonZeroUsize;
use std::str::FromStr;
use std::sync::atomic::Ordering;
use wasm_bindgen::prelude::*;

pub(super) mod staged_dispatch;

/// Convert logical viewport coordinates (the space `mousemove` events report) into Blitz's
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
    /// Physical Control, kept separate from the runtime platform accelerator.
    Control = 64,
    Fn = 128,
    NumLock = 256,
    ScrollLock = 512,
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
    CapsLock = 16,
    AltGraph = 32,
    Fn = 64,
    NumLock = 128,
    ScrollLock = 256,
}

const KEY_MOD_SHIFT: u32 = KeyModifierMask::Shift as u32;
const KEY_MOD_ALT: u32 = KeyModifierMask::Alt as u32;
const KEY_MOD_META: u32 = KeyModifierMask::Meta as u32;
const KEY_MOD_CAPS_LOCK: u32 = KeyModifierMask::CapsLock as u32;
const KEY_MOD_ALT_GRAPH: u32 = KeyModifierMask::AltGraph as u32;
const KEY_MOD_ACCEL: u32 = KeyModifierMask::Accelerator as u32;
const KEY_MOD_CONTROL: u32 = KeyModifierMask::Control as u32;
const KEY_MOD_FN: u32 = KeyModifierMask::Fn as u32;
const KEY_MOD_NUM_LOCK: u32 = KeyModifierMask::NumLock as u32;
const KEY_MOD_SCROLL_LOCK: u32 = KeyModifierMask::ScrollLock as u32;
const KEY_MOD_KNOWN: u32 = KEY_MOD_SHIFT
    | KEY_MOD_ALT
    | KEY_MOD_META
    | KEY_MOD_CAPS_LOCK
    | KEY_MOD_ALT_GRAPH
    | KEY_MOD_ACCEL
    | KEY_MOD_CONTROL
    | KEY_MOD_FN
    | KEY_MOD_NUM_LOCK
    | KEY_MOD_SCROLL_LOCK;

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
const POINTER_MOD_CAPS_LOCK: u32 = PointerModifierMask::CapsLock as u32;
const POINTER_MOD_ALT_GRAPH: u32 = PointerModifierMask::AltGraph as u32;
const POINTER_MOD_FN: u32 = PointerModifierMask::Fn as u32;
const POINTER_MOD_NUM_LOCK: u32 = PointerModifierMask::NumLock as u32;
const POINTER_MOD_SCROLL_LOCK: u32 = PointerModifierMask::ScrollLock as u32;
const POINTER_MOD_KNOWN: u32 = POINTER_MOD_SHIFT
    | POINTER_MOD_CONTROL
    | POINTER_MOD_ALT
    | POINTER_MOD_META
    | POINTER_MOD_CAPS_LOCK
    | POINTER_MOD_ALT_GRAPH
    | POINTER_MOD_FN
    | POINTER_MOD_NUM_LOCK
    | POINTER_MOD_SCROLL_LOCK;

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

fn validate_key_abi(
    modifier_bits: f64,
    location: f64,
    event_flags: f64,
) -> NumericResult<(u32, u32, u32)> {
    let modifier_bits = known_mask(modifier_bits, KEY_MOD_KNOWN, "modifierBits")?;
    let location = integer_range(location, 0, 3, "location")?;
    let event_flags = known_mask(event_flags, KEY_EVENT_KNOWN, "eventFlags")?;
    if event_flags & KEY_EVENT_PRESSED == 0
        && event_flags & (KEY_EVENT_REPEAT | KEY_EVENT_PREVENT_DEFAULT) != 0
    {
        return Err(NumericArgumentError::new(
            "eventFlags",
            "not repeat or suppress a keydown default on key release",
        ));
    }
    Ok((modifier_bits, location, event_flags))
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
    cursor_start: Option<f64>,
    cursor_end: Option<f64>,
) -> NumericResult<Option<(usize, usize)>> {
    let (Some(cursor_start), Some(cursor_end)) = (cursor_start, cursor_end) else {
        if cursor_start.is_none() && cursor_end.is_none() {
            return Ok(None);
        }
        return Err(NumericArgumentError::new(
            "cursorRange",
            "provide both UTF-8 byte offsets or neither",
        ));
    };
    let cursor_start = wasm_usize(cursor_start, "cursorStart")?;
    let cursor_end = wasm_usize(cursor_end, "cursorEnd")?;
    if cursor_start > cursor_end
        || cursor_end > text.len()
        || !text.is_char_boundary(cursor_start)
        || !text.is_char_boundary(cursor_end)
    {
        return Err(NumericArgumentError::new(
            "cursorRange",
            "contain ordered UTF-8 boundaries within the preedit text",
        ));
    }
    Ok(Some((cursor_start, cursor_end)))
}

/// Map a `winding` button index (`left:0, middle:1, right:2`, matching the ordinals
/// `MouseEventButton` itself already uses for `Main`/`Auxiliary`/`Secondary`) to the
/// corresponding `MouseEventButton`.
fn mouse_button(button: f64) -> NumericResult<MouseEventButton> {
    Ok(match integer_range(button, 0, 4, "button")? {
        0 => MouseEventButton::Main,
        1 => MouseEventButton::Auxiliary,
        2 => MouseEventButton::Secondary,
        3 => MouseEventButton::Fourth,
        4 => MouseEventButton::Fifth,
        _ => unreachable!("integer_range returned a value outside its bounds"),
    })
}

fn pointer_buttons(buttons: f64) -> NumericResult<MouseEventButtons> {
    let buttons = known_mask(buttons, 0x1f, "buttons")?;
    let buttons = u8::try_from(buttons).expect("the known pointer-button mask fits u8");
    Ok(MouseEventButtons::from_bits(buttons)
        .expect("the validated mask contains only Blitz pointer-button bits"))
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

/// Apply the UTF-8 byte counts from an IME delete-surrounding edit to the focused text input.
/// Parley's individual deletion methods intentionally no-op at invalid character boundaries;
/// validate both sides first so one valid half cannot be applied without the other.
fn apply_ime_delete_surrounding(
    document: &mut BaseDocument,
    before_bytes: usize,
    after_bytes: usize,
) -> Option<DomEvent> {
    let target = document.get_focussed_node_id()?;
    let mut value = None;

    document.with_text_input(target, |mut driver| {
        // Wayland's batch bridge clears preedit before delivering this edit. Refuse callers that
        // skip that step because deleting around Parley's preedit buffer would corrupt the IME's
        // model of the surrounding application text.
        if driver.editor.raw_compose().is_some() {
            return;
        }

        let (before_start, selection_start, selection_end, after_end) = {
            let selection = driver.editor.raw_selection().text_range();
            let text = driver.editor.raw_text();
            let before_start = selection.start.saturating_sub(before_bytes);
            let after_end = selection.end.saturating_add(after_bytes).min(text.len());

            if !text.is_char_boundary(before_start) || !text.is_char_boundary(after_end) {
                return;
            }

            (before_start, selection.start, selection.end, after_end)
        };

        if before_start == selection_start && selection_end == after_end {
            return;
        }

        // Delete after the selection first so the byte positions on its left remain unchanged.
        if let Some(bytes) = NonZeroUsize::new(after_bytes) {
            driver.delete_bytes_after_selection(bytes);
        }
        if let Some(bytes) = NonZeroUsize::new(before_bytes) {
            driver.delete_bytes_before_selection(bytes);
        }

        value = Some(driver.editor.raw_text().to_owned());
    });

    value.map(|value| DomEvent::new(target, DomEventData::Input(BlitzInputEvent { value })))
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Return the opaque public handle of the topmost DOM node at the given logical viewport coordinates
    /// (top-left origin — the same space `mousemove` events report), or `None`
    /// if nothing is hit (e.g. the point is outside the viewport, or nothing is there).
    /// Forces a layout resolve first, then delegates to Blitz's own hit-testing — which
    /// still has a known TODO for z-index disambiguation among plain overlapping siblings
    /// (see Blitz's `Node::hit`), so overlapping-sibling ordering isn't fully guaranteed.
    pub fn node_from_point(&self, x: f64, y: f64) -> Result<Option<u32>, JsValue> {
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        state.sync_layout();

        let scroll = state.document.viewport_scroll();
        let Some((page_x, page_y)) =
            viewport_point_to_page(x, y, state.width, state.height, scroll.x, scroll.y)
        else {
            return Ok(None);
        };
        let Some(hit) = state.document.hit(page_x, page_y) else {
            return Ok(None);
        };
        state.expose_public_dom_node(hit.node_id)
    }

    /// Clear Blitz's hover state (and reset the cursor), e.g. when the pointer leaves the
    /// window entirely and no further `mousemove` will arrive to naturally update hover.
    /// Returns whether a redraw was requested.
    pub fn clear_hover(&self) -> bool {
        let mut state = self.state.borrow_mut();
        state.document.clear_hover();
        state.dispatch_stack.end_wheel_transaction();
        state.redraw_requested.swap(false, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        KEY_EVENT_COMPOSING, KEY_EVENT_PRESSED, KEY_EVENT_REPEAT, KEY_MOD_ACCEL, KEY_MOD_ALT,
        KEY_MOD_ALT_GRAPH, KEY_MOD_CONTROL, KEY_MOD_FN, KEY_MOD_META, KEY_MOD_NUM_LOCK,
        KEY_MOD_SCROLL_LOCK, KEY_MOD_SHIFT, apply_ime_delete_surrounding, build_editor_modifiers,
        build_pointer_modifiers, is_insertable_text, key_event, known_mask, mouse_button,
        preedit_cursor, validate_key_abi, viewport_point_to_page,
    };
    use blitz_dom::{BaseDocument, DocumentConfig};
    use blitz_html::HtmlDocument;
    use blitz_traits::events::{
        BlitzImeEvent, BlitzInputEvent, DomEvent, DomEventData, MouseEventButton,
    };
    use blitz_traits::shell::{ColorScheme, Viewport};
    use keyboard_types::{Key, Location, Modifiers};

    fn focused_input_document(initial_value: &str) -> (BaseDocument, usize) {
        let html =
            format!("<!doctype html><html><body><input value=\"{initial_value}\"></body></html>");
        let mut document = HtmlDocument::from_html(
            &html,
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

    fn apply_dom_default(
        document: &mut BaseDocument,
        target: usize,
        data: DomEventData,
    ) -> Vec<DomEvent> {
        let mut event = DomEvent::new(target, data);
        let mut generated = Vec::new();
        document.handle_dom_event(&mut event, |event| generated.push(event));
        generated
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
    fn native_commits_preserve_nonempty_control_text() {
        assert!(!is_insertable_text(""));
        assert!(is_insertable_text("line\nfeed\t\u{3}\u{85}"));
        assert!(is_insertable_text("ß日本"));
    }

    #[test]
    fn runtime_accelerator_maps_to_blitz_control_without_confusing_alt_graph() {
        let darwin_command = build_editor_modifiers(KEY_MOD_META | KEY_MOD_ACCEL);
        assert!(darwin_command.contains(Modifiers::CONTROL));
        assert!(darwin_command.contains(Modifiers::META));

        let darwin_physical_control = build_editor_modifiers(KEY_MOD_CONTROL);
        assert!(!darwin_physical_control.contains(Modifiers::CONTROL));

        let alt_graph = build_editor_modifiers(KEY_MOD_ALT | KEY_MOD_ALT_GRAPH);
        assert!(alt_graph.contains(Modifiers::ALT));
        assert!(alt_graph.contains(Modifiers::ALT_GRAPH));
        assert!(!alt_graph.contains(Modifiers::CONTROL));

        let browser_only_locks =
            build_editor_modifiers(KEY_MOD_FN | KEY_MOD_NUM_LOCK | KEY_MOD_SCROLL_LOCK);
        assert!(browser_only_locks.is_empty());
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

        let browser_only_states = build_pointer_modifiers(
            super::POINTER_MOD_CAPS_LOCK
                | super::POINTER_MOD_ALT_GRAPH
                | super::POINTER_MOD_FN
                | super::POINTER_MOD_NUM_LOCK
                | super::POINTER_MOD_SCROLL_LOCK,
        );
        assert!(browser_only_states.is_empty());
    }

    #[test]
    fn modifier_abis_accept_every_append_only_browser_state_bit() {
        let key_bits = KEY_MOD_FN | KEY_MOD_NUM_LOCK | KEY_MOD_SCROLL_LOCK;
        assert_eq!(
            validate_key_abi(f64::from(key_bits), 0.0, 0.0),
            Ok((key_bits, 0, 0))
        );
        let pointer_bits = super::POINTER_MOD_CAPS_LOCK
            | super::POINTER_MOD_ALT_GRAPH
            | super::POINTER_MOD_FN
            | super::POINTER_MOD_NUM_LOCK
            | super::POINTER_MOD_SCROLL_LOCK;
        assert_eq!(
            known_mask(
                f64::from(pointer_bits),
                super::POINTER_MOD_KNOWN,
                "modifierBits"
            ),
            Ok(pointer_bits)
        );
    }

    #[test]
    fn key_abi_rejects_release_only_flag_violations() {
        assert!(validate_key_abi(0.0, 0.0, f64::from(KEY_EVENT_REPEAT)).is_err());
    }

    #[test]
    fn key_abi_rejects_values_that_would_have_wrapped_a_narrow_mask() {
        assert_eq!(
            validate_key_abi(
                f64::from(KEY_MOD_CONTROL),
                0.0,
                f64::from(KEY_EVENT_PRESSED)
            ),
            Ok((KEY_MOD_CONTROL, 0, KEY_EVENT_PRESSED))
        );
        assert!(validate_key_abi(65_536.0, 0.0, f64::from(KEY_EVENT_PRESSED)).is_err());
        assert!(validate_key_abi(4_294_967_296.0, 0.0, f64::from(KEY_EVENT_PRESSED)).is_err());
    }

    #[test]
    fn key_abi_rejects_values_that_would_have_wrapped_a_narrow_location() {
        assert!(validate_key_abi(0.0, 256.0, f64::from(KEY_EVENT_PRESSED)).is_err());
    }

    #[test]
    fn preedit_cursor_accepts_only_valid_utf8_byte_ranges() {
        assert_eq!(preedit_cursor("éx", Some(2.0), Some(3.0)), Ok(Some((2, 3))));
        assert!(preedit_cursor("éx", Some(1.0), Some(3.0)).is_err());
        assert!(preedit_cursor("éx", Some(3.0), Some(2.0)).is_err());
        assert!(preedit_cursor("éx", Some(0.0), Some(4.0)).is_err());
        assert!(preedit_cursor("éx", Some(0.0), None).is_err());
        assert_eq!(preedit_cursor("éx", None, None), Ok(None));
    }

    #[test]
    fn invalid_pointer_buttons_never_default_to_primary() {
        assert_eq!(mouse_button(0.0), Ok(MouseEventButton::Main));
        assert_eq!(mouse_button(4.0), Ok(MouseEventButton::Fifth));
        assert!(mouse_button(5.0).is_err());
        assert!(mouse_button(256.0).is_err());
    }

    #[test]
    fn utf8_preedit_updates_and_clears_without_emitting_input() {
        let (mut document, input_id) = focused_input_document("");
        let preedit = "に";

        let generated = apply_dom_default(
            &mut document,
            input_id,
            DomEventData::Ime(BlitzImeEvent::Preedit(
                preedit.to_owned(),
                Some((0, preedit.len())),
            )),
        );
        assert_eq!(input_raw_text(&mut document, input_id), preedit);
        assert_eq!(
            input_compose_range(&mut document, input_id),
            Some((0, preedit.len()))
        );
        assert!(generated.is_empty());

        let generated = apply_dom_default(
            &mut document,
            input_id,
            DomEventData::Ime(BlitzImeEvent::Preedit(String::new(), None)),
        );
        assert_eq!(input_raw_text(&mut document, input_id), "");
        assert_eq!(input_compose_range(&mut document, input_id), None);
        assert!(generated.is_empty());
    }

    #[test]
    fn ime_delete_surrounding_applies_utf8_bytes_atomically() {
        let (mut document, input_id) = focused_input_document("Aé日BC");
        document.with_text_input(input_id, |mut driver| driver.move_to_byte(6));

        let event = apply_ime_delete_surrounding(&mut document, 3, 1)
            .expect("valid surrounding byte ranges should produce an input event");
        assert!(matches!(
            &event.data,
            DomEventData::Input(BlitzInputEvent { value }) if value == "AéC"
        ));
        assert_eq!(input_raw_text(&mut document, input_id), "AéC");
    }

    #[test]
    fn ime_delete_surrounding_rejects_a_partial_utf8_edit_atomically() {
        let (mut document, input_id) = focused_input_document("Aé日BC");
        document.with_text_input(input_id, |mut driver| driver.move_to_byte(6));

        // Two bytes before the caret lands inside the three-byte `日`. Although the one-byte
        // deletion after the caret is valid, neither half may be applied on its own.
        assert!(apply_ime_delete_surrounding(&mut document, 2, 1).is_none());
        assert_eq!(input_raw_text(&mut document, input_id), "Aé日BC");
    }
}
