use super::{
    apply_ime_delete_surrounding, is_insertable_text, key_event, mouse_button, pointer_buttons,
    preedit_cursor, validate_key_abi,
};
use crate::dom::{
    actual_focus_node_id, is_html_actually_disabled, is_programmatically_focusable,
    public_dom_node_id, sequential_focus_target,
};
use crate::ffi_numbers::{
    NumericArgumentError, finite_f32, finite_f64, integer_range, known_mask, nonnegative_f64,
    uint32, wasm_usize,
};
use crate::form_controls::{CheckedControlStates, LegacyCheckableActivation, TextControlStates};
use crate::node_handles::NodeHandles;
use crate::{QuoxRenderer, QuoxRendererState, sync_document_layout};
use blitz_dom::node::SpecialElementData;
use blitz_dom::{Attribute, BaseDocument, LocalName, QualName, local_name, ns};
use blitz_traits::events::{
    BlitzImeEvent, BlitzPointerEvent, BlitzPointerId, BlitzScrollEvent, BlitzWheelDelta,
    BlitzWheelEvent, DomEvent, DomEventData, MouseEventButton, MouseEventButtons,
    Point as ElementPoint, PointerDetails,
};
use blitz_traits::shell::{ClipboardError, FileDialogFilter, ShellProvider};
use js_sys::{Array, Object, Reflect};
use std::collections::VecDeque;
use std::fmt::{Display, Formatter};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_bindgen::prelude::*;

const KEY_EVENT_PRESSED: u32 = super::KEY_EVENT_PRESSED;
const KEY_EVENT_PREVENT_DEFAULT: u32 = super::KEY_EVENT_PREVENT_DEFAULT;
const KEY_MOD_ALT: u32 = super::KEY_MOD_ALT;
const KEY_MOD_ALT_GRAPH: u32 = super::KEY_MOD_ALT_GRAPH;
const KEY_MOD_CAPS_LOCK: u32 = super::KEY_MOD_CAPS_LOCK;
const KEY_MOD_CONTROL: u32 = super::KEY_MOD_CONTROL;
const KEY_MOD_FN: u32 = super::KEY_MOD_FN;
const KEY_MOD_META: u32 = super::KEY_MOD_META;
const KEY_MOD_NUM_LOCK: u32 = super::KEY_MOD_NUM_LOCK;
const KEY_MOD_SCROLL_LOCK: u32 = super::KEY_MOD_SCROLL_LOCK;
const KEY_MOD_SHIFT: u32 = super::KEY_MOD_SHIFT;
const POINTER_MOD_ALT: u32 = super::POINTER_MOD_ALT;
const POINTER_MOD_ALT_GRAPH: u32 = super::POINTER_MOD_ALT_GRAPH;
const POINTER_MOD_CAPS_LOCK: u32 = super::POINTER_MOD_CAPS_LOCK;
const POINTER_MOD_CONTROL: u32 = super::POINTER_MOD_CONTROL;
const POINTER_MOD_FN: u32 = super::POINTER_MOD_FN;
const POINTER_MOD_KNOWN: u32 = super::POINTER_MOD_KNOWN;
const POINTER_MOD_META: u32 = super::POINTER_MOD_META;
const POINTER_MOD_NUM_LOCK: u32 = super::POINTER_MOD_NUM_LOCK;
const POINTER_MOD_SCROLL_LOCK: u32 = super::POINTER_MOD_SCROLL_LOCK;
const POINTER_MOD_SHIFT: u32 = super::POINTER_MOD_SHIFT;
const WHEEL_TRANSACTION_TIMEOUT_MS: f64 = 1_500.0;
const UI_EVENT_DETAIL_MAX: u32 = 2_147_483_647;

/// One paused host dispatch. Frames form a stack because an event listener may synchronously
/// start another trusted event before it resumes the event which invoked it.
pub(crate) struct DispatchStack {
    frames: Vec<DispatchFrame>,
    next_frame_id: Option<u32>,
    next_event_id: Option<u32>,
    next_composition_generation: Option<u32>,
    latest_composition_generation: Option<u32>,
    wheel_transaction: Option<WheelTransaction>,
    prevent_compatibility_mouse: bool,
    mouse_button_presses: [Option<MouseButtonPress>; 5],
    ignored_mouse_ups: MouseEventButtons,
    click_sequence: Option<ClickSequence>,
    space_activation_press: Option<SpaceActivationPress>,
    active_composition: Option<ActiveComposition>,
    canceled_composition: Option<CanceledComposition>,
    pending_start_ime: VecDeque<DeferredImeRequest>,
    pending_end_ime: VecDeque<DeferredImeRequest>,
    // The last authoritative in-viewport mouse record is retained independently from the
    // movement baseline so layout-driven boundary refreshes never manufacture movement.
    stationary_pointer: Option<StationaryPointerSnapshot>,
    // UI Events defines the movement baseline at Window scope and only advances it for native
    // mouse moves, so button, wheel, and generated boundary records cannot disturb the delta.
    last_mouse_move: Option<NativePointerCoordinates>,
}

struct ActiveComposition {
    generation: u32,
    target: GuardedNode,
    data: String,
    pending_frame: Option<u32>,
    last_completed_frame: Option<u32>,
    start_pending: bool,
    ending: bool,
}

struct CanceledComposition {
    target: GuardedNode,
}

#[derive(Clone)]
struct StationaryPointerSnapshot {
    event: BlitzPointerEvent,
    metadata: EventMetadata,
}

#[derive(Clone, Copy)]
struct WheelTransaction {
    default_target: GuardedRawNode,
    author_target: GuardedNode,
    last_time_stamp: f64,
}

#[derive(Clone, Copy)]
struct MouseButtonPress {
    page_x: f32,
    page_y: f32,
    dragged: bool,
    author_target: Option<GuardedNode>,
}

#[derive(Clone, Copy)]
struct ClickSequence {
    button: i16,
    target: GuardedNode,
    native_detail: u32,
    detail: u32,
}

#[derive(Clone, Copy)]
struct SpaceActivationPress {
    target: GuardedNode,
    generation: u32,
    kind: SpaceActivationKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SpaceActivationKind {
    Button,
    InputButton,
    InputSubmit,
    InputReset,
    InputImage,
    Checkbox,
    Radio,
}

#[derive(Clone, Copy)]
enum SpaceKeyContinuation {
    Down {
        observed_generation: Option<u32>,
        candidate_generation: u32,
    },
    Up {
        press: Option<SpaceActivationPress>,
    },
}

struct KeyboardEditContinuation {
    intent: EditIntent,
    source_was_editor: bool,
}

#[derive(Clone, Copy)]
struct PointerStreamState {
    suppress_compatibility_mouse: bool,
    release_press: Option<MouseButtonPress>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PointerReleaseClick {
    Matched {
        down_target: GuardedNode,
        up_target: GuardedNode,
    },
    Unmatched,
}

struct DispatchFrame {
    id: u32,
    planned: VecDeque<PlannedWork>,
    generated: VecDeque<GuardedDomEvent>,
    pending: Option<PendingEvent>,
    redraw_requested: bool,
}

/// Delegate visible shell work while hiding focus transitions which pinned Blitz performs only
/// as an implementation detail of an otherwise focus-neutral default.
struct ImeSuppressingShellProvider {
    inner: Arc<dyn ShellProvider>,
}

impl ShellProvider for ImeSuppressingShellProvider {
    fn request_redraw(&self) {
        self.inner.request_redraw();
    }

    fn set_cursor(&self, icon: cursor_icon::CursorIcon) {
        self.inner.set_cursor(icon);
    }

    fn set_window_title(&self, title: String) {
        self.inner.set_window_title(title);
    }

    fn get_clipboard_text(&self) -> Result<String, ClipboardError> {
        self.inner.get_clipboard_text()
    }

    fn set_clipboard_text(&self, text: String) -> Result<(), ClipboardError> {
        self.inner.set_clipboard_text(text)
    }

    fn open_file_dialog(
        &self,
        multiple: bool,
        filter: Option<FileDialogFilter>,
    ) -> Vec<std::path::PathBuf> {
        self.inner.open_file_dialog(multiple, filter)
    }

    fn request_window_close(&self) {
        self.inner.request_window_close();
    }

    fn set_window_minimized(&self, minimized: bool) {
        self.inner.set_window_minimized(minimized);
    }

    fn set_window_maximized(&self, maximized: bool) {
        self.inner.set_window_maximized(maximized);
    }

    fn is_window_maximized(&self) -> bool {
        self.inner.is_window_maximized()
    }

    fn set_window_decorations(&self, decorations: bool) {
        self.inner.set_window_decorations(decorations);
    }

    fn drag_window(&self) {
        self.inner.drag_window();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GuardedNode {
    raw: usize,
    handle: u32,
}

/// A Blitz event target together with the stable public DOM node which owns that raw layout
/// target. Pointer hit testing may return a text node or an anonymous layout box, both of which
/// must remain available to Blitz's default action even though neither is an author-facing
/// pointer event target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GuardedRawNode {
    raw: usize,
    public: GuardedNode,
}

struct GuardedCheckableActivation {
    state: LegacyCheckableActivation,
    target: GuardedNode,
    previous_radio: Option<GuardedNode>,
}

struct TemporaryRadioNameFacade {
    target: usize,
    value: String,
}

struct FileInputDefaultSnapshot {
    target: usize,
    authored_value: Option<String>,
    selection: Vec<std::path::PathBuf>,
}

enum LabelClickDefault {
    NotLabel,
    Suppressed,
    Control {
        target: usize,
        event: BlitzPointerEvent,
    },
}

enum TabKeyDefault {
    Traverse { backwards: bool },
    SuppressKeyUp,
}

enum SpaceKeyEvent<'a> {
    Down(&'a blitz_traits::events::BlitzKeyEvent),
    Up(&'a blitz_traits::events::BlitzKeyEvent),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventShapeOverride {
    PlainInput,
    PlainChange,
}

#[derive(Clone, Copy)]
struct ProtectedCheckableDefault {
    target: GuardedNode,
    checkedness_change: Option<bool>,
}

impl GuardedRawNode {
    fn from_public(public: GuardedNode) -> Self {
        Self {
            raw: public.raw,
            public,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NativePointerCoordinates {
    client_x: f64,
    client_y: f64,
    screen: Option<(f64, f64)>,
    page_x: f64,
    page_y: f64,
    offset_x: f64,
    offset_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NativePointerMetadata {
    coords: NativePointerCoordinates,
    detail: u32,
    movement_x: f64,
    movement_y: f64,
    modifier_bits: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NativeWheelMetadata {
    coords: NativePointerCoordinates,
    delta_x: f64,
    delta_y: f64,
    delta_mode: u32,
    modifier_bits: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
struct NativeKeyMetadata {
    code: String,
    key: String,
    keycode: u32,
    modifier_bits: u32,
    location: u32,
}

#[allow(
    clippy::struct_excessive_bools,
    reason = "metadata keeps independent DOM dispatch/default flags for one native occurrence"
)]
#[derive(Clone, Debug, PartialEq)]
struct EventMetadata {
    time_stamp: f64,
    pointer: Option<NativePointerMetadata>,
    pointer_move_button: Option<i16>,
    pointer_release_click: Option<PointerReleaseClick>,
    wheel: Option<NativeWheelMetadata>,
    key: Option<NativeKeyMetadata>,
    edit_intent: Option<EditIntent>,
    composition_data: Option<String>,
    observe_text_edit: bool,
    related_target: Option<GuardedNode>,
    click_detail: Option<u32>,
    event_type_override: Option<&'static str>,
    cancelable_override: Option<bool>,
    shape_override: Option<EventShapeOverride>,
    label_activation: bool,
    suppress_default: bool,
    defer_click_target: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum EditIntent {
    InsertText { data: String, is_composing: bool },
    InsertLineBreak,
    InsertFromPaste,
    DeleteByCut,
    DeleteByComposition,
    DeleteContentBackward,
    DeleteContentForward,
    DeleteWordBackward,
    DeleteWordForward,
    DeleteSoftLineBackward,
    DeleteSoftLineForward,
    DeleteHardLineBackward,
    DeleteHardLineForward,
}

impl EditIntent {
    fn payload(&self) -> InputPayload {
        let (data, input_type, is_composing) = match self {
            Self::InsertText { data, is_composing } => (
                Some(data.clone()),
                if *is_composing {
                    "insertCompositionText"
                } else {
                    "insertText"
                },
                *is_composing,
            ),
            Self::InsertLineBreak => (None, "insertLineBreak", false),
            Self::InsertFromPaste => (None, "insertFromPaste", false),
            Self::DeleteByCut => (None, "deleteByCut", false),
            Self::DeleteByComposition => (None, "deleteByComposition", false),
            Self::DeleteContentBackward => (None, "deleteContentBackward", false),
            Self::DeleteContentForward => (None, "deleteContentForward", false),
            Self::DeleteWordBackward => (None, "deleteWordBackward", false),
            Self::DeleteWordForward => (None, "deleteWordForward", false),
            Self::DeleteSoftLineBackward => (None, "deleteSoftLineBackward", false),
            Self::DeleteSoftLineForward => (None, "deleteSoftLineForward", false),
            Self::DeleteHardLineBackward => (None, "deleteHardLineBackward", false),
            Self::DeleteHardLineForward => (None, "deleteHardLineForward", false),
        };
        InputPayload {
            data,
            input_type,
            is_composing,
        }
    }
}

impl EventMetadata {
    fn native() -> Self {
        Self {
            time_stamp: event_time_stamp(),
            pointer: None,
            pointer_move_button: None,
            pointer_release_click: None,
            wheel: None,
            key: None,
            edit_intent: None,
            composition_data: None,
            observe_text_edit: false,
            related_target: None,
            click_detail: None,
            event_type_override: None,
            cancelable_override: None,
            shape_override: None,
            label_activation: false,
            suppress_default: false,
            defer_click_target: false,
        }
    }

    #[cfg(test)]
    fn pointer(time_stamp: f64, coords: NativePointerCoordinates, detail: u32) -> Self {
        Self::pointer_metadata(time_stamp, coords, detail, None)
    }

    fn pointer_with_modifiers(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        detail: u32,
        modifier_bits: u32,
    ) -> Self {
        Self::pointer_metadata(time_stamp, coords, detail, Some(modifier_bits))
    }

    fn pointer_metadata(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        detail: u32,
        modifier_bits: Option<u32>,
    ) -> Self {
        Self {
            time_stamp,
            pointer: Some(NativePointerMetadata {
                coords,
                detail,
                movement_x: 0.0,
                movement_y: 0.0,
                modifier_bits,
            }),
            pointer_move_button: None,
            pointer_release_click: None,
            wheel: None,
            key: None,
            edit_intent: None,
            composition_data: None,
            observe_text_edit: false,
            related_target: None,
            click_detail: None,
            event_type_override: None,
            cancelable_override: None,
            shape_override: None,
            label_activation: false,
            suppress_default: false,
            defer_click_target: false,
        }
    }

    #[cfg(test)]
    fn wheel(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u32,
    ) -> Self {
        Self::wheel_metadata(time_stamp, coords, delta_x, delta_y, delta_mode, None)
    }

    fn wheel_with_modifiers(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u32,
        modifier_bits: u32,
    ) -> Self {
        Self::wheel_metadata(
            time_stamp,
            coords,
            delta_x,
            delta_y,
            delta_mode,
            Some(modifier_bits),
        )
    }

    fn wheel_metadata(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u32,
        modifier_bits: Option<u32>,
    ) -> Self {
        Self {
            time_stamp,
            pointer: None,
            pointer_move_button: None,
            pointer_release_click: None,
            wheel: Some(NativeWheelMetadata {
                coords,
                delta_x,
                delta_y,
                delta_mode,
                modifier_bits,
            }),
            key: None,
            edit_intent: None,
            composition_data: None,
            observe_text_edit: false,
            related_target: None,
            click_detail: None,
            event_type_override: None,
            cancelable_override: None,
            shape_override: None,
            label_activation: false,
            suppress_default: false,
            defer_click_target: false,
        }
    }

    fn key(time_stamp: f64, key: NativeKeyMetadata) -> Self {
        Self {
            time_stamp,
            pointer: None,
            pointer_move_button: None,
            pointer_release_click: None,
            wheel: None,
            key: Some(key),
            edit_intent: None,
            composition_data: None,
            observe_text_edit: false,
            related_target: None,
            click_detail: None,
            event_type_override: None,
            cancelable_override: None,
            shape_override: None,
            label_activation: false,
            suppress_default: false,
            defer_click_target: false,
        }
    }

    fn with_related_target(mut self, related_target: Option<GuardedNode>) -> Self {
        self.related_target = related_target;
        self
    }

    fn with_edit_intent(mut self, intent: Option<EditIntent>) -> Self {
        self.observe_text_edit = intent.is_some();
        self.edit_intent = intent;
        self
    }

    fn with_text_edit_observation(mut self, observe: bool) -> Self {
        self.observe_text_edit = observe;
        self
    }

    fn into_before_input(mut self, intent: EditIntent) -> Self {
        let cancelable = !matches!(
            &intent,
            EditIntent::InsertText {
                is_composing: true,
                ..
            }
        );
        self.edit_intent = Some(intent);
        self.observe_text_edit = false;
        self.event_type_override = Some("beforeinput");
        self.cancelable_override = Some(cancelable);
        self.suppress_default = true;
        self
    }

    fn into_composition(mut self, event_type: &'static str, data: String) -> Self {
        self.edit_intent = None;
        self.composition_data = Some(data);
        self.observe_text_edit = false;
        self.event_type_override = Some(event_type);
        self.cancelable_override = Some(event_type == "compositionstart");
        self.suppress_default = true;
        self
    }

    fn with_pointer_move_button(mut self, button: Option<MouseEventButton>) -> Self {
        self.pointer_move_button = button.map(mouse_button_number);
        self
    }

    fn with_pointer_movement(mut self, movement_x: f64, movement_y: f64) -> Self {
        if let Some(pointer) = &mut self.pointer {
            pointer.movement_x = movement_x;
            pointer.movement_y = movement_y;
        }
        self
    }

    fn with_pointer_release_click(mut self, release: Option<PointerReleaseClick>) -> Self {
        self.pointer_release_click = release;
        self
    }

    fn with_click_detail(mut self, detail: u32) -> Self {
        self.click_detail = Some(detail);
        self
    }

    fn into_auxclick(mut self) -> Self {
        self.event_type_override = Some("auxclick");
        // Blitz has no auxclick primitive. Reusing its Click default would run primary-button
        // control activation and cannot express middle-click navigation in a new context.
        self.suppress_default = true;
        self
    }

    fn into_pointer_cancel(mut self) -> Self {
        self.event_type_override = Some("pointercancel");
        self.cancelable_override = Some(false);
        self.suppress_default = true;
        self
    }

    fn into_label_activation(mut self) -> Self {
        // The control click is caused by the label default, not by a second physical release.
        // Retaining release metadata would retarget it back to the label and feed it into the
        // native double-click sequence.
        self.pointer_release_click = None;
        self.event_type_override = None;
        self.cancelable_override = None;
        self.shape_override = None;
        self.label_activation = true;
        self.suppress_default = false;
        self.defer_click_target = false;
        self
    }

    fn into_change(mut self) -> Self {
        self.event_type_override = Some("change");
        self.cancelable_override = Some(false);
        self.shape_override = Some(EventShapeOverride::PlainChange);
        self.suppress_default = true;
        self
    }

    fn into_plain_input(mut self) -> Self {
        self.shape_override = Some(EventShapeOverride::PlainInput);
        self
    }

    fn with_target_offset(mut self, document: &BaseDocument, target: usize) -> Self {
        let Some(rect) = document.get_client_bounding_rect(target) else {
            return self;
        };
        let Some(node) = document.get_node(target) else {
            return self;
        };
        // CSSOM View measures trusted offset coordinates from the target's padding edge. Blitz's
        // client rect begins at the border edge and its layout values are already logical units.
        let padding_edge_x = rect.x + f64::from(node.final_layout.border.left);
        let padding_edge_y = rect.y + f64::from(node.final_layout.border.top);
        let set_offset = |coords: &mut NativePointerCoordinates| {
            coords.offset_x = coords.client_x - padding_edge_x;
            coords.offset_y = coords.client_y - padding_edge_y;
        };
        if let Some(pointer) = &mut self.pointer {
            set_offset(&mut pointer.coords);
        }
        if let Some(wheel) = &mut self.wheel {
            set_offset(&mut wheel.coords);
        }
        self
    }
}

#[derive(Clone, Debug)]
struct GuardedDomEvent {
    event: DomEvent,
    default_target: GuardedRawNode,
    target: GuardedNode,
    path: Vec<GuardedNode>,
    metadata: EventMetadata,
}

impl GuardedDomEvent {
    fn is_default_target_live(&self, document: &BaseDocument, handles: &NodeHandles) -> bool {
        raw_node_is_live(self.default_target, document, handles)
    }
}

#[derive(Clone, Copy)]
enum PlannedTarget {
    Guarded(GuardedNode),
    Focused,
}

enum PlannedWork {
    Enqueue {
        target: PlannedTarget,
        data: DomEventData,
        metadata: EventMetadata,
        suppress_default: bool,
        space_key: Option<SpaceKeyContinuation>,
    },
    Pointer {
        default_target: GuardedRawNode,
        author_target: GuardedNode,
        data: BlitzPointerEvent,
        pointer_flavor: PointerFlavor,
        physical_flavor: PointerFlavor,
        suppress_compatibility_mouse: bool,
        release_press: Option<MouseButtonPress>,
        metadata: EventMetadata,
    },
    Wheel {
        default_target: GuardedRawNode,
        author_target: GuardedNode,
        data: BlitzWheelEvent,
        metadata: EventMetadata,
    },
    DefaultOnly {
        target: PlannedTarget,
        data: DomEventData,
        metadata: EventMetadata,
    },
    GuardedDefault(Box<GuardedDomEvent>),
    TextEdit(PendingEdit),
    CompositionStart(PendingCompositionEdit),
    CompositionUpdate(PendingCompositionEdit),
    CompositionEnd(PendingCompositionEnd),
    ForceCompositionEnd {
        expected_generation: u32,
        metadata: EventMetadata,
    },
    CompositionOccurrenceComplete {
        generation: u32,
        target: GuardedNode,
        frame_id: u32,
    },
    DeferredIme {
        expected_generation: u32,
        expected_completed_frame: Option<u32>,
        request: DeferredImeRequest,
    },
    DoubleClick(PendingDoubleClick),
    Action(DispatchAction),
}

struct PendingDoubleClick {
    target: GuardedNode,
    event: BlitzPointerEvent,
    metadata: EventMetadata,
}

enum DispatchAction {
    PointerDownState(PlannedHover),
    PointerUpState,
    ClearHover,
    LoseFocus {
        target: GuardedNode,
        related_target: Option<GuardedNode>,
        metadata: EventMetadata,
    },
    GainFocus {
        target: GuardedNode,
        related_target: Option<GuardedNode>,
        metadata: EventMetadata,
    },
}

#[derive(Clone, Copy)]
struct PlannedHover {
    raw: Option<usize>,
    default_target: Option<GuardedRawNode>,
    author_target: Option<GuardedNode>,
}

#[derive(Clone, Copy)]
enum PointerFlavor {
    Move,
    Down,
    Up,
}

#[derive(Clone, Copy)]
enum NativePointerBoundary {
    Enter,
    Leave,
}

enum ResumeAction {
    Normal {
        suppress_default: bool,
        double_click: Option<Box<PendingDoubleClick>>,
        checkable_activation: Option<Box<GuardedCheckableActivation>>,
        space_key: Option<SpaceKeyContinuation>,
        keyboard_edit: Option<KeyboardEditContinuation>,
    },
    PointerLead {
        pointer_default: Box<GuardedDomEvent>,
        pointer_fallback_default: Box<GuardedDomEvent>,
        mouse_data: Option<DomEventData>,
        suppressed_release_activation: Option<Box<DomEventData>>,
        release_auxclick: Option<Box<DomEventData>>,
        pointer_cancellation_suppresses_default: bool,
        starts_compatibility_mouse: bool,
        suppress_compatibility_mouse: bool,
    },
    PointerMouse {
        pointer_default: Box<GuardedDomEvent>,
        pointer_default_prevented: bool,
        release_auxclick: Option<Box<DomEventData>>,
    },
    TextEdit(Box<PendingEdit>),
    CompositionStart(Box<PendingCompositionEdit>),
    CompositionUpdate(Box<PendingCompositionEdit>),
    CompositionEnd,
}

struct PendingEdit {
    target: GuardedNode,
    intent: EditIntent,
    metadata: EventMetadata,
    action: PendingEditAction,
}

enum PendingEditAction {
    Default {
        guarded: Box<GuardedDomEvent>,
        space_key: Option<SpaceKeyContinuation>,
    },
    ImeDeleteSurrounding {
        before_bytes: usize,
        after_bytes: usize,
    },
    CompositionPreedit(Box<PendingCompositionEdit>),
}

struct PendingCompositionEdit {
    generation: u32,
    target: GuardedNode,
    data: String,
    cursor: Option<(usize, usize)>,
    metadata: EventMetadata,
    frame_id: u32,
    end_data: Option<String>,
}

struct PendingCompositionEnd {
    generation: u32,
    target: GuardedNode,
    data: String,
    metadata: EventMetadata,
    frame_id: u32,
}

enum DeferredImeRequest {
    Preedit {
        data: String,
        cursor: Option<(usize, usize)>,
    },
    Commit(String),
}

impl DeferredImeRequest {
    fn is_terminal(&self) -> bool {
        match self {
            Self::Commit(_) => true,
            Self::Preedit { data, .. } => data.is_empty(),
        }
    }
}

fn defer_ime_request(queue: &mut VecDeque<DeferredImeRequest>, request: DeferredImeRequest) {
    let coalesces_preedit = matches!(&request, DeferredImeRequest::Preedit { data, .. } if !data.is_empty())
        && queue.back().is_some_and(
            |pending| matches!(pending, DeferredImeRequest::Preedit { data, .. } if !data.is_empty()),
        );
    if coalesces_preedit {
        *queue
            .back_mut()
            .expect("a coalesced preedit has a pending predecessor") = request;
    } else {
        queue.push_back(request);
    }
}

struct PendingEvent {
    id: u32,
    guarded: GuardedDomEvent,
    resume: ResumeAction,
}

enum DispatchRequest {
    Empty,
    StationaryPointerRefresh {
        event: BlitzPointerEvent,
        metadata: EventMetadata,
    },
    Pointer {
        event: BlitzPointerEvent,
        flavor: PointerFlavor,
        metadata: EventMetadata,
    },
    OutsidePointer {
        event: BlitzPointerEvent,
        flavor: PointerFlavor,
        metadata: EventMetadata,
    },
    PointerBoundary {
        event: BlitzPointerEvent,
        boundary: NativePointerBoundary,
        metadata: EventMetadata,
    },
    PointerCancel {
        event: BlitzPointerEvent,
        canceled_buttons: MouseEventButtons,
        metadata: EventMetadata,
    },
    Wheel {
        event: BlitzWheelEvent,
        metadata: EventMetadata,
        occurrence_target: Option<usize>,
    },
    Key {
        event: blitz_traits::events::BlitzKeyEvent,
        metadata: EventMetadata,
        suppress_default: bool,
    },
    Ime(BlitzImeEvent),
    ImeCommit(String),
    AppleStandardKeybinding(String),
    ImeDeleteSurrounding {
        before_bytes: usize,
        after_bytes: usize,
    },
    Focus(usize),
    Blur(usize),
}

#[derive(Clone, Copy)]
struct PointerInput {
    native_x: f64,
    native_y: f64,
    screen: Option<(f64, f64)>,
    x: f32,
    y: f32,
    button: MouseEventButton,
    buttons: blitz_traits::events::MouseEventButtons,
    modifier_bits: u32,
    time_stamp: f64,
    detail: u32,
    flavor: PointerFlavor,
}

#[derive(Clone, Copy)]
struct PointerBoundaryInput {
    native_x: f64,
    native_y: f64,
    screen: Option<(f64, f64)>,
    x: f32,
    y: f32,
    buttons: blitz_traits::events::MouseEventButtons,
    modifier_bits: u32,
    time_stamp: f64,
    boundary: NativePointerBoundary,
}

#[derive(Clone, Copy)]
struct PointerCancelInput {
    native_x: f64,
    native_y: f64,
    screen: Option<(f64, f64)>,
    x: f32,
    y: f32,
    canceled_buttons: MouseEventButtons,
    modifier_bits: u32,
    time_stamp: f64,
}

#[derive(Clone, Copy)]
struct WheelInput {
    native_x: f64,
    native_y: f64,
    screen: Option<(f64, f64)>,
    x: f32,
    y: f32,
    blitz_delta_x: f64,
    blitz_delta_y: f64,
    delta_x: f64,
    delta_y: f64,
    delta_mode: u32,
    buttons: blitz_traits::events::MouseEventButtons,
    modifier_bits: u32,
    time_stamp: f64,
}

/// Proof that pending DOM/style work has been resolved for one trusted input occurrence.
/// Request construction consumes the proof so callers cannot accidentally reuse one layout
/// snapshot for a later native record.
struct ResolvedInputLayout<'a> {
    document: &'a BaseDocument,
    width: u32,
    height: u32,
}

impl<'a> ResolvedInputLayout<'a> {
    #[allow(
        clippy::too_many_arguments,
        reason = "input resolution owns both browser-state facades and the logical/physical viewport contract"
    )]
    fn new(
        document: &'a mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        width: u32,
        height: u32,
        framebuffer_width: u32,
        framebuffer_height: u32,
        device_pixel_ratio: f32,
    ) -> Self {
        text_controls.reconcile_document_with_handles(document, handles);
        checked_controls.reconcile_document(document);
        sync_document_layout(
            document,
            framebuffer_width,
            framebuffer_height,
            device_pixel_ratio,
        );
        Self {
            document,
            width,
            height,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "Blitz stores page coordinates as f32; native metadata retains exact outside-viewport coordinates"
    )]
    fn pointer_request(self, input: PointerInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::pointer_with_modifiers(
            input.time_stamp,
            native_pointer_coordinates(
                input.native_x,
                input.native_y,
                input.screen,
                scroll.x,
                scroll.y,
            ),
            input.detail,
            input.modifier_bits,
        );
        let page = super::viewport_point_to_page(
            input.x,
            input.y,
            self.width,
            self.height,
            scroll.x,
            scroll.y,
        );
        let outside = page.is_none();
        let (page_x, page_y) = page.unwrap_or_else(|| {
            (
                (f64::from(input.x) + scroll.x) as f32,
                (f64::from(input.y) + scroll.y) as f32,
            )
        });
        let event = BlitzPointerEvent {
            id: BlitzPointerId::Mouse,
            is_primary: true,
            coords: super::pointer_coords(input.x, input.y, page_x, page_y),
            button: input.button,
            buttons: input.buttons,
            mods: super::build_pointer_modifiers(input.modifier_bits),
            details: PointerDetails::default(),
            // Blitz overwrites this relative to the hit target before reading it.
            element: ElementPoint::default(),
        };
        if !outside {
            DispatchRequest::Pointer {
                event,
                flavor: input.flavor,
                metadata,
            }
        } else if matches!(input.flavor, PointerFlavor::Move | PointerFlavor::Up) {
            DispatchRequest::OutsidePointer {
                event,
                flavor: input.flavor,
                metadata,
            }
        } else {
            DispatchRequest::Empty
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "Blitz stores rebased page coordinates as f32 while native metadata remains f64"
    )]
    fn stationary_pointer_request(
        self,
        mut snapshot: StationaryPointerSnapshot,
    ) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let client_x = snapshot.event.coords.client_x;
        let client_y = snapshot.event.coords.client_y;
        snapshot.event.coords = super::pointer_coords(
            client_x,
            client_y,
            (f64::from(client_x) + scroll.x) as f32,
            (f64::from(client_y) + scroll.y) as f32,
        );
        snapshot.metadata.time_stamp = event_time_stamp();
        if let Some(pointer) = &mut snapshot.metadata.pointer {
            pointer.coords.page_x = pointer.coords.client_x + scroll.x;
            pointer.coords.page_y = pointer.coords.client_y + scroll.y;
            pointer.coords.offset_x = 0.0;
            pointer.coords.offset_y = 0.0;
            pointer.movement_x = 0.0;
            pointer.movement_y = 0.0;
        }
        DispatchRequest::StationaryPointerRefresh {
            event: snapshot.event,
            metadata: snapshot.metadata,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "Blitz stores page coordinates as f32; native metadata retains the exact f64 boundary coordinates"
    )]
    fn pointer_boundary_request(self, input: PointerBoundaryInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::pointer_with_modifiers(
            input.time_stamp,
            native_pointer_coordinates(
                input.native_x,
                input.native_y,
                input.screen,
                scroll.x,
                scroll.y,
            ),
            0,
            input.modifier_bits,
        );
        let page = match input.boundary {
            NativePointerBoundary::Enter => super::viewport_point_to_page(
                input.x,
                input.y,
                self.width,
                self.height,
                scroll.x,
                scroll.y,
            ),
            NativePointerBoundary::Leave => Some((
                (f64::from(input.x) + scroll.x) as f32,
                (f64::from(input.y) + scroll.y) as f32,
            )),
        };
        page.map_or(DispatchRequest::Empty, |(page_x, page_y)| {
            DispatchRequest::PointerBoundary {
                event: BlitzPointerEvent {
                    id: BlitzPointerId::Mouse,
                    is_primary: true,
                    coords: super::pointer_coords(input.x, input.y, page_x, page_y),
                    button: MouseEventButton::Main,
                    buttons: input.buttons,
                    mods: super::build_pointer_modifiers(input.modifier_bits),
                    details: PointerDetails::default(),
                    element: ElementPoint::default(),
                },
                boundary: input.boundary,
                metadata,
            }
        })
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "Blitz stores page coordinates as f32; native metadata retains exact cancellation coordinates"
    )]
    fn pointer_cancel_request(self, input: PointerCancelInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::pointer_with_modifiers(
            input.time_stamp,
            native_pointer_coordinates(
                input.native_x,
                input.native_y,
                input.screen,
                scroll.x,
                scroll.y,
            ),
            0,
            input.modifier_bits,
        );
        DispatchRequest::PointerCancel {
            event: BlitzPointerEvent {
                id: BlitzPointerId::Mouse,
                is_primary: true,
                coords: super::pointer_coords(
                    input.x,
                    input.y,
                    (f64::from(input.x) + scroll.x) as f32,
                    (f64::from(input.y) + scroll.y) as f32,
                ),
                button: MouseEventButton::Main,
                buttons: MouseEventButtons::None,
                mods: super::build_pointer_modifiers(input.modifier_bits),
                details: PointerDetails::default(),
                element: ElementPoint::default(),
            },
            canceled_buttons: input.canceled_buttons,
            metadata,
        }
    }

    fn wheel_request(self, input: WheelInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::wheel_with_modifiers(
            input.time_stamp,
            native_pointer_coordinates(
                input.native_x,
                input.native_y,
                input.screen,
                scroll.x,
                scroll.y,
            ),
            input.delta_x,
            input.delta_y,
            input.delta_mode,
            input.modifier_bits,
        );
        super::viewport_point_to_page(
            input.x,
            input.y,
            self.width,
            self.height,
            scroll.x,
            scroll.y,
        )
        .map_or(DispatchRequest::Empty, |(page_x, page_y)| {
            let occurrence_target = self.document.hit(page_x, page_y).map(|hit| hit.node_id);
            DispatchRequest::Wheel {
                event: BlitzWheelEvent {
                    delta: if input.delta_mode == 1 {
                        BlitzWheelDelta::Lines(input.blitz_delta_x, input.blitz_delta_y)
                    } else {
                        BlitzWheelDelta::Pixels(input.blitz_delta_x, input.blitz_delta_y)
                    },
                    coords: super::pointer_coords(input.x, input.y, page_x, page_y),
                    buttons: input.buttons,
                    mods: super::build_pointer_modifiers(input.modifier_bits),
                },
                metadata,
                occurrence_target,
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
enum DispatchStep {
    Event(DispatchEventStep),
    Complete {
        frame_id: u32,
        redraw_requested: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
struct DispatchEventStep {
    frame_id: u32,
    event_id: u32,
    event_type: String,
    target: u32,
    path: Vec<u32>,
    bubbles: bool,
    cancelable: bool,
    composed: bool,
    time_stamp: f64,
    payload: Option<Box<DispatchEventPayload>>,
}

#[allow(
    clippy::struct_excessive_bools,
    reason = "these independent booleans are the browser MouseEvent modifier properties"
)]
#[derive(Clone, Debug, PartialEq)]
struct MousePayload {
    client_x: f64,
    client_y: f64,
    screen_x: f64,
    screen_y: f64,
    page_x: f64,
    page_y: f64,
    offset_x: f64,
    offset_y: f64,
    movement_x: f64,
    movement_y: f64,
    button: i16,
    buttons: u8,
    detail: u32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    caps_lock: bool,
    alt_graph_key: bool,
    fn_key: bool,
    num_lock: bool,
    scroll_lock: bool,
    related_target: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
struct PointerPayload {
    mouse: MousePayload,
    pointer_id: f64,
    pointer_type: &'static str,
    is_primary: bool,
    width: f64,
    height: f64,
    pressure: f64,
    tangential_pressure: f64,
    tilt_x: i8,
    tilt_y: i8,
    twist: u16,
    altitude_angle: f64,
    azimuth_angle: f64,
    persistent_device_id: u32,
}

#[derive(Clone, Debug, PartialEq)]
struct WheelPayload {
    mouse: MousePayload,
    delta_x: f64,
    delta_y: f64,
    delta_z: f64,
    delta_mode: u32,
}

#[allow(
    clippy::struct_excessive_bools,
    reason = "these independent booleans are the browser KeyboardEvent state properties"
)]
#[derive(Clone, Debug, PartialEq)]
struct KeyboardPayload {
    key: String,
    code: String,
    location: u32,
    repeat: bool,
    is_composing: bool,
    key_code: u32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
    caps_lock: bool,
    alt_graph_key: bool,
    fn_key: bool,
    num_lock: bool,
    scroll_lock: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct InputPayload {
    data: Option<String>,
    input_type: &'static str,
    is_composing: bool,
}

impl InputPayload {
    const fn empty() -> Self {
        Self {
            data: None,
            input_type: "",
            is_composing: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum DispatchEventPayload {
    Mouse(MousePayload),
    Pointer(PointerPayload),
    Wheel(WheelPayload),
    Keyboard(KeyboardPayload),
    Input(InputPayload),
    Composition { data: String },
    Focus { related_target: Option<u32> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DispatchError(String);

impl DispatchError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    fn into_js(self) -> JsValue {
        js_sys::Error::new(&self.0).into()
    }
}

impl Display for DispatchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Default for DispatchStack {
    fn default() -> Self {
        Self {
            frames: Vec::new(),
            next_frame_id: Some(1),
            next_event_id: Some(1),
            next_composition_generation: Some(1),
            latest_composition_generation: None,
            wheel_transaction: None,
            prevent_compatibility_mouse: false,
            mouse_button_presses: [None; 5],
            ignored_mouse_ups: MouseEventButtons::None,
            click_sequence: None,
            space_activation_press: None,
            active_composition: None,
            canceled_composition: None,
            pending_start_ime: VecDeque::new(),
            pending_end_ime: VecDeque::new(),
            stationary_pointer: None,
            last_mouse_move: None,
        }
    }
}

impl DispatchStack {
    fn allocate_frame_id(&mut self) -> Result<u32, DispatchError> {
        let id = self
            .next_frame_id
            .ok_or_else(|| DispatchError::new("quox: DOM dispatch frame id space exhausted"))?;
        self.next_frame_id = id.checked_add(1);
        Ok(id)
    }

    fn allocate_event_id(&mut self) -> Result<u32, DispatchError> {
        let id = self
            .next_event_id
            .ok_or_else(|| DispatchError::new("quox: DOM dispatch event id space exhausted"))?;
        self.next_event_id = id.checked_add(1);
        Ok(id)
    }

    fn allocate_composition_generation(&mut self) -> Result<u32, DispatchError> {
        let generation = self
            .next_composition_generation
            .ok_or_else(|| DispatchError::new("quox: composition generation space exhausted"))?;
        self.next_composition_generation = generation.checked_add(1);
        self.latest_composition_generation = Some(generation);
        Ok(generation)
    }

    fn begin(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
        request: DispatchRequest,
    ) -> Result<DispatchStep, DispatchError> {
        if self
            .frames
            .last()
            .is_some_and(|frame| frame.pending.is_none())
        {
            return Err(DispatchError::new(
                "quox: a nested DOM dispatch may only begin while its parent event is pending",
            ));
        }

        let frame_id = self.allocate_frame_id()?;
        self.frames.push(DispatchFrame {
            id: frame_id,
            planned: VecDeque::new(),
            generated: VecDeque::new(),
            pending: None,
            redraw_requested: false,
        });

        if let Err(error) = self.plan_request(document, handles, request) {
            self.capture_redraw(redraw);
            self.discard_failed_frame(document, handles, frame_id, redraw);
            return Err(error);
        }

        let result = self.advance(document, text_controls, checked_controls, handles, redraw);
        if result.is_err() {
            self.discard_failed_frame(document, handles, frame_id, redraw);
        }
        result
    }

    #[allow(
        clippy::too_many_arguments,
        clippy::too_many_lines,
        reason = "a continuation validates both ids while sharing dispatch state across each resumable event flavor"
    )]
    fn resume(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
        frame_id: u32,
        event_id: u32,
        default_prevented: bool,
    ) -> Result<DispatchStep, DispatchError> {
        let Some(frame) = self.frames.last() else {
            return Err(DispatchError::new("quox: no DOM dispatch is pending"));
        };
        if frame.id != frame_id {
            return Err(DispatchError::new(format!(
                "quox: DOM dispatch frame {frame_id} is not the active frame {}",
                frame.id
            )));
        }
        let Some(pending) = frame.pending.as_ref() else {
            return Err(DispatchError::new(format!(
                "quox: DOM dispatch frame {frame_id} has no pending JavaScript event"
            )));
        };
        if pending.id != event_id {
            return Err(DispatchError::new(format!(
                "quox: DOM dispatch event {event_id} is not the pending event"
            )));
        }

        // Only a valid continuation owns redraws produced while its JavaScript event was
        // pending. A stale control call must leave the process-global atomic untouched.
        self.capture_redraw(redraw);
        let pending = self
            .frames
            .last_mut()
            .and_then(|frame| frame.pending.take())
            .expect("the validated active event remains pending");

        let cancelled = default_prevented && pending.guarded.event.cancelable;
        match pending.resume {
            ResumeAction::Normal {
                suppress_default,
                double_click,
                checkable_activation,
                space_key,
                keyboard_edit,
            } => {
                if cancelled {
                    if let Some(activation) = checkable_activation.as_deref()
                        && cancel_guarded_checkable_activation(
                            document,
                            checked_controls,
                            handles,
                            activation,
                        )
                    {
                        self.frames
                            .last_mut()
                            .expect("canceled activation belongs to the active frame")
                            .redraw_requested = true;
                    }
                } else if !suppress_default {
                    if let Some(keyboard_edit) = keyboard_edit {
                        debug_assert!(double_click.is_none());
                        debug_assert!(checkable_activation.is_none());
                        if keyboard_edit.source_was_editor {
                            let edit = PendingEdit {
                                target: pending.guarded.target,
                                intent: keyboard_edit.intent,
                                metadata: pending.guarded.metadata.clone(),
                                action: PendingEditAction::Default {
                                    guarded: Box::new(pending.guarded.clone()),
                                    space_key,
                                },
                            };
                            if let Some(step) =
                                self.stage_text_edit(document, handles, redraw, edit)?
                            {
                                return Ok(step);
                            }
                        } else if !text_edit_element(document, pending.guarded.target.raw) {
                            self.run_default(
                                document,
                                text_controls,
                                checked_controls,
                                handles,
                                pending.guarded,
                                checkable_activation.as_deref(),
                                space_key,
                            )?;
                        }
                        // Keydown fixed whether this occurrence was an edit or an activation.
                        // Listener mutations may invalidate either interpretation, but cannot
                        // turn the same native key into a different default after dispatch.
                    } else {
                        self.run_default(
                            document,
                            text_controls,
                            checked_controls,
                            handles,
                            pending.guarded,
                            checkable_activation.as_deref(),
                            space_key,
                        )?;
                    }
                }
                if let Some(double_click) = double_click {
                    self.frames
                        .last_mut()
                        .expect("double-click follow-up belongs to the active frame")
                        .planned
                        .push_front(PlannedWork::DoubleClick(*double_click));
                }
            }
            ResumeAction::PointerLead {
                pointer_default,
                pointer_fallback_default,
                mouse_data,
                suppressed_release_activation,
                release_auxclick,
                pointer_cancellation_suppresses_default,
                starts_compatibility_mouse,
                suppress_compatibility_mouse,
            } => {
                let pointer_default_prevented =
                    cancelled && pointer_cancellation_suppresses_default;
                if starts_compatibility_mouse && cancelled {
                    self.prevent_compatibility_mouse = true;
                }
                let suppress_mouse =
                    suppress_compatibility_mouse || self.prevent_compatibility_mouse;
                let suppressed_release_activation = suppress_mouse
                    .then(|| {
                        suppressed_release_activation.map(|data| {
                            (
                                pointer_default.default_target,
                                pointer_default.target,
                                *data,
                                pointer_default.metadata.clone(),
                            )
                        })
                    })
                    .flatten();
                if !suppress_mouse
                    && let Some(mouse_data) = mouse_data
                    && let Some(mouse_event) = guard_event_with_target(
                        document,
                        handles,
                        pointer_default.target,
                        mouse_data,
                        pointer_default.metadata.clone(),
                    )?
                {
                    return self.stage(
                        redraw,
                        mouse_event,
                        ResumeAction::PointerMouse {
                            pointer_default,
                            pointer_default_prevented,
                            release_auxclick,
                        },
                    );
                }
                let release_auxclick = release_auxclick.map(|data| {
                    (
                        pointer_default.default_target,
                        pointer_default.target,
                        *data,
                        pointer_default.metadata.clone().into_auxclick(),
                    )
                });
                let (pointer_default, pointer_default_prevented) = if suppress_mouse {
                    let prevented = cancelled
                        && !matches!(
                            &pointer_fallback_default.event.data,
                            DomEventData::PointerUp(_)
                        );
                    (*pointer_fallback_default, prevented)
                } else {
                    (*pointer_default, pointer_default_prevented)
                };
                if !pointer_default_prevented {
                    self.run_default(
                        document,
                        text_controls,
                        checked_controls,
                        handles,
                        pointer_default,
                        None,
                        None,
                    )?;
                }
                self.queue_generated_pointer_release(suppressed_release_activation);
                self.queue_generated_pointer_release(release_auxclick);
            }
            ResumeAction::PointerMouse {
                pointer_default,
                pointer_default_prevented,
                release_auxclick,
            } => {
                let release_auxclick = release_auxclick.map(|data| {
                    (
                        pointer_default.default_target,
                        pointer_default.target,
                        *data,
                        pointer_default.metadata.clone().into_auxclick(),
                    )
                });
                let release_default_survives_mouse_cancellation =
                    matches!(&pointer_default.event.data, DomEventData::PointerUp(_));
                if (!cancelled || release_default_survives_mouse_cancellation)
                    && !pointer_default_prevented
                {
                    if matches!(&pointer_default.event.data, DomEventData::PointerDown(_)) {
                        self.queue_pointer_down_default(document, handles, *pointer_default)?;
                    } else {
                        self.run_default(
                            document,
                            text_controls,
                            checked_controls,
                            handles,
                            *pointer_default,
                            None,
                            None,
                        )?;
                    }
                }
                self.queue_generated_pointer_release(release_auxclick);
            }
            ResumeAction::CompositionStart(edit) => {
                if !self.composition_operation_is_current(&edit) {
                    // A nested native occurrence owns the session now. The stale continuation
                    // must not finish or clear that newer work.
                } else if !node_is_live(edit.target, document, handles) {
                    self.discard_composition(document, handles);
                } else {
                    self.active_composition
                        .as_mut()
                        .expect("compositionstart belongs to an active session")
                        .start_pending = false;
                    let deferred = std::mem::take(&mut self.pending_start_ime);
                    if cancelled {
                        let terminal_index =
                            deferred.iter().position(DeferredImeRequest::is_terminal);
                        self.canceled_composition =
                            terminal_index.is_none().then_some(CanceledComposition {
                                target: edit.target,
                            });
                        if let Some(terminal_index) = terminal_index {
                            self.frames
                                .last_mut()
                                .expect("compositionstart belongs to the active frame")
                                .planned
                                .extend(deferred.into_iter().skip(terminal_index + 1).map(
                                    |request| PlannedWork::DeferredIme {
                                        expected_generation: edit.generation,
                                        expected_completed_frame: None,
                                        request,
                                    },
                                ));
                        }
                        self.close_composition(
                            document,
                            text_controls,
                            handles,
                            edit.metadata.clone(),
                            true,
                        )?;
                    } else {
                        self.canceled_composition = None;
                        let mut after_terminal = false;
                        let planned = &mut self
                            .frames
                            .last_mut()
                            .expect("compositionstart belongs to the active frame")
                            .planned;
                        for request in deferred {
                            let expected_completed_frame =
                                (!after_terminal).then_some(edit.frame_id);
                            after_terminal |= request.is_terminal();
                            planned.push_back(PlannedWork::DeferredIme {
                                expected_generation: edit.generation,
                                expected_completed_frame,
                                request,
                            });
                        }
                        let target = edit.target;
                        let generation = edit.generation;
                        let frame_id = edit.frame_id;
                        let data = edit.data.clone();
                        let metadata = edit.metadata.clone();
                        if let Some(step) = self.stage_composition_event(
                            document,
                            handles,
                            redraw,
                            target,
                            metadata,
                            "compositionupdate",
                            data,
                            ResumeAction::CompositionUpdate(edit),
                        )? {
                            return Ok(step);
                        }
                        if self.active_composition.as_ref().is_some_and(|active| {
                            active.generation == generation
                                && active.target == target
                                && active.pending_frame == Some(frame_id)
                        }) {
                            self.discard_composition(document, handles);
                        }
                    }
                }
            }
            ResumeAction::CompositionUpdate(edit) => {
                if !self.composition_operation_is_current(&edit) {
                    // Superseded by a nested occurrence.
                } else if !node_is_live(edit.target, document, handles) {
                    self.close_composition(
                        document,
                        text_controls,
                        handles,
                        edit.metadata.clone(),
                        true,
                    )?;
                } else if Self::composition_target_is_valid(document, handles, edit.target) {
                    let intent = EditIntent::InsertText {
                        data: edit.data.clone(),
                        is_composing: true,
                    };
                    let metadata = edit.metadata.clone();
                    let pending = PendingEdit {
                        target: edit.target,
                        intent: intent.clone(),
                        metadata: edit.metadata.clone().with_edit_intent(Some(intent)),
                        action: PendingEditAction::CompositionPreedit(edit),
                    };
                    if let Some(step) = self.stage_text_edit(document, handles, redraw, pending)? {
                        return Ok(step);
                    }
                    self.close_composition(document, text_controls, handles, metadata, true)?;
                } else {
                    self.close_composition(
                        document,
                        text_controls,
                        handles,
                        edit.metadata.clone(),
                        true,
                    )?;
                }
            }
            ResumeAction::CompositionEnd => {}
            ResumeAction::TextEdit(edit) => {
                if let PendingEditAction::CompositionPreedit(composition) = &edit.action {
                    if !self.composition_operation_is_current(composition) {
                        // A nested occurrence owns the session now.
                    } else if text_edit_target_accepts(document, handles, edit.target, &edit.intent)
                    {
                        self.run_pending_edit(
                            document,
                            text_controls,
                            checked_controls,
                            handles,
                            *edit,
                        )?;
                    } else {
                        self.close_composition(
                            document,
                            text_controls,
                            handles,
                            composition.metadata.clone(),
                            true,
                        )?;
                    }
                } else if !cancelled
                    && text_edit_target_accepts(document, handles, edit.target, &edit.intent)
                {
                    self.run_pending_edit(
                        document,
                        text_controls,
                        checked_controls,
                        handles,
                        *edit,
                    )?;
                }
            }
        }

        self.advance(document, text_controls, checked_controls, handles, redraw)
    }

    fn abort(
        &mut self,
        document: &mut BaseDocument,
        checked_controls: &mut CheckedControlStates,
        handles: &NodeHandles,
        redraw: &AtomicBool,
        frame_id: u32,
    ) -> bool {
        let Some(index) = self.frames.iter().position(|frame| frame.id == frame_id) else {
            return false;
        };
        // As with resume, only a matching frame can claim an unattached redraw.
        self.capture_redraw(redraw);

        let aborted_frame_owns_composition = self.frames[index..].iter().any(|frame| {
            self.active_composition
                .as_ref()
                .is_some_and(|active| active.pending_frame == Some(frame.id))
        });
        if aborted_frame_owns_composition {
            self.discard_composition(document, handles);
        }

        // Nested dispatch can pre-activate the same input repeatedly. Roll back the youngest
        // transaction first so aborting an outer frame composes to the state before that frame.
        for frame in self.frames[index..].iter_mut().rev() {
            let activation = frame.pending.as_ref().and_then(|pending| {
                if let ResumeAction::Normal {
                    checkable_activation: Some(activation),
                    ..
                } = &pending.resume
                {
                    Some(activation.as_ref())
                } else {
                    None
                }
            });
            if activation.is_some_and(|activation| {
                cancel_guarded_checkable_activation(document, checked_controls, handles, activation)
            }) {
                frame.redraw_requested = true;
            }
        }

        let redraw_requested = self.frames[index..]
            .iter()
            .any(|frame| frame.redraw_requested);
        self.frames.truncate(index);
        if redraw_requested && let Some(parent) = self.frames.last_mut() {
            parent.redraw_requested = true;
        }
        redraw_requested
    }

    fn composition_target_is_valid(
        document: &mut BaseDocument,
        handles: &NodeHandles,
        target: GuardedNode,
    ) -> bool {
        text_edit_target_accepts(
            document,
            handles,
            target,
            &EditIntent::InsertText {
                data: String::new(),
                is_composing: true,
            },
        )
    }

    fn canceled_composition_is_current(
        &self,
        document: &BaseDocument,
        handles: &NodeHandles,
    ) -> bool {
        self.canceled_composition.as_ref().is_some_and(|canceled| {
            node_is_live(canceled.target, document, handles)
                && actual_focus_node_id(document) == Some(canceled.target.raw)
        })
    }

    fn finish_guarded_composition(
        document: &mut BaseDocument,
        handles: &NodeHandles,
        target: GuardedNode,
    ) -> bool {
        if !node_is_live(target, document, handles) {
            return false;
        }
        let mut finished = false;
        document.with_text_input(target.raw, |mut driver| {
            driver.finish_compose();
            finished = true;
        });
        finished
    }

    fn discard_composition(&mut self, document: &mut BaseDocument, handles: &NodeHandles) {
        if let Some(active) = self.active_composition.take()
            && Self::finish_guarded_composition(document, handles, active.target)
            && let Some(frame) = self.frames.last_mut()
        {
            frame.redraw_requested = true;
        }
        self.pending_start_ime.clear();
        self.pending_end_ime.clear();
    }

    fn close_composition(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        handles: &mut NodeHandles,
        metadata: EventMetadata,
        observable: bool,
    ) -> Result<(), DispatchError> {
        let session = self.active_composition.take();
        self.pending_start_ime.clear();
        let deferred = std::mem::take(&mut self.pending_end_ime);
        let Some(ActiveComposition {
            generation,
            target,
            data,
            ..
        }) = session
        else {
            return Ok(());
        };

        self.frames
            .last_mut()
            .expect("composition closure belongs to an active frame")
            .planned
            .extend(
                deferred
                    .into_iter()
                    .map(|request| PlannedWork::DeferredIme {
                        expected_generation: generation,
                        expected_completed_frame: None,
                        request,
                    }),
            );

        if Self::finish_guarded_composition(document, handles, target) {
            text_controls.sync_editor_value(document, target.raw);
            self.frames
                .last_mut()
                .expect("composition closure belongs to an active frame")
                .redraw_requested = true;
        }
        if !observable || !node_is_live(target, document, handles) {
            return Ok(());
        }

        let Some(mut end) = guard_event_with_target(
            document,
            handles,
            target,
            DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                value: String::new(),
            }),
            metadata.into_composition("compositionend", data),
        )?
        else {
            return Ok(());
        };
        end.event.bubbles = true;
        self.frames
            .last_mut()
            .expect("composition closure belongs to an active frame")
            .generated
            .push_back(end);
        Ok(())
    }

    fn composition_operation_is_current(&self, edit: &PendingCompositionEdit) -> bool {
        self.active_composition.as_ref().is_some_and(|active| {
            active.generation == edit.generation
                && active.target == edit.target
                && active.pending_frame == Some(edit.frame_id)
        })
    }

    fn composition_end_is_current(&self, end: &PendingCompositionEnd) -> bool {
        self.active_composition.as_ref().is_some_and(|active| {
            active.generation == end.generation
                && active.target == end.target
                && active.pending_frame == Some(end.frame_id)
        })
    }

    fn absorb_post_terminal_deferred_ime(&mut self, predecessor_generation: u32) {
        let mut moved = Vec::new();
        let planned = &mut self
            .frames
            .last_mut()
            .expect("deferred IME replay belongs to the active frame")
            .planned;
        let mut index = 0;
        while index < planned.len() {
            let moves_to_new_start = matches!(
                &planned[index],
                PlannedWork::DeferredIme {
                    expected_generation,
                    expected_completed_frame: None,
                    ..
                } if *expected_generation == predecessor_generation
            );
            if moves_to_new_start {
                let Some(PlannedWork::DeferredIme { request, .. }) = planned.remove(index) else {
                    unreachable!("the matched deferred IME work remains at this index")
                };
                moved.push(request);
            } else {
                index += 1;
            }
        }
        for request in moved {
            defer_ime_request(&mut self.pending_start_ime, request);
        }
    }

    #[allow(
        clippy::too_many_lines,
        reason = "preedit planning keeps cancellation, target locking, and replay fencing in one transition"
    )]
    fn plan_ime_preedit(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        data: String,
        cursor: Option<(usize, usize)>,
    ) -> Result<(), DispatchError> {
        let frame_id = self
            .frames
            .last()
            .expect("IME preedit planning requires an active frame")
            .id;
        if self.canceled_composition.is_some() {
            if self.canceled_composition_is_current(document, handles) {
                if data.is_empty() {
                    self.canceled_composition = None;
                }
                return Ok(());
            }
            self.canceled_composition = None;
        }
        // The disposition of compositionstart defines whether the whole session may mutate.
        // Preserve records which re-enter from that listener, then replay them in order once its
        // cancellation result is known.
        if self
            .active_composition
            .as_ref()
            .is_some_and(|active| active.start_pending && active.pending_frame != Some(frame_id))
        {
            defer_ime_request(
                &mut self.pending_start_ime,
                DeferredImeRequest::Preedit { data, cursor },
            );
            return Ok(());
        }
        if self
            .active_composition
            .as_ref()
            .is_some_and(|active| active.ending)
        {
            defer_ime_request(
                &mut self.pending_end_ime,
                DeferredImeRequest::Preedit { data, cursor },
            );
            return Ok(());
        }
        let existing = self
            .active_composition
            .as_ref()
            .map(|active| (active.target, active.generation));
        let first = existing.is_none();
        if first && data.is_empty() {
            self.frames
                .last_mut()
                .expect("IME preedit planning requires an active frame")
                .planned
                .push_front(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Focused,
                    data: DomEventData::Ime(BlitzImeEvent::Preedit(String::new(), None)),
                    metadata: EventMetadata::native(),
                });
            return Ok(());
        }
        if let Some((target, generation)) = existing
            && !Self::composition_target_is_valid(document, handles, target)
        {
            let planned = &mut self
                .frames
                .last_mut()
                .expect("IME preedit planning requires an active frame")
                .planned;
            if !data.is_empty() {
                planned.push_front(PlannedWork::DeferredIme {
                    expected_generation: generation,
                    expected_completed_frame: None,
                    request: DeferredImeRequest::Preedit { data, cursor },
                });
            }
            planned.push_front(PlannedWork::ForceCompositionEnd {
                expected_generation: generation,
                metadata: EventMetadata::native(),
            });
            return Ok(());
        }

        let (target, generation) = if let Some(active) = &mut self.active_composition {
            active.pending_frame = Some(frame_id);
            active.ending = data.is_empty();
            (active.target, active.generation)
        } else {
            let Some(target_id) = actual_focus_node_id(document) else {
                return Ok(());
            };
            let Some(target) = guard_node(document, handles, target_id)? else {
                return Ok(());
            };
            if !Self::composition_target_is_valid(document, handles, target) {
                return Ok(());
            }
            let generation = self.allocate_composition_generation()?;
            self.active_composition = Some(ActiveComposition {
                generation,
                target,
                data: String::new(),
                pending_frame: Some(frame_id),
                last_completed_frame: None,
                start_pending: true,
                ending: false,
            });
            (target, generation)
        };
        let metadata = EventMetadata::native();
        let edit = PendingCompositionEdit {
            generation,
            target,
            end_data: data.is_empty().then(String::new),
            data,
            cursor,
            metadata,
            frame_id,
        };
        self.frames
            .last_mut()
            .expect("IME preedit planning requires an active frame")
            .planned
            .push_front(if first {
                PlannedWork::CompositionStart(edit)
            } else {
                PlannedWork::CompositionUpdate(edit)
            });
        Ok(())
    }

    fn plan_active_ime_commit(
        &mut self,
        document: &mut BaseDocument,
        handles: &NodeHandles,
        text: String,
    ) -> bool {
        let frame_id = self
            .frames
            .last()
            .expect("IME commit planning requires an active frame")
            .id;
        if self.canceled_composition.is_some() {
            if self.canceled_composition_is_current(document, handles) {
                self.canceled_composition = None;
                return true;
            }
            self.canceled_composition = None;
        }
        if self
            .active_composition
            .as_ref()
            .is_some_and(|active| active.start_pending && active.pending_frame != Some(frame_id))
        {
            defer_ime_request(
                &mut self.pending_start_ime,
                DeferredImeRequest::Commit(text),
            );
            return true;
        }
        if self
            .active_composition
            .as_ref()
            .is_some_and(|active| active.ending)
        {
            defer_ime_request(&mut self.pending_end_ime, DeferredImeRequest::Commit(text));
            return true;
        }
        let existing = self
            .active_composition
            .as_ref()
            .map(|active| (active.target, active.generation));
        let Some((target, generation)) = existing else {
            return false;
        };
        if !Self::composition_target_is_valid(document, handles, target) {
            let planned = &mut self
                .frames
                .last_mut()
                .expect("IME commit planning requires an active frame")
                .planned;
            planned.push_front(PlannedWork::ForceCompositionEnd {
                expected_generation: generation,
                metadata: EventMetadata::native(),
            });
            return true;
        }
        let metadata = EventMetadata::native();
        let active = self
            .active_composition
            .as_mut()
            .expect("an existing composition session is active");
        active.pending_frame = Some(frame_id);
        active.ending = true;
        let work = if active.data == text {
            PlannedWork::CompositionEnd(PendingCompositionEnd {
                generation,
                target,
                data: text,
                metadata,
                frame_id,
            })
        } else {
            PlannedWork::CompositionUpdate(PendingCompositionEdit {
                generation,
                target,
                data: text.clone(),
                cursor: None,
                metadata,
                frame_id,
                end_data: Some(text),
            })
        };
        self.frames
            .last_mut()
            .expect("IME commit planning requires an active frame")
            .planned
            .push_front(work);
        true
    }

    #[allow(
        clippy::too_many_lines,
        reason = "request planning keeps each native event flavor's state transition adjacent to its queued work"
    )]
    fn plan_request(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        request: DispatchRequest,
    ) -> Result<(), DispatchError> {
        let mut request = request;
        if let Some(button) = physical_pointer_up_button(&request) {
            let bit = MouseEventButtons::from(button);
            if self.ignored_mouse_ups.contains(bit) {
                self.ignored_mouse_ups.remove(bit);
                request = DispatchRequest::Empty;
            }
        }
        request = match request {
            DispatchRequest::Ime(BlitzImeEvent::Preedit(data, cursor)) => {
                return self.plan_ime_preedit(document, handles, data, cursor);
            }
            DispatchRequest::ImeCommit(text) => {
                if self.plan_active_ime_commit(document, handles, text.clone()) {
                    return Ok(());
                }
                if !is_insertable_text(&text) {
                    return Ok(());
                }
                DispatchRequest::ImeCommit(text)
            }
            DispatchRequest::Ime(BlitzImeEvent::Enabled) => {
                self.canceled_composition = None;
                DispatchRequest::Ime(BlitzImeEvent::Enabled)
            }
            DispatchRequest::Ime(BlitzImeEvent::Disabled) => {
                if self.canceled_composition.take().is_some() {
                    return Ok(());
                }
                if let Some(expected_generation) = self
                    .active_composition
                    .as_ref()
                    .map(|active| active.generation)
                {
                    self.frames
                        .last_mut()
                        .expect("IME disable planning requires an active frame")
                        .planned
                        .push_front(PlannedWork::ForceCompositionEnd {
                            expected_generation,
                            metadata: EventMetadata::native(),
                        });
                    return Ok(());
                }
                DispatchRequest::Ime(BlitzImeEvent::Disabled)
            }
            DispatchRequest::PointerCancel {
                event,
                canceled_buttons,
                metadata,
            } => {
                self.stationary_pointer = None;
                self.plan_pointer_cancel(document, handles, &event, canceled_buttons, &metadata)?;
                return Ok(());
            }
            request => request,
        };
        let frame_id = self
            .frames
            .last()
            .expect("begin pushed a frame before planning")
            .id;
        let wheel_transaction = &mut self.wheel_transaction;
        let prevent_compatibility_mouse = &mut self.prevent_compatibility_mouse;
        let mouse_button_presses = &mut self.mouse_button_presses;
        let last_mouse_move = &mut self.last_mouse_move;
        let space_activation_press = &mut self.space_activation_press;
        let planned = &mut self
            .frames
            .last_mut()
            .expect("begin pushed a frame before planning")
            .planned;

        match request {
            DispatchRequest::Empty => {}
            DispatchRequest::StationaryPointerRefresh { event, metadata } => {
                let _ = plan_hover_transitions(document, handles, planned, &event, &metadata)?;
            }
            DispatchRequest::Pointer {
                event,
                flavor,
                mut metadata,
            } => {
                self.stationary_pointer = Some(StationaryPointerSnapshot {
                    event: event.clone(),
                    metadata: metadata.clone(),
                });
                end_wheel_transaction_for_pointer_down(wheel_transaction, flavor);
                if event.is_mouse()
                    && matches!(flavor, PointerFlavor::Move)
                    && let Some(coords) = metadata.pointer.map(|pointer| pointer.coords)
                {
                    let (movement_x, movement_y) = mouse_movement(last_mouse_move, coords);
                    metadata = metadata.with_pointer_movement(movement_x, movement_y);
                }
                let stream = update_pointer_stream_state(
                    prevent_compatibility_mouse,
                    mouse_button_presses,
                    &event,
                    flavor,
                );
                plan_pointer(document, handles, planned, &event, flavor, stream, metadata)?;
            }
            DispatchRequest::OutsidePointer {
                event,
                flavor,
                metadata,
            } => {
                self.stationary_pointer = None;
                // Native backends retain an ordinary mouse stream while a button is held. The
                // pointer may therefore leave the viewport before its move/release records. Keep
                // the stream bookkeeping authoritative without inventing an outside DOM target.
                if mouse_button_presses.iter().any(Option::is_some) {
                    if matches!(flavor, PointerFlavor::Move)
                        && let Some(coords) = metadata.pointer.map(|pointer| pointer.coords)
                    {
                        let _ = mouse_movement(last_mouse_move, coords);
                    }
                    let _ = update_pointer_stream_state(
                        prevent_compatibility_mouse,
                        mouse_button_presses,
                        &event,
                        flavor,
                    );
                    if matches!(exposed_pointer_flavor(&event, flavor), PointerFlavor::Up) {
                        planned.push_back(PlannedWork::Action(DispatchAction::PointerUpState));
                    }
                }
            }
            DispatchRequest::PointerBoundary {
                event,
                boundary,
                metadata,
            } => match boundary {
                NativePointerBoundary::Enter => {
                    self.stationary_pointer = Some(StationaryPointerSnapshot {
                        event: event.clone(),
                        metadata: metadata.clone(),
                    });
                    let _ = plan_hover_transitions(document, handles, planned, &event, &metadata)?;
                }
                NativePointerBoundary::Leave => {
                    self.stationary_pointer = None;
                    let previous = document.get_hover_node_id();
                    // Match browser boundary state during listeners and avoid a delayed clear
                    // wiping hover established by synchronously nested native input.
                    document.clear_hover();
                    *wheel_transaction = None;
                    let _ = plan_hover_transition_between(
                        document, handles, planned, &event, &metadata, previous, None, true,
                    )?;
                }
            },
            DispatchRequest::PointerCancel { .. } => {
                unreachable!("pointer cancellation is planned before borrowing stream fields")
            }
            DispatchRequest::Wheel {
                event,
                metadata,
                occurrence_target,
            } => {
                if let Some(wheel) = metadata.wheel {
                    self.stationary_pointer = Some(StationaryPointerSnapshot {
                        event: BlitzPointerEvent {
                            id: BlitzPointerId::Mouse,
                            is_primary: true,
                            coords: event.coords,
                            button: MouseEventButton::Main,
                            buttons: event.buttons,
                            mods: event.mods,
                            details: PointerDetails::default(),
                            element: ElementPoint::default(),
                        },
                        metadata: EventMetadata::pointer_metadata(
                            metadata.time_stamp,
                            wheel.coords,
                            0,
                            wheel.modifier_bits,
                        ),
                    });
                }
                plan_wheel(
                    document,
                    handles,
                    planned,
                    wheel_transaction,
                    event,
                    metadata,
                    occurrence_target,
                )?;
            }
            DispatchRequest::Key {
                event,
                metadata,
                suppress_default,
            } => {
                let target = guarded_keyboard_target(document, handles)?;
                let intent = keyboard_edit_intent(&event);
                let observe_text_edit = intent.is_some() || keyboard_copy_default(&event);
                let metadata = metadata
                    .with_edit_intent(intent)
                    .with_text_edit_observation(observe_text_edit);
                let space_key = is_space_key(&event).then(|| {
                    if event.state.is_pressed() {
                        SpaceKeyContinuation::Down {
                            observed_generation: space_activation_press
                                .as_ref()
                                .map(|press| press.generation),
                            candidate_generation: frame_id,
                        }
                    } else {
                        SpaceKeyContinuation::Up {
                            press: space_activation_press.take(),
                        }
                    }
                });
                let data = if event.state.is_pressed() {
                    DomEventData::KeyDown(event)
                } else {
                    DomEventData::KeyUp(event)
                };
                planned.push_back(PlannedWork::Enqueue {
                    target: PlannedTarget::Guarded(target),
                    data,
                    metadata,
                    suppress_default,
                    space_key,
                });
            }
            DispatchRequest::Focus(target_id) => {
                plan_programmatic_focus(document, handles, planned, target_id)?;
            }
            DispatchRequest::Blur(target_id) => {
                plan_programmatic_blur(document, handles, planned, target_id)?;
            }
            DispatchRequest::Ime(event) => {
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Focused,
                    data: DomEventData::Ime(event),
                    metadata: EventMetadata::native(),
                });
            }
            DispatchRequest::ImeCommit(text) => plan_ime_commit(planned, text),
            DispatchRequest::AppleStandardKeybinding(command) => {
                let target =
                    guarded_target_or_root(document, handles, document.get_focussed_node_id())?;
                let metadata = EventMetadata::native()
                    .with_edit_intent(apple_standard_keybinding_edit_intent(&command));
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Guarded(target),
                    data: DomEventData::AppleStandardKeybinding(command.into()),
                    metadata,
                });
            }
            DispatchRequest::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            } => {
                let target =
                    guarded_target_or_root(document, handles, actual_focus_node_id(document))?;
                let intent = EditIntent::DeleteByComposition;
                planned.push_back(PlannedWork::TextEdit(PendingEdit {
                    target,
                    intent: intent.clone(),
                    metadata: EventMetadata::native().with_edit_intent(Some(intent)),
                    action: PendingEditAction::ImeDeleteSurrounding {
                        before_bytes,
                        after_bytes,
                    },
                }));
            }
        }

        Ok(())
    }

    fn plan_pointer_cancel(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        event: &BlitzPointerEvent,
        canceled_buttons: MouseEventButtons,
        metadata: &EventMetadata,
    ) -> Result<(), DispatchError> {
        let active_buttons = active_mouse_buttons(&self.mouse_button_presses);
        let interrupted_buttons = active_buttons & canceled_buttons;
        if interrupted_buttons.is_empty() {
            return Ok(());
        }

        let pressed_target = self
            .mouse_button_presses
            .iter()
            .enumerate()
            .find_map(|(index, press)| {
                interrupted_buttons
                    .contains(mouse_button_bit(index))
                    .then_some(press.as_ref()?.author_target?)
            })
            .filter(|target| node_is_live(*target, document, handles));
        let previous_hover = document.get_hover_node_id();
        let hover_target = previous_hover
            .and_then(|target| pointer_author_target_id(document, target))
            .map(|target| guard_node(document, handles, target))
            .transpose()?
            .flatten();
        let target = if let Some(target) = pressed_target.or(hover_target) {
            target
        } else {
            guarded_target_or_root(document, handles, None)?
        };

        // The alpha.6 Blitz event enum has no PointerCancel variant. PointerMove is only an
        // internal payload carrier here; the explicit Quox type/cancelability/default overrides
        // ensure no move identity or default behavior crosses the staged boundary.
        let cancel_metadata = metadata.clone().into_pointer_cancel();
        let planned = &mut self
            .frames
            .last_mut()
            .expect("begin pushed a frame before planning")
            .planned;
        planned.push_back(PlannedWork::Enqueue {
            target: PlannedTarget::Guarded(target),
            data: DomEventData::PointerMove(event.clone()),
            metadata: cancel_metadata,
            suppress_default: true,
            space_key: None,
        });

        // Publish interruption state before JavaScript sees pointercancel, so nested input cannot
        // revive a canceled press or click sequence. Retain the old hover id solely to stage the
        // required pointer-only exit records after pointercancel.
        self.ignored_mouse_ups.insert(active_buttons);
        self.mouse_button_presses.fill(None);
        self.prevent_compatibility_mouse = false;
        self.click_sequence = None;
        self.wheel_transaction = None;
        document.unactive_node();
        document.set_mousedown_node_id(None);
        document.clear_hover();
        let _ = plan_hover_transition_between(
            document,
            handles,
            planned,
            event,
            metadata,
            previous_hover,
            None,
            false,
        )?;
        Ok(())
    }

    #[allow(
        clippy::too_many_lines,
        clippy::cast_possible_truncation,
        reason = "the event-driver loop mirrors pinned Blitz ordering; Blitz stores element coordinates as f32"
    )]
    fn advance(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
    ) -> Result<DispatchStep, DispatchError> {
        loop {
            self.capture_redraw(redraw);
            let Some(frame) = self.frames.last_mut() else {
                return Err(DispatchError::new("quox: no DOM dispatch is active"));
            };
            debug_assert!(frame.pending.is_none());

            if let Some(mut event) = frame.generated.pop_front() {
                if event.metadata.defer_click_target {
                    if !retarget_pointer_click(
                        document,
                        handles,
                        &event.event.data,
                        &event.metadata,
                        &mut event.default_target,
                        &mut event.target,
                    )? {
                        continue;
                    }
                    event.event.target = event.default_target.raw;
                    event.metadata.defer_click_target = false;
                    event.metadata = event
                        .metadata
                        .with_target_offset(document, event.target.raw);
                }
                if suppress_disabled_trusted_pointer_click(document, handles, &event) {
                    // HTML checks disabledness when a user-interaction click reaches the front of
                    // its queue. In particular, a preceding mouseup listener may have changed the
                    // control or fieldset state since the native release was received.
                    continue;
                }
                if matches!(
                    &event.event.data,
                    DomEventData::Focus(_) | DomEventData::FocusIn(_)
                ) && actual_focus_node_id(document) != Some(event.target.raw)
                {
                    // A focus listener may synchronously redirect focus before the paired
                    // focusin record reaches the front of the queue. Do not announce a stale
                    // focus owner after that nested transition completes.
                    continue;
                }
                if let Some(mut event) = freeze_event_path(document, handles, event)? {
                    let suppress_default = event.metadata.suppress_default;
                    let double_click = self.observe_completed_click(&mut event);
                    return self.stage_normal(
                        document,
                        checked_controls,
                        handles,
                        redraw,
                        event,
                        suppress_default,
                        double_click,
                        None,
                    );
                }
                continue;
            }

            let Some(work) = frame.planned.pop_front() else {
                self.capture_redraw(redraw);
                let frame = self
                    .frames
                    .pop()
                    .expect("the active frame remains present until completion");
                return Ok(DispatchStep::Complete {
                    frame_id: frame.id,
                    redraw_requested: frame.redraw_requested,
                });
            };

            match work {
                PlannedWork::Enqueue {
                    target,
                    data,
                    metadata,
                    suppress_default,
                    space_key,
                } => {
                    if let Some(event) =
                        guard_planned_event(document, handles, target, data, metadata)?
                    {
                        return self.stage_normal(
                            document,
                            checked_controls,
                            handles,
                            redraw,
                            event,
                            suppress_default,
                            None,
                            space_key,
                        );
                    }
                }
                PlannedWork::Pointer {
                    default_target,
                    author_target,
                    mut data,
                    pointer_flavor,
                    physical_flavor,
                    suppress_compatibility_mouse,
                    release_press,
                    metadata,
                } => {
                    if !raw_node_is_live(default_target, document, handles)
                        || !node_is_live(author_target, document, handles)
                    {
                        continue;
                    }
                    if data.is_mouse()
                        && matches!(physical_flavor, PointerFlavor::Down)
                        && let Some(press) =
                            self.mouse_button_presses[mouse_button_index(data.button)].as_mut()
                    {
                        press.author_target = Some(author_target);
                    }
                    if let Some(rect) = document.get_client_bounding_rect(default_target.raw) {
                        data.element.x = data.coords.client_x - rect.x as f32;
                        data.element.y = data.coords.client_y - rect.y as f32;
                    }
                    let pointer_data = pointer_dom_data(pointer_flavor, data.clone(), false);
                    let Some(pointer_event) = guard_event_with_targets(
                        document,
                        handles,
                        default_target,
                        author_target,
                        pointer_data,
                        metadata.clone(),
                    )?
                    else {
                        continue;
                    };
                    let physical_data = pointer_dom_data(physical_flavor, data.clone(), false);
                    let Some(pointer_default) = guard_event_with_targets(
                        document,
                        handles,
                        default_target,
                        author_target,
                        physical_data,
                        metadata.clone(),
                    )?
                    else {
                        continue;
                    };
                    let mouse_data = data
                        .is_mouse()
                        .then(|| pointer_dom_data(physical_flavor, data.clone(), true));
                    let chord_transition = matches!(pointer_flavor, PointerFlavor::Move)
                        && !matches!(physical_flavor, PointerFlavor::Move);
                    let starts_compatibility_mouse = data.is_mouse()
                        && data.is_primary
                        && matches!(pointer_flavor, PointerFlavor::Down);
                    let suppressed_release_activation = chord_transition
                        .then(|| match data.button {
                            MouseEventButton::Main => Some(DomEventData::Click(data.clone())),
                            MouseEventButton::Secondary => {
                                Some(DomEventData::ContextMenu(data.clone()))
                            }
                            MouseEventButton::Auxiliary
                            | MouseEventButton::Fourth
                            | MouseEventButton::Fifth => None,
                        })
                        .flatten()
                        .filter(|_| {
                            matches!(physical_flavor, PointerFlavor::Up)
                                && release_press.is_some_and(|press| !press.dragged)
                        })
                        .map(Box::new);
                    let release_auxclick = (data.is_mouse()
                        && matches!(physical_flavor, PointerFlavor::Up)
                        && !matches!(data.button, MouseEventButton::Main)
                        && release_press.is_some_and(|press| !press.dragged))
                    .then(|| Box::new(DomEventData::Click(data.clone())));
                    return self.stage(
                        redraw,
                        pointer_event.clone(),
                        ResumeAction::PointerLead {
                            pointer_default: Box::new(pointer_default),
                            pointer_fallback_default: Box::new(pointer_event),
                            mouse_data,
                            suppressed_release_activation,
                            release_auxclick,
                            pointer_cancellation_suppresses_default: !chord_transition
                                && !matches!(physical_flavor, PointerFlavor::Up),
                            starts_compatibility_mouse,
                            suppress_compatibility_mouse,
                        },
                    );
                }
                PlannedWork::Wheel {
                    default_target,
                    author_target,
                    data,
                    metadata,
                } => {
                    if !raw_node_is_live(default_target, document, handles)
                        || !node_is_live(author_target, document, handles)
                    {
                        continue;
                    }
                    let Some(event) = guard_event_with_targets(
                        document,
                        handles,
                        default_target,
                        author_target,
                        DomEventData::Wheel(data),
                        metadata,
                    )?
                    else {
                        continue;
                    };
                    return self.stage_normal(
                        document,
                        checked_controls,
                        handles,
                        redraw,
                        event,
                        false,
                        None,
                        None,
                    );
                }
                PlannedWork::DefaultOnly {
                    target,
                    data,
                    metadata,
                } => {
                    if let Some(event) =
                        guard_planned_event(document, handles, target, data, metadata)?
                    {
                        let action = match &event.event.data {
                            DomEventData::AppleStandardKeybinding(_)
                            | DomEventData::Ime(BlitzImeEvent::Commit(_)) => {
                                Some(PendingEditAction::Default {
                                    guarded: Box::new(event.clone()),
                                    space_key: None,
                                })
                            }
                            _ => None,
                        };
                        if let (Some(intent), Some(action)) =
                            (event.metadata.edit_intent.clone(), action)
                        {
                            let edit = PendingEdit {
                                target: event.target,
                                intent,
                                metadata: event.metadata.clone(),
                                action,
                            };
                            if let Some(step) =
                                self.stage_text_edit(document, handles, redraw, edit)?
                            {
                                return Ok(step);
                            }
                            continue;
                        }
                        self.run_default(
                            document,
                            text_controls,
                            checked_controls,
                            handles,
                            event,
                            None,
                            None,
                        )?;
                    }
                }
                PlannedWork::GuardedDefault(guarded) => {
                    if matches!(&guarded.event.data, DomEventData::PointerDown(_)) {
                        // Focus listeners run before the pointer default and may invalidate the
                        // layout or target which Blitz re-hits for caret and selection work.
                        document.resolve(0.0);
                        if !node_is_live(guarded.target, document, handles)
                            || !document
                                .get_node(guarded.target.raw)
                                .is_some_and(|node| node.flags.is_in_document())
                        {
                            continue;
                        }
                    }
                    self.run_default(
                        document,
                        text_controls,
                        checked_controls,
                        handles,
                        *guarded,
                        None,
                        None,
                    )?;
                }
                PlannedWork::TextEdit(edit) => {
                    if let Some(step) = self.stage_text_edit(document, handles, redraw, edit)? {
                        return Ok(step);
                    }
                }
                PlannedWork::CompositionStart(edit) => {
                    let current = self.active_composition.as_ref().is_some_and(|active| {
                        active.generation == edit.generation
                            && active.target == edit.target
                            && active.pending_frame == Some(edit.frame_id)
                    });
                    if !current {
                        continue;
                    }
                    if !Self::composition_target_is_valid(document, handles, edit.target) {
                        self.discard_composition(document, handles);
                        continue;
                    }
                    let target = edit.target;
                    let generation = edit.generation;
                    let frame_id = edit.frame_id;
                    let metadata = edit.metadata.clone();
                    if let Some(step) = self.stage_composition_event(
                        document,
                        handles,
                        redraw,
                        target,
                        metadata,
                        "compositionstart",
                        String::new(),
                        ResumeAction::CompositionStart(Box::new(edit)),
                    )? {
                        return Ok(step);
                    }
                    if self.active_composition.as_ref().is_some_and(|active| {
                        active.generation == generation
                            && active.target == target
                            && active.pending_frame == Some(frame_id)
                    }) {
                        self.discard_composition(document, handles);
                    }
                }
                PlannedWork::CompositionUpdate(edit) => {
                    if !self.composition_operation_is_current(&edit) {
                        continue;
                    }
                    if !node_is_live(edit.target, document, handles) {
                        self.close_composition(
                            document,
                            text_controls,
                            handles,
                            edit.metadata.clone(),
                            true,
                        )?;
                        continue;
                    }
                    let target = edit.target;
                    let generation = edit.generation;
                    let frame_id = edit.frame_id;
                    let data = edit.data.clone();
                    let metadata = edit.metadata.clone();
                    if let Some(step) = self.stage_composition_event(
                        document,
                        handles,
                        redraw,
                        target,
                        metadata,
                        "compositionupdate",
                        data,
                        ResumeAction::CompositionUpdate(Box::new(edit)),
                    )? {
                        return Ok(step);
                    }
                    if self.active_composition.as_ref().is_some_and(|active| {
                        active.generation == generation
                            && active.target == target
                            && active.pending_frame == Some(frame_id)
                    }) {
                        self.discard_composition(document, handles);
                    }
                }
                PlannedWork::CompositionEnd(end) => {
                    if !self.composition_end_is_current(&end) {
                        continue;
                    }
                    if !node_is_live(end.target, document, handles) {
                        self.close_composition(
                            document,
                            text_controls,
                            handles,
                            end.metadata.clone(),
                            true,
                        )?;
                        continue;
                    }
                    if Self::finish_guarded_composition(document, handles, end.target) {
                        self.frames
                            .last_mut()
                            .expect("composition end belongs to the active frame")
                            .redraw_requested = true;
                    }
                    text_controls.sync_editor_value(document, end.target.raw);
                    let deferred = std::mem::take(&mut self.pending_end_ime);
                    self.active_composition = None;
                    self.frames
                        .last_mut()
                        .expect("composition end belongs to the active frame")
                        .planned
                        .extend(
                            deferred
                                .into_iter()
                                .map(|request| PlannedWork::DeferredIme {
                                    expected_generation: end.generation,
                                    expected_completed_frame: None,
                                    request,
                                }),
                        );
                    let target = end.target;
                    let data = end.data.clone();
                    let metadata = end.metadata.clone();
                    if let Some(step) = self.stage_composition_event(
                        document,
                        handles,
                        redraw,
                        target,
                        metadata,
                        "compositionend",
                        data,
                        ResumeAction::CompositionEnd,
                    )? {
                        return Ok(step);
                    }
                }
                PlannedWork::ForceCompositionEnd {
                    expected_generation,
                    metadata,
                } => {
                    if self
                        .active_composition
                        .as_ref()
                        .is_some_and(|active| active.generation == expected_generation)
                    {
                        self.close_composition(document, text_controls, handles, metadata, true)?;
                    }
                }
                PlannedWork::CompositionOccurrenceComplete {
                    generation,
                    target,
                    frame_id,
                } => {
                    if let Some(active) = &mut self.active_composition
                        && active.generation == generation
                        && active.target == target
                        && active.pending_frame == Some(frame_id)
                    {
                        active.pending_frame = None;
                        active.last_completed_frame = Some(frame_id);
                    }
                }
                PlannedWork::DeferredIme {
                    expected_generation,
                    expected_completed_frame,
                    request,
                } => {
                    let current_or_uncontested = self.active_composition.as_ref().map_or_else(
                        || {
                            expected_completed_frame.is_none()
                                && self.latest_composition_generation == Some(expected_generation)
                        },
                        |active| {
                            active.generation == expected_generation
                                && expected_completed_frame.is_none_or(|frame_id| {
                                    active.last_completed_frame == Some(frame_id)
                                })
                        },
                    );
                    if !current_or_uncontested {
                        continue;
                    }
                    let predecessor_generation = expected_generation;
                    match request {
                        DeferredImeRequest::Preedit { data, cursor } => {
                            self.plan_ime_preedit(document, handles, data, cursor)?;
                        }
                        DeferredImeRequest::Commit(text) => {
                            if !self.plan_active_ime_commit(document, handles, text.clone())
                                && is_insertable_text(&text)
                            {
                                plan_ime_commit(
                                    &mut self
                                        .frames
                                        .last_mut()
                                        .expect("deferred IME work belongs to the active frame")
                                        .planned,
                                    text,
                                );
                            }
                        }
                    }
                    if self.active_composition.as_ref().is_some_and(|active| {
                        active.generation != predecessor_generation && active.start_pending
                    }) {
                        self.absorb_post_terminal_deferred_ime(predecessor_generation);
                    }
                }
                PlannedWork::DoubleClick(pending) => {
                    if !node_is_live(pending.target, document, handles)
                        || !document
                            .get_node(pending.target.raw)
                            .is_some_and(|node| node.flags.is_in_document())
                    {
                        continue;
                    }
                    let Some(event) = guard_event_with_target(
                        document,
                        handles,
                        pending.target,
                        DomEventData::DoubleClick(pending.event),
                        pending.metadata,
                    )?
                    else {
                        continue;
                    };
                    return self.stage_normal(
                        document,
                        checked_controls,
                        handles,
                        redraw,
                        event,
                        false,
                        None,
                        None,
                    );
                }
                PlannedWork::Action(action) => {
                    self.run_action(document, text_controls, handles, action)?;
                }
            }
        }
    }

    fn stage(
        &mut self,
        redraw: &AtomicBool,
        event: GuardedDomEvent,
        resume: ResumeAction,
    ) -> Result<DispatchStep, DispatchError> {
        let event_id = self.allocate_event_id()?;
        Ok(self.finish_stage(redraw, event_id, event, resume))
    }

    fn stage_text_edit(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
        edit: PendingEdit,
    ) -> Result<Option<DispatchStep>, DispatchError> {
        if !text_edit_target_accepts(document, handles, edit.target, &edit.intent) {
            return Ok(None);
        }
        let metadata = edit.metadata.clone().into_before_input(edit.intent.clone());
        let Some(mut event) = guard_event_with_target(
            document,
            handles,
            edit.target,
            DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                value: String::new(),
            }),
            metadata,
        )?
        else {
            return Ok(None);
        };
        // Pinned Blitz's Input shape already bubbles, but this synthetic browser event owns its
        // contract rather than inheriting it from the private payload carrier.
        event.event.bubbles = true;
        Ok(Some(self.stage(
            redraw,
            event,
            ResumeAction::TextEdit(Box::new(edit)),
        )?))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "composition staging carries the guarded target, causal metadata, payload, and continuation"
    )]
    fn stage_composition_event(
        &mut self,
        document: &BaseDocument,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
        target: GuardedNode,
        metadata: EventMetadata,
        event_type: &'static str,
        data: String,
        resume: ResumeAction,
    ) -> Result<Option<DispatchStep>, DispatchError> {
        let Some(mut event) = guard_event_with_target(
            document,
            handles,
            target,
            DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                value: String::new(),
            }),
            metadata.into_composition(event_type, data),
        )?
        else {
            return Ok(None);
        };
        event.event.bubbles = true;
        Ok(Some(self.stage(redraw, event, resume)?))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "normal event staging also owns event-specific pre-dispatch activation"
    )]
    fn stage_normal(
        &mut self,
        document: &mut BaseDocument,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
        event: GuardedDomEvent,
        mut suppress_default: bool,
        double_click: Option<Box<PendingDoubleClick>>,
        space_key: Option<SpaceKeyContinuation>,
    ) -> Result<DispatchStep, DispatchError> {
        // Allocate every fallible dispatch identifier before applying state which JavaScript can
        // observe. A failed stage must never strand a checkbox in its pre-activated state.
        let event_id = self.allocate_event_id()?;
        let checkable_activation = if !suppress_default
            && event.metadata.event_type_override.is_none()
            && matches!(
                &event.event.data,
                DomEventData::Click(BlitzPointerEvent {
                    button: MouseEventButton::Main,
                    ..
                })
            ) {
            let prepared = checked_controls.prepare_legacy_activation(document, event.target.raw);
            if let Some(state) = prepared {
                debug_assert_eq!(state.target(), event.target.raw);
                if is_html_actually_disabled(document, event.target.raw) {
                    // Native queued clicks are filtered before staging, while internally
                    // generated clicks can remain observable. Neither path may activate a
                    // disabled form control.
                    suppress_default = true;
                    None
                } else {
                    // The previous member can be destroyed and its raw slab slot reused while the
                    // click listener runs. Guard it before applying any pre-click mutation.
                    let previous_radio = state
                        .previous_radio()
                        .map(|target| {
                            guard_node(document, handles, target)?.ok_or_else(|| {
                                DispatchError::new(
                                    "quox: the checked radio disappeared before click dispatch",
                                )
                            })
                        })
                        .transpose()?;
                    if checked_controls.apply_legacy_activation(document, &state) {
                        self.frames
                            .last_mut()
                            .expect("events are staged only for an active frame")
                            .redraw_requested = true;
                    }
                    Some(Box::new(GuardedCheckableActivation {
                        state,
                        target: event.target,
                        previous_radio,
                    }))
                }
            } else {
                None
            }
        } else {
            None
        };
        let keyboard_edit = matches!(&event.event.data, DomEventData::KeyDown(_))
            .then(|| event.metadata.edit_intent.clone())
            .flatten()
            .map(|intent| KeyboardEditContinuation {
                intent,
                source_was_editor: editor_edit_snapshot(document, event.target.raw).is_some(),
            });
        let resume = ResumeAction::Normal {
            suppress_default,
            double_click,
            checkable_activation,
            space_key,
            keyboard_edit,
        };
        Ok(self.finish_stage(redraw, event_id, event, resume))
    }

    fn finish_stage(
        &mut self,
        redraw: &AtomicBool,
        event_id: u32,
        event: GuardedDomEvent,
        resume: ResumeAction,
    ) -> DispatchStep {
        let frame = self
            .frames
            .last_mut()
            .expect("events are staged only for an active frame");
        let step = DispatchEventStep {
            frame_id: frame.id,
            event_id,
            event_type: event
                .metadata
                .event_type_override
                .unwrap_or_else(|| event.event.name())
                .to_owned(),
            target: event.target.handle,
            path: event.path.iter().map(|node| node.handle).collect(),
            bubbles: event.event.bubbles,
            cancelable: event.event.cancelable,
            composed: match event.metadata.shape_override {
                Some(EventShapeOverride::PlainChange) => false,
                Some(EventShapeOverride::PlainInput) => true,
                None => event_is_composed(&event.event.data),
            },
            time_stamp: event.metadata.time_stamp,
            payload: match event.metadata.shape_override {
                Some(EventShapeOverride::PlainInput | EventShapeOverride::PlainChange) => None,
                None => event_payload(&event.event.data, &event.metadata).map(Box::new),
            },
        };
        frame.pending = Some(PendingEvent {
            id: event_id,
            guarded: event,
            resume,
        });
        self.capture_redraw(redraw);
        DispatchStep::Event(step)
    }

    fn observe_completed_click(
        &mut self,
        event: &mut GuardedDomEvent,
    ) -> Option<Box<PendingDoubleClick>> {
        let DomEventData::Click(pointer) = &event.event.data else {
            return None;
        };
        let Some(PointerReleaseClick::Matched { .. }) = event.metadata.pointer_release_click else {
            return None;
        };
        let native_detail = event.metadata.pointer?.detail;
        let button = mouse_button_number(pointer.button);
        let previous = self.click_sequence;
        let consecutive = previous.is_some_and(|previous| {
            previous.button == button
                && previous.target == event.target
                && native_detail > 1
                && previous.native_detail.checked_add(1) == Some(native_detail)
        });
        let detail = if consecutive {
            previous
                .expect("a consecutive click has a previous occurrence")
                .detail
                .saturating_add(1)
                .min(UI_EVENT_DETAIL_MAX)
        } else {
            1
        };
        self.click_sequence = Some(ClickSequence {
            button,
            target: event.target,
            native_detail,
            detail,
        });
        event.metadata.click_detail = Some(detail);

        if button != 0 || detail != 2 {
            return None;
        }
        let mut metadata = event.metadata.clone().with_click_detail(2);
        metadata.pointer_release_click = None;
        metadata.event_type_override = None;
        metadata.suppress_default = false;
        metadata.defer_click_target = false;
        Some(Box::new(PendingDoubleClick {
            target: event.target,
            event: pointer.clone(),
            metadata,
        }))
    }

    fn queue_generated_pointer_release(
        &mut self,
        release: Option<(GuardedRawNode, GuardedNode, DomEventData, EventMetadata)>,
    ) {
        let Some((default_target, author_target, data, metadata)) = release else {
            return;
        };
        let mut metadata = metadata;
        metadata.defer_click_target = true;
        self.frames
            .last_mut()
            .expect("pointer releases run only for an active frame")
            .generated
            .push_back(GuardedDomEvent {
                event: DomEvent::new(default_target.raw, data),
                default_target,
                target: author_target,
                path: Vec::new(),
                metadata,
            });
    }

    fn queue_pointer_down_default(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        guarded: GuardedDomEvent,
    ) -> Result<(), DispatchError> {
        // Mouse focus is the mousedown default, so listener mutations must be visible before
        // choosing the nearest click-focusable ancestor. Keep Blitz's selection work behind the
        // staged focus events so a focus listener runs before the ensuing caret placement.
        document.resolve(0.0);
        let destination = nearest_click_focusable_ancestor(document, handles, guarded.target)?;
        let old_focus = actual_focus_node_id(document)
            .map(|target| guard_node(document, handles, target))
            .transpose()?
            .flatten();
        let metadata = guarded.metadata.clone();
        let planned = &mut self
            .frames
            .last_mut()
            .expect("pointer defaults run only for an active frame")
            .planned;
        let focuses = matches!(
            &guarded.event.data,
            DomEventData::PointerDown(BlitzPointerEvent {
                button: MouseEventButton::Main
                    | MouseEventButton::Auxiliary
                    | MouseEventButton::Secondary,
                ..
            })
        );
        planned.push_front(PlannedWork::GuardedDefault(Box::new(guarded)));
        if !focuses {
            return Ok(());
        }
        if old_focus == destination {
            return Ok(());
        }
        if let Some(destination) = destination {
            planned.push_front(PlannedWork::Action(DispatchAction::GainFocus {
                target: destination,
                related_target: old_focus,
                metadata: metadata.clone(),
            }));
        }
        if let Some(old_focus) = old_focus {
            planned.push_front(PlannedWork::Action(DispatchAction::LoseFocus {
                target: old_focus,
                related_target: destination,
                metadata,
            }));
        }
        Ok(())
    }

    fn queue_focus_default(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        destination: GuardedNode,
        metadata: EventMetadata,
    ) -> Result<(), DispatchError> {
        document.resolve(0.0);
        if !node_is_live(destination, document, handles)
            || !is_programmatically_focusable(document, destination.raw)
        {
            return Ok(());
        }
        let old_focus = actual_focus_node_id(document)
            .map(|target| guard_node(document, handles, target))
            .transpose()?
            .flatten();
        if old_focus == Some(destination) {
            return Ok(());
        }
        let planned = &mut self
            .frames
            .last_mut()
            .expect("focus defaults run only for an active frame")
            .planned;
        planned.push_front(PlannedWork::Action(DispatchAction::GainFocus {
            target: destination,
            related_target: old_focus,
            metadata: metadata.clone(),
        }));
        if let Some(old_focus) = old_focus {
            planned.push_front(PlannedWork::Action(DispatchAction::LoseFocus {
                target: old_focus,
                related_target: Some(destination),
                metadata,
            }));
        }
        Ok(())
    }

    fn queue_tab_focus_default(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        backwards: bool,
        metadata: EventMetadata,
    ) -> Result<(), DispatchError> {
        document.resolve(0.0);
        let Some(destination) =
            sequential_focus_target(document, actual_focus_node_id(document), backwards)
        else {
            return Ok(());
        };
        let Some(destination) = guard_node(document, handles, destination)? else {
            return Ok(());
        };
        self.queue_focus_default(document, handles, destination, metadata)
    }

    fn queue_keyboard_activation_default(
        &mut self,
        document: &BaseDocument,
        handles: &mut NodeHandles,
        target: GuardedNode,
        key_event: &blitz_traits::events::BlitzKeyEvent,
        metadata: EventMetadata,
    ) -> Result<(), DispatchError> {
        let click_modifiers = metadata.key.as_ref().map_or(key_event.modifiers, |key| {
            super::build_pointer_modifiers(pointer_modifier_bits_from_key(key.modifier_bits))
        });
        let click = BlitzPointerEvent {
            id: BlitzPointerId::Mouse,
            is_primary: false,
            coords: super::pointer_coords(0.0, 0.0, 0.0, 0.0),
            button: MouseEventButton::Main,
            buttons: MouseEventButtons::None,
            mods: click_modifiers,
            details: PointerDetails::default(),
            element: ElementPoint::default(),
        };
        let event = DomEvent::new(target.raw, DomEventData::Click(click));
        if let Some(event) =
            guard_queued_event(document, handles, event, metadata.with_edit_intent(None))?
        {
            self.frames
                .last_mut()
                .expect("keyboard defaults run only for an active frame")
                .generated
                .push_back(event);
        }
        Ok(())
    }

    #[allow(
        clippy::too_many_arguments,
        clippy::too_many_lines,
        reason = "default reconciliation keeps native mutations and their staged follow-ups atomic"
    )]
    fn run_default(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        mut guarded: GuardedDomEvent,
        protected_checked_activation: Option<&GuardedCheckableActivation>,
        space_key: Option<SpaceKeyContinuation>,
    ) -> Result<(), DispatchError> {
        if let Some(tab_default) = tab_key_default(&guarded.event.data) {
            return match tab_default {
                TabKeyDefault::Traverse { backwards } => {
                    self.queue_tab_focus_default(document, handles, backwards, guarded.metadata)
                }
                TabKeyDefault::SuppressKeyUp => Ok(()),
            };
        }
        if let Some(space_event) = space_key_event(&guarded.event.data) {
            document.resolve(0.0);
            let activation_control = is_space_activation_control(document, guarded.target.raw);
            match (space_event, space_key) {
                (
                    SpaceKeyEvent::Down(event),
                    Some(SpaceKeyContinuation::Down {
                        observed_generation,
                        candidate_generation,
                    }),
                ) => {
                    let occurrence_still_current = self
                        .space_activation_press
                        .as_ref()
                        .map(|press| press.generation)
                        == observed_generation;
                    if event.is_auto_repeating {
                        if (occurrence_still_current && self.space_activation_press.is_some())
                            || activation_control
                        {
                            return Ok(());
                        }
                    } else if occurrence_still_current {
                        self.space_activation_press = None;
                        if !event.is_composing
                            && node_is_live(guarded.target, document, handles)
                            && actual_focus_node_id(document) == Some(guarded.target.raw)
                            && let Some(kind) = space_activation_kind(document, guarded.target.raw)
                        {
                            self.space_activation_press = Some(SpaceActivationPress {
                                target: guarded.target,
                                generation: candidate_generation,
                                kind,
                            });
                            return Ok(());
                        }
                        if activation_control {
                            return Ok(());
                        }
                    } else if activation_control {
                        // A nested key dispatch established newer state while this listener was
                        // running. Suppress only this control's pinned default and leave the
                        // nested press untouched.
                        return Ok(());
                    }
                }
                (SpaceKeyEvent::Up(event), Some(SpaceKeyContinuation::Up { press })) => {
                    if !event.is_composing
                        && press.is_some_and(|press| {
                            press.target == guarded.target
                                && node_is_live(press.target, document, handles)
                                && actual_focus_node_id(document) == Some(press.target.raw)
                                && space_activation_kind(document, press.target.raw)
                                    == Some(press.kind)
                        })
                    {
                        return self.queue_keyboard_activation_default(
                            document,
                            handles,
                            guarded.target,
                            event,
                            guarded.metadata,
                        );
                    }
                    if press.is_some() || activation_control {
                        return Ok(());
                    }
                }
                (SpaceKeyEvent::Down(_) | SpaceKeyEvent::Up(_), _) => {
                    if activation_control {
                        return Ok(());
                    }
                }
            }
        }
        if !node_is_live(guarded.target, document, handles) {
            return Ok(());
        }
        if let Some(key_event) = enter_keydown(&guarded.event.data) {
            document.resolve(0.0);
            if is_enter_activatable(document, guarded.target.raw) {
                return self.queue_keyboard_activation_default(
                    document,
                    handles,
                    guarded.target,
                    key_event,
                    guarded.metadata,
                );
            }
            if suppress_ineligible_enter_default(document, guarded.target.raw) {
                return Ok(());
            }
        }
        let needs_element_target = event_has_element_target(&guarded.event.data);
        let raw_target_is_usable = guarded.is_default_target_live(document, handles)
            && (!needs_element_target
                || pointer_author_target_id(document, guarded.default_target.raw)
                    == Some(guarded.target.raw));
        if !raw_target_is_usable {
            if !needs_element_target {
                return Ok(());
            }
            // A listener may replace the glyph which was hit while leaving the frozen author
            // target alive. Retarget only Blitz's internal default to that same element; never
            // run a default against a new occupant of the stale raw node id.
            guarded.event.target = guarded.target.raw;
            guarded.default_target = GuardedRawNode::from_public(guarded.target);
        }

        let old_focus = actual_focus_node_id(document);
        let editor_before = guarded
            .metadata
            .observe_text_edit
            .then(|| editor_edit_snapshot(document, guarded.target.raw));
        let preserve_focus = default_must_preserve_focus(document, &guarded);
        let original_shell = install_ime_suppressing_shell(document, preserve_focus);
        let mut source_metadata = guarded.metadata.clone();
        let label_default = label_click_default(document, &guarded);
        let viewport_scroll_before_default = document.viewport_scroll();
        let file_input_snapshot = file_input_default_snapshot(document, &guarded);
        let mut generated = Vec::new();
        let protected_checked_target =
            protected_checked_activation.map(|activation| activation.target);
        let temporary_radio_name = install_temporary_radio_name(document, protected_checked_target);
        run_engine_or_label_default(
            document,
            &mut guarded,
            label_default,
            &mut source_metadata,
            &mut generated,
        );
        restore_temporary_radio_name(document, temporary_radio_name);
        preserve_default_focus(document, &mut generated, old_focus, preserve_focus);
        restore_shell_provider(document, original_shell);
        if document.viewport_scroll() != viewport_scroll_before_default {
            generated.push(viewport_scroll_event(document));
        }
        let changed_file_input = file_input_snapshot.and_then(|snapshot| {
            let changed = reconcile_file_input_default(document, &snapshot);
            restore_file_input_value_attribute(
                document,
                snapshot.target,
                snapshot.authored_value.as_deref(),
            );
            text_controls.sanitize_file_input_label(document, snapshot.target);
            changed.then_some(snapshot.target)
        });
        if let Some(target) = changed_file_input {
            generated.push(DomEvent::new(
                target,
                DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                    value: String::new(),
                }),
            ));
            self.frames
                .last_mut()
                .expect("file defaults run only for an active frame")
                .redraw_requested = true;
        }
        let checkedness_changed = reconcile_generated_checkable_defaults(
            document,
            checked_controls,
            handles,
            &generated,
            protected_checked_target,
        );
        let protected_checkable_default = protected_checkable_default(
            document,
            checked_controls,
            handles,
            protected_checked_activation,
        );
        if checkedness_changed {
            self.frames
                .last_mut()
                .expect("defaults run only for an active frame")
                .redraw_requested = true;
        }
        // Blitz mutates Parley before returning generated events. Capture the live editor value
        // now so the first JavaScript `input` listener observes the edit which caused it.
        text_controls.sync_editor_value(document, guarded.target.raw);
        if let Some(before) = editor_before {
            let after = editor_edit_snapshot(document, guarded.target.raw);
            if before == after {
                generated.retain(|event| !matches!(&event.data, DomEventData::Input(_)));
            }
        }
        let new_focus = actual_focus_node_id(document);
        let (old_focus, new_focus) = if generated.iter().any(|event| is_focus_event(&event.data)) {
            let old_focus = old_focus
                .map(|target| guard_node(document, handles, target))
                .transpose()?
                .flatten();
            let new_focus = new_focus
                .map(|target| guard_node(document, handles, target))
                .transpose()?
                .flatten();
            (old_focus, new_focus)
        } else {
            (None, None)
        };
        let guarded_generated = guard_generated_default_events(
            document,
            handles,
            generated,
            &source_metadata,
            (old_focus, new_focus),
            protected_checkable_default,
            changed_file_input,
        )?;
        self.frames
            .last_mut()
            .expect("defaults run only for an active frame")
            .generated
            .extend(guarded_generated);
        if guarded.metadata.label_activation {
            self.queue_focus_default(document, handles, guarded.target, source_metadata)?;
        }
        Ok(())
    }

    #[allow(
        clippy::too_many_lines,
        reason = "editing defaults keep snapshot, mutation, generated input, and composition follow-up adjacent"
    )]
    fn run_pending_edit(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        checked_controls: &mut CheckedControlStates,
        handles: &mut NodeHandles,
        edit: PendingEdit,
    ) -> Result<(), DispatchError> {
        match edit.action {
            PendingEditAction::Default { guarded, space_key } => self.run_default(
                document,
                text_controls,
                checked_controls,
                handles,
                *guarded,
                None,
                space_key,
            ),
            PendingEditAction::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            } => {
                if let Some(event) =
                    apply_ime_delete_surrounding(document, before_bytes, after_bytes)
                {
                    text_controls.sync_editor_value(document, edit.target.raw);
                    self.frames
                        .last_mut()
                        .expect("text edits run only for an active frame")
                        .redraw_requested = true;
                    let metadata = edit.metadata.with_edit_intent(Some(edit.intent));
                    if let Some(event) = guard_queued_event(document, handles, event, metadata)? {
                        self.frames
                            .last_mut()
                            .expect("text edits run only for an active frame")
                            .generated
                            .push_back(event);
                    }
                }
                Ok(())
            }
            PendingEditAction::CompositionPreedit(edit) => {
                let edit = *edit;
                if !self.composition_operation_is_current(&edit) {
                    return Ok(());
                }
                if !Self::composition_target_is_valid(document, handles, edit.target) {
                    self.close_composition(
                        document,
                        text_controls,
                        handles,
                        edit.metadata.clone(),
                        true,
                    )?;
                    return Ok(());
                }
                let metadata =
                    edit.metadata
                        .clone()
                        .with_edit_intent(Some(EditIntent::InsertText {
                            data: edit.data.clone(),
                            is_composing: true,
                        }));
                let Some(preedit) = guard_event_with_target(
                    document,
                    handles,
                    edit.target,
                    DomEventData::Ime(BlitzImeEvent::Preedit(edit.data.clone(), edit.cursor)),
                    edit.metadata.clone(),
                )?
                else {
                    if self.composition_operation_is_current(&edit) {
                        self.discard_composition(document, handles);
                    }
                    return Ok(());
                };
                self.run_default(
                    document,
                    text_controls,
                    checked_controls,
                    handles,
                    preedit,
                    None,
                    None,
                )?;
                let after = editor_edit_snapshot(document, edit.target.raw);
                if !self.composition_operation_is_current(&edit) {
                    return Ok(());
                }
                if let Some(active) = &mut self.active_composition
                    && active.generation == edit.generation
                    && active.target == edit.target
                    && active.pending_frame == Some(edit.frame_id)
                {
                    active.data.clone_from(&edit.data);
                }
                // Input Events requires every surfaced compositionupdate to be followed by the
                // non-cancelable beforeinput/input pair, even when the native update only moves
                // the composition cursor and leaves the passage text unchanged.
                if let Some(after) = after {
                    let input = DomEvent::new(
                        edit.target.raw,
                        DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                            value: after.value,
                        }),
                    );
                    if let Some(input) = guard_queued_event(document, handles, input, metadata)? {
                        self.frames
                            .last_mut()
                            .expect("composition edits belong to the active frame")
                            .generated
                            .push_back(input);
                    }
                }
                let work = edit.end_data.map_or(
                    PlannedWork::CompositionOccurrenceComplete {
                        generation: edit.generation,
                        target: edit.target,
                        frame_id: edit.frame_id,
                    },
                    |data| {
                        PlannedWork::CompositionEnd(PendingCompositionEnd {
                            generation: edit.generation,
                            target: edit.target,
                            data,
                            metadata: edit.metadata,
                            frame_id: edit.frame_id,
                        })
                    },
                );
                self.frames
                    .last_mut()
                    .expect("composition edits belong to the active frame")
                    .planned
                    .push_front(work);
                Ok(())
            }
        }
    }

    #[allow(
        clippy::too_many_lines,
        reason = "native defaults keep each focus and pointer state transition adjacent to its guards"
    )]
    fn run_action(
        &mut self,
        document: &mut BaseDocument,
        text_controls: &mut TextControlStates,
        handles: &mut NodeHandles,
        action: DispatchAction,
    ) -> Result<(), DispatchError> {
        match action {
            DispatchAction::PointerDownState(hover) => {
                let target_is_live = hover
                    .default_target
                    .is_some_and(|target| raw_node_is_live(target, document, handles));
                if target_is_live && document.get_hover_node_id() == hover.raw {
                    document.active_node();
                    document.set_mousedown_node_id(hover.raw);
                } else {
                    document.set_mousedown_node_id(None);
                }
            }
            DispatchAction::PointerUpState => {
                document.unactive_node();
            }
            DispatchAction::ClearHover => {
                self.wheel_transaction = None;
                document.clear_hover();
            }
            DispatchAction::LoseFocus {
                target,
                related_target,
                metadata,
            } => {
                if self
                    .canceled_composition
                    .as_ref()
                    .is_some_and(|canceled| canceled.target == target)
                {
                    self.canceled_composition = None;
                }
                if self
                    .active_composition
                    .as_ref()
                    .is_some_and(|active| active.target == target)
                {
                    self.close_composition(
                        document,
                        text_controls,
                        handles,
                        metadata.clone(),
                        true,
                    )?;
                }
                if actual_focus_node_id(document) != Some(target.raw)
                    || !node_is_live(target, document, handles)
                {
                    return Ok(());
                }
                text_controls.sync_editor_value(document, target.raw);
                self.space_activation_press = None;
                document.clear_focus();
                self.frames
                    .last_mut()
                    .expect("focus changes run only for an active frame")
                    .redraw_requested = true;
                let generated =
                    guard_focus_pair(document, handles, target, related_target, metadata, false)?;
                self.frames
                    .last_mut()
                    .expect("focus changes run only for an active frame")
                    .generated
                    .extend(generated);
            }
            DispatchAction::GainFocus {
                target,
                related_target,
                metadata,
            } => {
                // Loss-event listeners can focus another element, detach the requested target,
                // or make it unfocusable. Browser focus steps must honor that synchronous work
                // instead of stealing focus back when the outer transition resumes.
                document.resolve(0.0);
                if actual_focus_node_id(document).is_some()
                    || !node_is_live(target, document, handles)
                    || !is_programmatically_focusable(document, target.raw)
                    || !document.set_focus_to(target.raw)
                {
                    return Ok(());
                }
                self.canceled_composition = None;

                if self
                    .active_composition
                    .as_ref()
                    .is_some_and(|active| active.target != target)
                {
                    self.close_composition(
                        document,
                        text_controls,
                        handles,
                        metadata.clone(),
                        true,
                    )?;
                }

                self.space_activation_press = None;
                self.frames
                    .last_mut()
                    .expect("focus changes run only for an active frame")
                    .redraw_requested = true;
                let generated =
                    guard_focus_pair(document, handles, target, related_target, metadata, true)?;
                self.frames
                    .last_mut()
                    .expect("focus changes run only for an active frame")
                    .generated
                    .extend(generated);
            }
        }
        Ok(())
    }

    fn capture_redraw(&mut self, redraw: &AtomicBool) {
        if redraw.swap(false, Ordering::Relaxed)
            && let Some(frame) = self.frames.last_mut()
        {
            frame.redraw_requested = true;
        }
    }

    fn discard_failed_frame(
        &mut self,
        document: &mut BaseDocument,
        handles: &NodeHandles,
        frame_id: u32,
        redraw: &AtomicBool,
    ) {
        let Some(index) = self.frames.iter().position(|frame| frame.id == frame_id) else {
            return;
        };
        let discarded_frame_owns_composition = self.frames[index..].iter().any(|frame| {
            self.active_composition
                .as_ref()
                .is_some_and(|active| active.pending_frame == Some(frame.id))
        });
        if discarded_frame_owns_composition {
            self.discard_composition(document, handles);
        }
        let redraw_requested = self.frames[index..]
            .iter()
            .any(|frame| frame.redraw_requested);
        self.frames.truncate(index);
        if redraw_requested {
            if let Some(parent) = self.frames.last_mut() {
                parent.redraw_requested = true;
            } else {
                // A failed top-level begin has no completion step through which to report paint
                // ownership. Restore the atomic request so the ordinary render pump sees it.
                redraw.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[derive(Debug, PartialEq)]
struct EditorEditSnapshot {
    value: String,
    selection: std::ops::Range<usize>,
}

fn editor_edit_snapshot(document: &mut BaseDocument, target: usize) -> Option<EditorEditSnapshot> {
    let mut snapshot = None;
    document.with_text_input(target, |driver| {
        snapshot = Some(EditorEditSnapshot {
            value: driver.editor.raw_text().to_owned(),
            selection: driver.editor.raw_selection().text_range(),
        });
    });
    snapshot
}

fn text_edit_target_accepts(
    document: &mut BaseDocument,
    handles: &NodeHandles,
    target: GuardedNode,
    intent: &EditIntent,
) -> bool {
    if !node_is_live(target, document, handles)
        || actual_focus_node_id(document) != Some(target.raw)
        || is_html_actually_disabled(document, target.raw)
    {
        return false;
    }
    let Some(node) = document.get_node(target.raw) else {
        return false;
    };
    if !node.flags.is_in_document() {
        return false;
    }
    let Some(element) = node.element_data() else {
        return false;
    };
    if !text_edit_element(document, target.raw) || element.has_attr(local_name!("readonly")) {
        return false;
    }
    if matches!(intent, EditIntent::InsertLineBreak)
        && !(element.name.ns == ns!(html) && element.name.local.as_ref() == "textarea")
    {
        // Enter activates/submits single-line controls; it is not a text insertion there.
        return false;
    }
    editor_edit_snapshot(document, target.raw).is_some()
}

fn text_edit_element(document: &BaseDocument, target: usize) -> bool {
    document
        .get_node(target)
        .and_then(blitz_dom::Node::element_data)
        .is_some_and(|element| {
            element.name.ns == ns!(html)
                && match element.name.local.as_ref() {
                    "textarea" => true,
                    "input" => !matches!(
                        element
                            .attr(local_name!("type"))
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .as_str(),
                        "hidden"
                            | "checkbox"
                            | "radio"
                            | "file"
                            | "submit"
                            | "image"
                            | "reset"
                            | "button"
                    ),
                    _ => false,
                }
        })
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "Blitz's scroll record uses integral layout metrics while retaining fractional offsets"
)]
fn viewport_scroll_event(document: &BaseDocument) -> DomEvent {
    let scroll = document.viewport_scroll();
    let root = document.root_element();
    let layout = root.final_layout;
    let viewport = document.viewport();
    let scale = viewport.scale_f64();
    DomEvent::new(
        root.id,
        DomEventData::Scroll(BlitzScrollEvent {
            scroll_top: scroll.y,
            scroll_left: scroll.x,
            scroll_width: layout.size.width as i32,
            scroll_height: layout.size.height as i32,
            client_width: (f64::from(viewport.window_size.0) / scale) as i32,
            client_height: (f64::from(viewport.window_size.1) / scale) as i32,
        }),
    )
}

fn nearest_click_focusable_ancestor(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: GuardedNode,
) -> Result<Option<GuardedNode>, DispatchError> {
    if !node_is_live(target, document, handles) {
        return Ok(None);
    }
    for raw in document.node_chain(target.raw) {
        if is_programmatically_focusable(document, raw) {
            return guard_node(document, handles, raw);
        }
    }
    Ok(None)
}

fn default_must_preserve_focus(document: &BaseDocument, guarded: &GuardedDomEvent) -> bool {
    if guarded.metadata.label_activation {
        return false;
    }
    match &guarded.event.data {
        DomEventData::PointerDown(pointer) => pointer.is_mouse(),
        DomEventData::Click(pointer) => {
            pointer.is_mouse()
                && !click_default_delegates_focus(document, guarded.default_target.raw)
        }
        _ => false,
    }
}

fn tab_key_default(data: &DomEventData) -> Option<TabKeyDefault> {
    match data {
        DomEventData::KeyDown(event) if event.key == keyboard_types::Key::Tab => {
            Some(TabKeyDefault::Traverse {
                backwards: event.modifiers.contains(keyboard_types::Modifiers::SHIFT),
            })
        }
        DomEventData::KeyUp(event) if event.key == keyboard_types::Key::Tab => {
            Some(TabKeyDefault::SuppressKeyUp)
        }
        _ => None,
    }
}

fn enter_keydown(data: &DomEventData) -> Option<&blitz_traits::events::BlitzKeyEvent> {
    match data {
        DomEventData::KeyDown(event)
            if event.key == keyboard_types::Key::Enter && !event.is_composing =>
        {
            Some(event)
        }
        _ => None,
    }
}

fn space_key_event(data: &DomEventData) -> Option<SpaceKeyEvent<'_>> {
    match data {
        DomEventData::KeyDown(event) if is_space_key(event) => Some(SpaceKeyEvent::Down(event)),
        DomEventData::KeyUp(event) if is_space_key(event) => Some(SpaceKeyEvent::Up(event)),
        _ => None,
    }
}

fn is_space_key(event: &blitz_traits::events::BlitzKeyEvent) -> bool {
    matches!(&event.key, keyboard_types::Key::Character(value) if value.as_str() == " ")
}

fn keyboard_edit_intent(event: &blitz_traits::events::BlitzKeyEvent) -> Option<EditIntent> {
    if !event.state.is_pressed() {
        return None;
    }
    let action = event.modifiers.contains(keyboard_types::Modifiers::CONTROL);
    match &event.key {
        keyboard_types::Key::Character(value) if action && value.as_str() == "x" => {
            Some(EditIntent::DeleteByCut)
        }
        keyboard_types::Key::Character(value) if action && value.as_str() == "v" => {
            Some(EditIntent::InsertFromPaste)
        }
        keyboard_types::Key::Delete => Some(if action {
            EditIntent::DeleteWordForward
        } else {
            EditIntent::DeleteContentForward
        }),
        keyboard_types::Key::Backspace => Some(if action {
            EditIntent::DeleteWordBackward
        } else {
            EditIntent::DeleteContentBackward
        }),
        keyboard_types::Key::Enter => Some(EditIntent::InsertLineBreak),
        keyboard_types::Key::Character(value) if value.as_str() == "\n" => {
            Some(EditIntent::InsertLineBreak)
        }
        keyboard_types::Key::Character(value)
            if !event.modifiers.intersects(
                keyboard_types::Modifiers::CONTROL | keyboard_types::Modifiers::SUPER,
            ) =>
        {
            Some(EditIntent::InsertText {
                data: value.clone(),
                is_composing: event.is_composing,
            })
        }
        _ => None,
    }
}

fn keyboard_copy_default(event: &blitz_traits::events::BlitzKeyEvent) -> bool {
    event.state.is_pressed()
        && event.modifiers.contains(keyboard_types::Modifiers::CONTROL)
        && matches!(&event.key, keyboard_types::Key::Character(value) if value.as_str() == "c")
}

fn apple_standard_keybinding_edit_intent(command: &str) -> Option<EditIntent> {
    match command {
        "insertDoubleQuoteIgnoringSubstitution:" => Some(EditIntent::InsertText {
            data: "\"".to_owned(),
            is_composing: false,
        }),
        "insertSingleQuoteIgnoringSubstitution:" => Some(EditIntent::InsertText {
            data: "'".to_owned(),
            is_composing: false,
        }),
        "insertLineBreak:"
        | "insertNewline:"
        | "insertNewlineIgnoringFieldEditor:"
        | "insertParagraphSeparator:" => Some(EditIntent::InsertLineBreak),
        "deleteBackward:" | "deleteBackwardByDecomposingPreviousCharacter:" => {
            Some(EditIntent::DeleteContentBackward)
        }
        "deleteForward:" => Some(EditIntent::DeleteContentForward),
        "deleteWordBackward:" => Some(EditIntent::DeleteWordBackward),
        "deleteWordForward:" => Some(EditIntent::DeleteWordForward),
        "deleteToBeginningOfLine:" => Some(EditIntent::DeleteSoftLineBackward),
        "deleteToEndOfLine:" => Some(EditIntent::DeleteSoftLineForward),
        "deleteToBeginningOfParagraph:" => Some(EditIntent::DeleteHardLineBackward),
        "deleteToEndOfParagraph:" => Some(EditIntent::DeleteHardLineForward),
        // Pinned Blitz implements Cocoa's normally insertive yank selector as copying and
        // deleting the current selection, so describe the actual mutation as a cut.
        "yank:" => Some(EditIntent::DeleteByCut),
        _ => None,
    }
}

fn is_space_activation_control(document: &BaseDocument, target: usize) -> bool {
    let Some(element) = document
        .get_node(target)
        .and_then(blitz_dom::Node::element_data)
        .filter(|element| element.name.ns == ns!(html))
    else {
        return false;
    };
    match element.name.local.as_ref() {
        "button" => true,
        "input" => element.attr(LocalName::from("type")).is_some_and(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "button" | "submit" | "reset" | "image" | "checkbox" | "radio"
            )
        }),
        _ => false,
    }
}

fn space_activation_kind(document: &BaseDocument, target: usize) -> Option<SpaceActivationKind> {
    if !is_programmatically_focusable(document, target) {
        return None;
    }
    let element = document.get_node(target)?.element_data()?;
    if element.name.ns != ns!(html) {
        return None;
    }
    match element.name.local.as_ref() {
        "button" => Some(SpaceActivationKind::Button),
        "input" => {
            let kind = element.attr(LocalName::from("type"))?;
            if kind.eq_ignore_ascii_case("button") {
                Some(SpaceActivationKind::InputButton)
            } else if kind.eq_ignore_ascii_case("submit") {
                Some(SpaceActivationKind::InputSubmit)
            } else if kind.eq_ignore_ascii_case("reset") {
                Some(SpaceActivationKind::InputReset)
            } else if kind.eq_ignore_ascii_case("image") {
                Some(SpaceActivationKind::InputImage)
            } else if kind.eq_ignore_ascii_case("checkbox") {
                Some(SpaceActivationKind::Checkbox)
            } else if kind.eq_ignore_ascii_case("radio") {
                Some(SpaceActivationKind::Radio)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn is_enter_activatable(document: &BaseDocument, target: usize) -> bool {
    let Some(node) = document.get_node(target) else {
        return false;
    };
    let Some(element) = node
        .element_data()
        .filter(|element| element.name.ns == ns!(html))
    else {
        return false;
    };
    // Image-map areas have no independent layout box, so Blitz's general focusability helper
    // rejects them even while they are the document's current focus target. Revalidate the
    // hyperlink state and the DOM-wide eligibility which can meaningfully apply to an area.
    if element.name.local.as_ref() == "area" {
        return element.has_attr(LocalName::from("href"))
            && node.flags.is_in_document()
            && !document.node_chain(target).into_iter().any(|ancestor| {
                document.get_node(ancestor).is_some_and(|node| {
                    node.element_data()
                        .is_some_and(|element| element.has_attr(LocalName::from("inert")))
                })
            });
    }
    if !is_programmatically_focusable(document, target) {
        return false;
    }
    match element.name.local.as_ref() {
        "a" => element.has_attr(LocalName::from("href")),
        "button" => true,
        "input" => element.attr(LocalName::from("type")).is_some_and(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "button" | "submit" | "reset" | "image"
            )
        }),
        _ => false,
    }
}

fn suppress_ineligible_enter_default(document: &BaseDocument, target: usize) -> bool {
    document
        .get_node(target)
        .and_then(blitz_dom::Node::element_data)
        .is_some_and(|element| {
            element.name.ns == ns!(html)
                && matches!(
                    element.name.local.as_ref(),
                    "a" | "area" | "button" | "input"
                )
        })
}

fn label_click_default(document: &BaseDocument, guarded: &GuardedDomEvent) -> LabelClickDefault {
    let DomEventData::Click(event) = &guarded.event.data else {
        return LabelClickDefault::NotLabel;
    };
    if guarded.metadata.event_type_override.is_some() || event.button != MouseEventButton::Main {
        return LabelClickDefault::NotLabel;
    }

    let mut target = guarded.target.raw;
    loop {
        let Some(node) = document.get_node(target) else {
            return LabelClickDefault::NotLabel;
        };
        if let Some(element) = node
            .element_data()
            .filter(|element| element.name.ns == ns!(html))
        {
            match element.name.local.as_ref() {
                "label" => {
                    let Some(control) = document.label_bound_input_element(target) else {
                        return LabelClickDefault::Suppressed;
                    };
                    let labelable = control.flags.is_in_document()
                        && control.element_data().is_some_and(|element| {
                            element.name.ns == ns!(html)
                                && element.name.local.as_ref() == "input"
                                && !element
                                    .attr(local_name!("type"))
                                    .is_some_and(|value| value.eq_ignore_ascii_case("hidden"))
                        });
                    if !labelable || is_html_actually_disabled(document, control.id) {
                        return LabelClickDefault::Suppressed;
                    }
                    return LabelClickDefault::Control {
                        target: control.id,
                        event: event.clone(),
                    };
                }
                // Interactive descendants own their click instead of delegating through an
                // enclosing label. Encountering the generated control first also prevents the
                // control click from recursively activating its label.
                "a" | "button" | "input" | "select" | "textarea" => {
                    return LabelClickDefault::NotLabel;
                }
                _ => {}
            }
        }
        let Some(parent) = node.parent else {
            return LabelClickDefault::NotLabel;
        };
        target = parent;
    }
}

fn click_default_delegates_focus(document: &BaseDocument, mut target: usize) -> bool {
    loop {
        let Some(node) = document.get_node(target) else {
            return false;
        };
        if let Some(element) = node
            .element_data()
            .filter(|element| element.name.ns == ns!(html))
        {
            match element.name.local.as_ref() {
                "label" => return document.label_bound_input_element(target).is_some(),
                // A directly activated control or interactive descendant owns its click. Only
                // reaching a label through non-interactive descendants delegates focus later.
                "a" | "button" | "input" | "select" | "textarea" => return false,
                _ => {}
            }
        }
        let Some(parent) = node.parent else {
            return false;
        };
        target = parent;
    }
}

fn restore_focus_owner(document: &mut BaseDocument, owner: Option<usize>) {
    if let Some(owner) = owner
        && is_programmatically_focusable(document, owner)
        && document.set_focus_to(owner)
    {
        return;
    }
    document.clear_focus();
}

fn install_ime_suppressing_shell(
    document: &mut BaseDocument,
    suppress: bool,
) -> Option<Arc<dyn ShellProvider>> {
    suppress.then(|| {
        let original = Arc::clone(&document.shell_provider);
        document.set_shell_provider(Arc::new(ImeSuppressingShellProvider {
            inner: Arc::clone(&original),
        }));
        original
    })
}

fn restore_shell_provider(document: &mut BaseDocument, original: Option<Arc<dyn ShellProvider>>) {
    if let Some(original) = original {
        document.set_shell_provider(original);
    }
}

fn preserve_default_focus(
    document: &mut BaseDocument,
    generated: &mut Vec<DomEvent>,
    owner: Option<usize>,
    preserve: bool,
) {
    if preserve && actual_focus_node_id(document) != owner {
        restore_focus_owner(document, owner);
        generated.retain(|event| !is_focus_event(&event.data));
    }
}

fn plan_programmatic_focus(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    target_id: usize,
) -> Result<(), DispatchError> {
    if !is_programmatically_focusable(document, target_id) {
        return Ok(());
    }
    let Some(target) = guard_node(document, handles, target_id)? else {
        return Ok(());
    };
    let old_focus = actual_focus_node_id(document);
    if old_focus == Some(target_id) {
        return Ok(());
    }
    let old_focus = old_focus
        .map(|old_focus| guard_node(document, handles, old_focus))
        .transpose()?
        .flatten();
    let metadata = EventMetadata::native();
    if let Some(old_focus) = old_focus {
        planned.push_back(PlannedWork::Action(DispatchAction::LoseFocus {
            target: old_focus,
            related_target: Some(target),
            metadata: metadata.clone(),
        }));
    }
    planned.push_back(PlannedWork::Action(DispatchAction::GainFocus {
        target,
        related_target: old_focus,
        metadata,
    }));
    Ok(())
}

fn plan_ime_commit(planned: &mut VecDeque<PlannedWork>, text: String) {
    let metadata = EventMetadata::native();
    planned.push_front(PlannedWork::DefaultOnly {
        target: PlannedTarget::Focused,
        data: DomEventData::Ime(BlitzImeEvent::Commit(text.clone())),
        metadata: metadata
            .clone()
            .with_edit_intent(Some(EditIntent::InsertText {
                data: text,
                is_composing: false,
            })),
    });
    planned.push_front(PlannedWork::DefaultOnly {
        target: PlannedTarget::Focused,
        data: DomEventData::Ime(BlitzImeEvent::Preedit(String::new(), None)),
        metadata,
    });
}

fn plan_programmatic_blur(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    target_id: usize,
) -> Result<(), DispatchError> {
    if actual_focus_node_id(document) != Some(target_id) {
        return Ok(());
    }
    let Some(target) = guard_node(document, handles, target_id)? else {
        return Ok(());
    };
    planned.push_back(PlannedWork::Action(DispatchAction::LoseFocus {
        target,
        related_target: None,
        metadata: EventMetadata::native(),
    }));
    Ok(())
}

fn guard_focus_pair(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: GuardedNode,
    related_target: Option<GuardedNode>,
    metadata: EventMetadata,
    gained: bool,
) -> Result<VecDeque<GuardedDomEvent>, DispatchError> {
    let data = if gained {
        [
            DomEventData::Focus(blitz_traits::events::BlitzFocusEvent),
            DomEventData::FocusIn(blitz_traits::events::BlitzFocusEvent),
        ]
    } else {
        [
            DomEventData::Blur(blitz_traits::events::BlitzFocusEvent),
            DomEventData::FocusOut(blitz_traits::events::BlitzFocusEvent),
        ]
    };
    let metadata = metadata.with_related_target(related_target);
    let mut guarded = VecDeque::with_capacity(data.len());
    for data in data {
        if let Some(event) = guard_queued_event(
            document,
            handles,
            DomEvent::new(target.raw, data),
            metadata.clone(),
        )? {
            guarded.push_back(event);
        }
    }
    Ok(guarded)
}

fn run_engine_or_label_default(
    document: &mut BaseDocument,
    guarded: &mut GuardedDomEvent,
    label_default: LabelClickDefault,
    source_metadata: &mut EventMetadata,
    generated: &mut Vec<DomEvent>,
) {
    match label_default {
        LabelClickDefault::NotLabel => run_engine_default(document, guarded, generated),
        LabelClickDefault::Suppressed => {}
        LabelClickDefault::Control { target, event } => {
            // Pinned Blitz invokes the associated input's click default directly, which skips
            // the input's observable/cancelable click. Queue the click itself and let the
            // ordinary staged path own preactivation, cancellation, and its default.
            *source_metadata = source_metadata.clone().into_label_activation();
            generated.push(DomEvent::new(target, DomEventData::Click(event)));
        }
    }
}

fn run_engine_default(
    document: &mut BaseDocument,
    guarded: &mut GuardedDomEvent,
    generated: &mut Vec<DomEvent>,
) {
    if matches!(&guarded.event.data, DomEventData::Wheel(_))
        && wheel_target_forwards_default(document, guarded.default_target.raw)
    {
        // Embedded documents and custom widgets consume wheel input through Blitz's event path.
        document.handle_dom_event(&mut guarded.event, |event| generated.push(event));
    } else if let DomEventData::Wheel(event) = &guarded.event.data {
        run_wheel_default(document, guarded.default_target.raw, event, generated);
    } else {
        document.handle_dom_event(&mut guarded.event, |event| generated.push(event));
    }
}

fn wheel_target_forwards_default(document: &BaseDocument, target: usize) -> bool {
    document.get_node(target).is_some_and(|node| {
        node.subdoc().is_some()
            || node
                .element_data()
                .is_some_and(|element| element.custom_widget_data().is_some())
    })
}

fn run_wheel_default(
    document: &mut BaseDocument,
    occurrence_target: usize,
    event: &BlitzWheelEvent,
    generated: &mut Vec<DomEvent>,
) {
    let (scroll_x, scroll_y) = match &event.delta {
        BlitzWheelDelta::Lines(x, y) => (x * 20.0, y * 20.0),
        BlitzWheelDelta::Pixels(x, y) => (*x, *y),
    };

    // Pinned Blitz targets wheel scrolling through mutable hover state even though the event
    // already has a target. Preserve its delta/default behavior, but anchor the scroll at the
    // raw node hit by this native occurrence without manufacturing a hover transition.
    if document.scroll_by(Some(occurrence_target), scroll_x, scroll_y, &mut |event| {
        generated.push(event);
    }) {
        document.shell_provider.request_redraw();
    }
}

fn generated_event_metadata(
    source: &EventMetadata,
    generated: &DomEventData,
    old_focus: Option<GuardedNode>,
    new_focus: Option<GuardedNode>,
) -> EventMetadata {
    let related_target = match generated {
        DomEventData::Blur(_) | DomEventData::FocusOut(_) => new_focus,
        DomEventData::Focus(_) | DomEventData::FocusIn(_) => old_focus,
        _ => source.related_target,
    };
    source.clone().with_related_target(related_target)
}

fn guard_generated_default_events(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    mut generated: Vec<DomEvent>,
    source_metadata: &EventMetadata,
    focus: (Option<GuardedNode>, Option<GuardedNode>),
    protected: Option<ProtectedCheckableDefault>,
    changed_file_input: Option<usize>,
) -> Result<VecDeque<GuardedDomEvent>, DispatchError> {
    let protected_input_present = protected.is_some_and(|protected| {
        generated.iter().any(|event| {
            event.target == protected.target.raw && matches!(&event.data, DomEventData::Input(_))
        })
    });
    if let Some(ProtectedCheckableDefault {
        target,
        checkedness_change: Some(checked),
    }) = protected
        && !protected_input_present
    {
        generated.insert(
            0,
            DomEvent::new(
                target.raw,
                DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                    value: checked.to_string(),
                }),
            ),
        );
    }

    let (old_focus, new_focus) = focus;
    let mut protected_input_emitted = false;
    let mut guarded = VecDeque::with_capacity(generated.len() + 1);
    for event in generated.into_iter().filter(not_blitz_double_click) {
        let metadata = generated_event_metadata(source_metadata, &event.data, old_focus, new_focus);
        let protected_input = protected.is_some_and(|protected| {
            event.target == protected.target.raw && matches!(&event.data, DomEventData::Input(_))
        });
        if protected_input {
            let accepted = protected.is_some_and(|protected| {
                protected.checkedness_change.is_some() && !protected_input_emitted
            });
            if !accepted {
                continue;
            }
            protected_input_emitted = true;
            let change_event = DomEvent::new(event.target, event.data.clone());
            if let Some(event) = guard_queued_event(
                document,
                handles,
                event,
                metadata.clone().into_plain_input(),
            )? {
                guarded.push_back(event);
            }
            if let Some(event) =
                guard_queued_event(document, handles, change_event, metadata.into_change())?
            {
                guarded.push_back(event);
            }
        } else {
            let file_input = changed_file_input == Some(event.target)
                && matches!(&event.data, DomEventData::Input(_));
            let change_event = file_input.then(|| DomEvent::new(event.target, event.data.clone()));
            let input_metadata = if file_input {
                metadata.clone().into_plain_input()
            } else {
                metadata.clone()
            };
            if let Some(event) = guard_queued_event(document, handles, event, input_metadata)? {
                guarded.push_back(event);
            }
            if let Some(change_event) = change_event
                && let Some(event) =
                    guard_queued_event(document, handles, change_event, metadata.into_change())?
            {
                guarded.push_back(event);
            }
        }
    }
    Ok(guarded)
}

/// Blitz's `DoubleClick` uses one document-global counter which ignores button and target.
fn not_blitz_double_click(event: &DomEvent) -> bool {
    !matches!(&event.data, DomEventData::DoubleClick(_))
}

fn suppress_disabled_trusted_pointer_click(
    document: &BaseDocument,
    handles: &NodeHandles,
    event: &GuardedDomEvent,
) -> bool {
    event.metadata.pointer.is_some()
        && matches!(
            event.metadata.pointer_release_click,
            Some(PointerReleaseClick::Matched { .. })
        )
        && event.metadata.event_type_override.is_none()
        && matches!(&event.event.data, DomEventData::Click(_))
        && node_is_live(event.target, document, handles)
        && is_html_actually_disabled(document, event.target.raw)
}

fn is_focus_event(data: &DomEventData) -> bool {
    matches!(
        data,
        DomEventData::Blur(_)
            | DomEventData::FocusOut(_)
            | DomEventData::Focus(_)
            | DomEventData::FocusIn(_)
    )
}

fn plan_pointer(
    document: &mut BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    event: &BlitzPointerEvent,
    flavor: PointerFlavor,
    stream: PointerStreamState,
    metadata: EventMetadata,
) -> Result<(), DispatchError> {
    let hover = plan_hover_transitions(document, handles, planned, event, &metadata)?;
    let pointer_flavor = exposed_pointer_flavor(event, flavor);
    let metadata = metadata.with_pointer_move_button(
        (matches!(pointer_flavor, PointerFlavor::Move) && !matches!(flavor, PointerFlavor::Move))
            .then_some(event.button),
    );

    match pointer_flavor {
        PointerFlavor::Down => {
            planned.push_back(PlannedWork::Action(DispatchAction::PointerDownState(hover)));
        }
        PointerFlavor::Up => planned.push_back(PlannedWork::Action(DispatchAction::PointerUpState)),
        PointerFlavor::Move => {}
    }

    let (default_target, author_target) = if let (Some(default_target), Some(author_target)) =
        (hover.default_target, hover.author_target)
    {
        (default_target, author_target)
    } else {
        let root = guarded_target_or_root(document, handles, None)?;
        (GuardedRawNode::from_public(root), root)
    };
    let release_click = (event.is_mouse() && matches!(flavor, PointerFlavor::Up)).then(|| {
        let Some(press) = stream.release_press.filter(|press| !press.dragged) else {
            return PointerReleaseClick::Unmatched;
        };
        press
            .author_target
            .map_or(PointerReleaseClick::Unmatched, |down_target| {
                PointerReleaseClick::Matched {
                    down_target,
                    up_target: author_target,
                }
            })
    });
    let metadata = metadata.with_pointer_release_click(release_click);
    planned.push_back(PlannedWork::Pointer {
        default_target,
        author_target,
        data: event.clone(),
        pointer_flavor,
        physical_flavor: flavor,
        suppress_compatibility_mouse: stream.suppress_compatibility_mouse,
        release_press: stream.release_press,
        metadata,
    });

    if matches!(flavor, PointerFlavor::Up)
        && event.is_primary
        && matches!(event.id, BlitzPointerId::Finger(_))
    {
        planned.push_back(PlannedWork::Action(DispatchAction::ClearHover));
    }
    Ok(())
}

fn exposed_pointer_flavor(event: &BlitzPointerEvent, physical: PointerFlavor) -> PointerFlavor {
    if !event.is_mouse() {
        return physical;
    }
    match physical {
        PointerFlavor::Down
            if !event
                .buttons
                .difference(MouseEventButtons::from(event.button))
                .is_empty() =>
        {
            PointerFlavor::Move
        }
        PointerFlavor::Up if !event.buttons.is_empty() => PointerFlavor::Move,
        _ => physical,
    }
}

fn physical_pointer_up_button(request: &DispatchRequest) -> Option<MouseEventButton> {
    match request {
        DispatchRequest::Pointer {
            event,
            flavor: PointerFlavor::Up,
            ..
        }
        | DispatchRequest::OutsidePointer {
            event,
            flavor: PointerFlavor::Up,
            ..
        } if event.is_mouse() => Some(event.button),
        _ => None,
    }
}

const fn mouse_button_bit(index: usize) -> MouseEventButtons {
    match index {
        0 => MouseEventButtons::Primary,
        1 => MouseEventButtons::Auxiliary,
        2 => MouseEventButtons::Secondary,
        3 => MouseEventButtons::Fourth,
        4 => MouseEventButtons::Fifth,
        _ => MouseEventButtons::None,
    }
}

fn active_mouse_buttons(presses: &[Option<MouseButtonPress>; 5]) -> MouseEventButtons {
    presses
        .iter()
        .enumerate()
        .filter(|(_index, press)| press.is_some())
        .fold(MouseEventButtons::None, |buttons, (index, _press)| {
            buttons | mouse_button_bit(index)
        })
}

fn update_pointer_stream_state(
    prevent_compatibility_mouse: &mut bool,
    presses: &mut [Option<MouseButtonPress>; 5],
    event: &BlitzPointerEvent,
    physical: PointerFlavor,
) -> PointerStreamState {
    let suppress_compatibility_mouse = *prevent_compatibility_mouse;
    if event.is_mouse() && matches!(physical, PointerFlavor::Up) && event.buttons.is_empty() {
        // The physical stream has ended even if its final pointerup frame later aborts while
        // waiting in JavaScript.
        *prevent_compatibility_mouse = false;
    }
    PointerStreamState {
        suppress_compatibility_mouse,
        release_press: update_mouse_button_presses(presses, event, physical),
    }
}

fn update_mouse_button_presses(
    presses: &mut [Option<MouseButtonPress>; 5],
    event: &BlitzPointerEvent,
    physical: PointerFlavor,
) -> Option<MouseButtonPress> {
    if !event.is_mouse() {
        return None;
    }
    match physical {
        PointerFlavor::Down => {
            presses[mouse_button_index(event.button)] = Some(MouseButtonPress {
                page_x: event.page_x(),
                page_y: event.page_y(),
                dragged: false,
                author_target: None,
            });
            None
        }
        PointerFlavor::Move => {
            for press in presses.iter_mut().flatten() {
                if (event.page_x() - press.page_x).abs() > 2.0
                    || (event.page_y() - press.page_y).abs() > 2.0
                {
                    press.dragged = true;
                }
            }
            None
        }
        PointerFlavor::Up => presses[mouse_button_index(event.button)].take(),
    }
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "kept in the exact transition order used by pinned Blitz EventDriver"
)]
fn plan_hover_transitions(
    document: &mut BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
) -> Result<PlannedHover, DispatchError> {
    let previous = document.get_hover_node_id();
    document.set_hover_to(event.page_x(), event.page_y());
    let current = document.get_hover_node_id();
    plan_hover_transition_between(
        document, handles, planned, event, metadata, previous, current, true,
    )
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "kept in the exact transition order used by pinned Blitz EventDriver"
)]
fn plan_hover_transition_between(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
    previous: Option<usize>,
    current: Option<usize>,
    compatibility_mouse: bool,
) -> Result<PlannedHover, DispatchError> {
    let default_target = current
        .map(|raw| guard_raw_node(document, handles, raw))
        .transpose()?
        .flatten();
    let new_chain = pointer_author_chain(document, handles, current)?;
    let author_target = new_chain.first().copied();
    if previous == current {
        return Ok(PlannedHover {
            raw: current,
            default_target,
            author_target,
        });
    }

    let mut old_chain = pointer_author_chain(document, handles, previous)?;
    let mut new_chain = new_chain;
    if old_chain == new_chain {
        // Blitz may move between an anonymous layout wrapper and its real DOM parent even though
        // the author-visible target/path did not change. Keep its raw hover state, but do not
        // manufacture duplicate boundary events for that internal transition.
        return Ok(PlannedHover {
            raw: current,
            default_target,
            author_target,
        });
    }

    let old_target = old_chain.first().copied();
    let new_target = new_chain.first().copied();
    old_chain.reverse();
    new_chain.reverse();
    let first_difference = old_chain
        .iter()
        .zip(&new_chain)
        .position(|(old, new)| old != new)
        .unwrap_or_else(|| old_chain.len().min(new_chain.len()));

    if let Some(target) = old_target {
        push_guarded_work(
            planned,
            target,
            DomEventData::PointerOut(event.clone()),
            metadata.clone().with_related_target(new_target),
        );
        if compatibility_mouse && event.is_mouse() {
            push_guarded_work(
                planned,
                target,
                DomEventData::MouseOut(event.clone()),
                metadata.clone().with_related_target(new_target),
            );
        }
        for target in old_chain.get(first_difference..).unwrap_or(&[]) {
            push_guarded_work(
                planned,
                *target,
                DomEventData::PointerLeave(event.clone()),
                metadata.clone().with_related_target(new_target),
            );
            if compatibility_mouse && event.is_mouse() {
                push_guarded_work(
                    planned,
                    *target,
                    DomEventData::MouseLeave(event.clone()),
                    metadata.clone().with_related_target(new_target),
                );
            }
        }
    }

    if let Some(target) = new_target {
        push_guarded_work(
            planned,
            target,
            DomEventData::PointerOver(event.clone()),
            metadata.clone().with_related_target(old_target),
        );
        if compatibility_mouse && event.is_mouse() {
            push_guarded_work(
                planned,
                target,
                DomEventData::MouseOver(event.clone()),
                metadata.clone().with_related_target(old_target),
            );
        }
        for target in new_chain.get(first_difference..).unwrap_or(&[]) {
            push_guarded_work(
                planned,
                *target,
                DomEventData::PointerEnter(event.clone()),
                metadata.clone().with_related_target(old_target),
            );
            if compatibility_mouse && event.is_mouse() {
                push_guarded_work(
                    planned,
                    *target,
                    DomEventData::MouseEnter(event.clone()),
                    metadata.clone().with_related_target(old_target),
                );
            }
        }
    }

    Ok(PlannedHover {
        raw: current,
        default_target,
        author_target,
    })
}

fn push_guarded_work(
    planned: &mut VecDeque<PlannedWork>,
    target: GuardedNode,
    data: DomEventData,
    metadata: EventMetadata,
) {
    planned.push_back(PlannedWork::Enqueue {
        target: PlannedTarget::Guarded(target),
        data,
        metadata,
        suppress_default: false,
        space_key: None,
    });
}

/// Convert Blitz's target-first raw hover chain to the target-first element chain exposed for
/// pointer and compatibility mouse events. Text nodes and anonymous layout wrappers can both
/// normalize to the same real element, so deduplicate after mapping.
fn pointer_author_chain(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: Option<usize>,
) -> Result<Vec<GuardedNode>, DispatchError> {
    let Some(target) = target else {
        return Ok(Vec::new());
    };
    let mut chain = Vec::new();
    for raw in document.node_chain(target) {
        let Some(raw) = pointer_author_target_id(document, raw) else {
            continue;
        };
        if chain.iter().any(|guard: &GuardedNode| guard.raw == raw) {
            continue;
        }
        let Some(guard) = guard_node(document, handles, raw)? else {
            continue;
        };
        chain.push(guard);
    }
    Ok(chain)
}

fn file_input_default_snapshot(
    document: &BaseDocument,
    guarded: &GuardedDomEvent,
) -> Option<FileInputDefaultSnapshot> {
    let target = matches!(&guarded.event.data, DomEventData::Click(_))
        .then(|| activated_file_input(document, guarded.default_target.raw))
        .flatten()?;
    let element = document
        .get_node(target)
        .and_then(blitz_dom::Node::element_data)?;
    let authored_value = element
        .attrs
        .iter()
        .find(|attribute| {
            attribute.name.ns == ns!() && attribute.name.local == local_name!("value")
        })
        .map(|attribute| attribute.value.as_str())
        .map(str::to_owned);
    let selection = element
        .file_data()
        .map_or_else(Vec::new, |files| files.iter().cloned().collect());
    Some(FileInputDefaultSnapshot {
        target,
        authored_value,
        selection,
    })
}

fn reconcile_file_input_default(
    document: &mut BaseDocument,
    snapshot: &FileInputDefaultSnapshot,
) -> bool {
    let Some(element) = document
        .get_node_mut(snapshot.target)
        .and_then(blitz_dom::Node::element_data_mut)
    else {
        return false;
    };
    let selection = element
        .file_data()
        .map_or_else(Vec::new, |files| files.iter().cloned().collect::<Vec<_>>());
    if selection.is_empty() {
        // The pinned shell contract returns only a Vec, so an empty result is the sole cancel
        // signal. Blitz clears FileData in that case; restore the selection which existed when
        // the picker opened, exactly as browsers retain it after cancellation.
        if selection != snapshot.selection {
            element.special_data = if snapshot.selection.is_empty() {
                SpecialElementData::None
            } else {
                SpecialElementData::FileInput(snapshot.selection.clone().into())
            };
        }
        return false;
    }
    selection != snapshot.selection
}

fn activated_file_input(document: &BaseDocument, mut node_id: usize) -> Option<usize> {
    loop {
        let node = document.get_node(node_id)?;
        if node.element_data().is_some_and(|element| {
            element.name.ns == ns!(html)
                && element.name.local.as_ref() == "input"
                && element
                    .attr(local_name!("type"))
                    .is_some_and(|value| value.eq_ignore_ascii_case("file"))
        }) {
            return Some(node_id);
        }
        if node.element_data().is_some_and(|element| {
            element.name.ns == ns!(html) && element.name.local.as_ref() == "label"
        }) && let Some(input) = document.label_bound_input_element(node_id)
            && input.element_data().is_some_and(|element| {
                element.name.ns == ns!(html)
                    && element.name.local.as_ref() == "input"
                    && element
                        .attr(local_name!("type"))
                        .is_some_and(|value| value.eq_ignore_ascii_case("file"))
            })
        {
            return Some(input.id);
        }
        node_id = node.parent?;
    }
}

fn restore_file_input_value_attribute(
    document: &mut BaseDocument,
    node_id: usize,
    value: Option<&str>,
) {
    let name = QualName {
        prefix: None,
        ns: ns!(),
        local: LocalName::from("value"),
    };
    // Pinned Blitz accidentally writes this content attribute in the HTML namespace. Remove that
    // private mutation explicitly; ordinary DOM attribute helpers address the unnamespaced name.
    let blitz_name = QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from("value"),
    };
    if let Some(element) = document
        .get_node_mut(node_id)
        .and_then(blitz_dom::Node::element_data_mut)
    {
        element.attrs.remove(&blitz_name);
    }
    let current = document
        .get_node(node_id)
        .and_then(blitz_dom::Node::element_data)
        .and_then(|element| {
            element
                .attrs
                .iter()
                .find(|attribute| attribute.name == name)
        })
        .map(|attribute| attribute.value.as_str());
    if current == value {
        return;
    }
    match value {
        Some(value) => document.mutate().set_attribute(node_id, name, value),
        None => document.mutate().clear_attribute(node_id, name),
    }
}

fn pointer_dom_data(
    flavor: PointerFlavor,
    event: BlitzPointerEvent,
    compatibility_mouse: bool,
) -> DomEventData {
    match (flavor, compatibility_mouse) {
        (PointerFlavor::Move, false) => DomEventData::PointerMove(event),
        (PointerFlavor::Down, false) => DomEventData::PointerDown(event),
        (PointerFlavor::Up, false) => DomEventData::PointerUp(event),
        (PointerFlavor::Move, true) => DomEventData::MouseMove(event),
        (PointerFlavor::Down, true) => DomEventData::MouseDown(event),
        (PointerFlavor::Up, true) => DomEventData::MouseUp(event),
    }
}

fn guard_planned_event(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: PlannedTarget,
    data: DomEventData,
    metadata: EventMetadata,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    let target = match target {
        PlannedTarget::Guarded(target) => target,
        PlannedTarget::Focused => {
            guarded_target_or_root(document, handles, document.get_focussed_node_id())?
        }
    };
    guard_event_with_target(document, handles, target, data, metadata)
}

/// Guard a generated event's target as soon as Blitz queues it, but freeze its propagation path
/// only when that event reaches the front of the queue. This matches `EventDriver`: listeners for
/// an earlier generated event may mutate ancestry before the next event begins dispatching.
fn guard_queued_event(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    mut event: DomEvent,
    metadata: EventMetadata,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    if let Some(cancelable) = metadata.cancelable_override {
        event.cancelable = cancelable;
    }
    let Some(default_target) = guard_raw_node(document, handles, event.target)? else {
        return Ok(None);
    };
    let (default_target, author_raw) = if event_has_element_target(&event.data) {
        (
            default_target,
            pointer_author_target_id(document, event.target),
        )
    } else {
        // Preserve the pre-existing target projection for non-pointer records. Only pointer,
        // mouse, and click-family events need separate raw and author-facing targets.
        event.target = default_target.public.raw;
        (
            GuardedRawNode::from_public(default_target.public),
            Some(default_target.public.raw),
        )
    };
    let Some(author_raw) = author_raw else {
        return Ok(None);
    };
    let Some(target) = guard_node(document, handles, author_raw)? else {
        return Ok(None);
    };
    let mut default_target = default_target;
    let mut target = target;
    if !retarget_pointer_click(
        document,
        handles,
        &event.data,
        &metadata,
        &mut default_target,
        &mut target,
    )? {
        return Ok(None);
    }
    event.target = default_target.raw;
    let metadata = metadata.with_target_offset(document, target.raw);
    Ok(Some(GuardedDomEvent {
        event,
        default_target,
        target,
        path: Vec::new(),
        metadata,
    }))
}

fn guard_event_with_target(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: GuardedNode,
    data: DomEventData,
    metadata: EventMetadata,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    guard_event_with_targets(
        document,
        handles,
        GuardedRawNode::from_public(target),
        target,
        data,
        metadata,
    )
}

fn guard_event_with_targets(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    mut default_target: GuardedRawNode,
    mut author_target: GuardedNode,
    data: DomEventData,
    metadata: EventMetadata,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    if !retarget_pointer_click(
        document,
        handles,
        &data,
        &metadata,
        &mut default_target,
        &mut author_target,
    )? {
        return Ok(None);
    }
    let mut event = DomEvent::new(default_target.raw, data);
    if let Some(cancelable) = metadata.cancelable_override {
        event.cancelable = cancelable;
    }
    let metadata = metadata.with_target_offset(document, author_target.raw);
    freeze_event_path(
        document,
        handles,
        GuardedDomEvent {
            event,
            default_target,
            target: author_target,
            path: Vec::new(),
            metadata,
        },
    )
}

fn retarget_pointer_click(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    data: &DomEventData,
    metadata: &EventMetadata,
    default_target: &mut GuardedRawNode,
    author_target: &mut GuardedNode,
) -> Result<bool, DispatchError> {
    if !matches!(data, DomEventData::Click(_)) {
        return Ok(true);
    }
    let Some(release) = metadata.pointer_release_click else {
        return Ok(true);
    };
    let PointerReleaseClick::Matched {
        down_target,
        up_target,
        ..
    } = release
    else {
        return Ok(false);
    };
    let Some(target) = common_pointer_click_target(document, handles, down_target, up_target)?
    else {
        return Ok(false);
    };
    *default_target = GuardedRawNode::from_public(target);
    *author_target = target;
    Ok(true)
}

fn common_pointer_click_target(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    down_target: GuardedNode,
    up_target: GuardedNode,
) -> Result<Option<GuardedNode>, DispatchError> {
    if !node_is_live(down_target, document, handles)
        || !node_is_live(up_target, document, handles)
        || !document
            .get_node(down_target.raw)
            .is_some_and(|node| node.flags.is_in_document())
        || !document
            .get_node(up_target.raw)
            .is_some_and(|node| node.flags.is_in_document())
    {
        return Ok(None);
    }
    let down_chain = document.node_chain(down_target.raw);
    for raw in document.node_chain(up_target.raw) {
        if down_chain.contains(&raw)
            && document
                .get_node(raw)
                .is_some_and(|node| node.element_data().is_some())
        {
            return guard_node(document, handles, raw);
        }
    }
    Ok(None)
}

fn freeze_event_path(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    mut guarded: GuardedDomEvent,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    if !guarded.is_default_target_live(document, handles)
        || !node_is_live(guarded.target, document, handles)
    {
        return Ok(None);
    }

    if guarded
        .metadata
        .related_target
        .is_some_and(|target| !node_is_live(target, document, handles))
    {
        // Related targets are not part of the propagation path. An earlier boundary/focus
        // listener may therefore destroy one while this later event remains valid. A detached
        // node keeps its generation and remains observable; a destroyed/reused node does not.
        guarded.metadata.related_target = None;
    }

    let mut path = Vec::new();
    for raw in document.node_chain(guarded.target.raw) {
        let Some(guard) = guard_node(document, handles, raw)? else {
            return Ok(None);
        };
        path.push(guard);
    }
    if path.first().copied() != Some(guarded.target) {
        return Ok(None);
    }
    guarded.path = path;
    Ok(Some(guarded))
}

fn guarded_target_or_root(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: Option<usize>,
) -> Result<GuardedNode, DispatchError> {
    let raw = target.unwrap_or_else(|| document.root_element().id);
    guard_node(document, handles, raw)?
        .ok_or_else(|| DispatchError::new("quox: the DOM event target disappeared before dispatch"))
}

/// UI Events sends unfocused keyboard input to the HTML body when present, then the document
/// element. Blitz reports the document element from `get_focussed_node_id()` even when nothing
/// owns focus, so the retained focus bit must distinguish the real focused-element case.
fn guarded_keyboard_target(
    document: &BaseDocument,
    handles: &mut NodeHandles,
) -> Result<GuardedNode, DispatchError> {
    let raw = actual_focus_node_id(document).unwrap_or_else(|| {
        let root = document.root_element();
        root.children
            .iter()
            .copied()
            .find(|child_id| {
                document.get_node(*child_id).is_some_and(|child| {
                    child.flags.is_in_document()
                        && child.element_data().is_some_and(|element| {
                            element.name.ns == ns!(html) && element.name.local.as_ref() == "body"
                        })
                })
            })
            .unwrap_or(root.id)
    });
    guard_node(document, handles, raw)?.ok_or_else(|| {
        DispatchError::new("quox: the keyboard event target disappeared before dispatch")
    })
}

fn guarded_hit_target_or_root(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: Option<usize>,
) -> Result<(GuardedRawNode, GuardedNode), DispatchError> {
    if let Some(raw) = target
        && let Some(default_target) = guard_raw_node(document, handles, raw)?
        && let Some(author_raw) = pointer_author_target_id(document, raw)
        && let Some(author_target) = guard_node(document, handles, author_raw)?
    {
        return Ok((default_target, author_target));
    }

    let root = guarded_target_or_root(document, handles, None)?;
    Ok((GuardedRawNode::from_public(root), root))
}

fn plan_wheel(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    transaction: &mut Option<WheelTransaction>,
    event: BlitzWheelEvent,
    metadata: EventMetadata,
    occurrence_target: Option<usize>,
) -> Result<(), DispatchError> {
    let (default_target, author_target) = wheel_transaction_targets(
        document,
        handles,
        transaction,
        occurrence_target,
        metadata.time_stamp,
    )?;
    planned.push_back(PlannedWork::Wheel {
        default_target,
        author_target,
        data: event,
        metadata,
    });
    Ok(())
}

fn end_wheel_transaction_for_pointer_down(
    transaction: &mut Option<WheelTransaction>,
    flavor: PointerFlavor,
) {
    if matches!(flavor, PointerFlavor::Down) {
        *transaction = None;
    }
}

fn wheel_transaction_targets(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    transaction: &mut Option<WheelTransaction>,
    occurrence_target: Option<usize>,
    time_stamp: f64,
) -> Result<(GuardedRawNode, GuardedNode), DispatchError> {
    let retained = transaction.and_then(|transaction| {
        let elapsed = time_stamp - transaction.last_time_stamp;
        ((0.0..=WHEEL_TRANSACTION_TIMEOUT_MS).contains(&elapsed)
            && node_is_live(transaction.author_target, document, handles))
        .then(|| {
            let default_target = if raw_node_is_live(transaction.default_target, document, handles)
                && pointer_author_target_id(document, transaction.default_target.raw)
                    == Some(transaction.author_target.raw)
            {
                transaction.default_target
            } else {
                GuardedRawNode::from_public(transaction.author_target)
            };
            (default_target, transaction.author_target)
        })
    });
    let (default_target, author_target) = if let Some(retained) = retained {
        retained
    } else {
        guarded_hit_target_or_root(document, handles, occurrence_target)?
    };
    *transaction = Some(WheelTransaction {
        default_target,
        author_target,
        last_time_stamp: time_stamp,
    });
    Ok((default_target, author_target))
}

fn guard_node(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    raw: usize,
) -> Result<Option<GuardedNode>, DispatchError> {
    let Some(raw) = public_dom_node_id(document, raw) else {
        return Ok(None);
    };
    let handle = handles
        .expose(raw)
        .map_err(|error| DispatchError::new(error.to_string()))?;
    Ok(Some(GuardedNode { raw, handle }))
}

fn guard_raw_node(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    raw: usize,
) -> Result<Option<GuardedRawNode>, DispatchError> {
    let Some(public_raw) = public_dom_node_id(document, raw) else {
        return Ok(None);
    };
    let Some(public) = guard_node(document, handles, public_raw)? else {
        return Ok(None);
    };
    Ok(Some(GuardedRawNode { raw, public }))
}

fn node_is_live(guard: GuardedNode, document: &BaseDocument, handles: &NodeHandles) -> bool {
    handles.resolve(guard.handle) == Some(guard.raw) && document.get_node(guard.raw).is_some()
}

fn cancel_guarded_checkable_activation(
    document: &mut BaseDocument,
    checked_controls: &mut CheckedControlStates,
    handles: &NodeHandles,
    activation: &GuardedCheckableActivation,
) -> bool {
    if !node_is_live(activation.target, document, handles) {
        return false;
    }
    debug_assert_eq!(activation.state.target(), activation.target.raw);
    let previous_radio = activation
        .previous_radio
        .filter(|previous| node_is_live(*previous, document, handles))
        .map(|previous| previous.raw);
    checked_controls.cancel_legacy_activation(document, &activation.state, previous_radio)
}

fn protected_checkable_default(
    document: &BaseDocument,
    checked_controls: &CheckedControlStates,
    handles: &NodeHandles,
    activation: Option<&GuardedCheckableActivation>,
) -> Option<ProtectedCheckableDefault> {
    let activation = activation?;
    checked_controls
        .legacy_activation_is_checkable_relevant(&activation.state)
        .then(|| ProtectedCheckableDefault {
            target: activation.target,
            checkedness_change: node_is_live(activation.target, document, handles)
                .then(|| checked_controls.legacy_activation_checkedness_change(&activation.state))
                .flatten(),
        })
}

fn reconcile_generated_checkable_defaults(
    document: &mut BaseDocument,
    checked_controls: &mut CheckedControlStates,
    handles: &NodeHandles,
    generated: &[DomEvent],
    protected_checked_target: Option<GuardedNode>,
) -> bool {
    // Blitz mutates checkbox/radio render data before queuing `input`. A staged click already
    // performed that activation before JavaScript, whose listener writes are authoritative;
    // never import Blitz's second toggle for that same stable target. Other generated input
    // targets still use the legacy import path until label activation is staged separately.
    let activated_inputs = generated
        .iter()
        .filter_map(|event| matches!(&event.data, DomEventData::Input(_)).then_some(event.target));
    let mut checkedness_changed = false;
    for target in activated_inputs {
        let is_protected_target = protected_checked_target.is_some_and(|protected| {
            protected.raw == target && node_is_live(protected, document, handles)
        });
        if !is_protected_target {
            checkedness_changed =
                checked_controls.import_user_activation(document, target) || checkedness_changed;
        }
    }
    if protected_checked_target.is_some_and(|protected| node_is_live(protected, document, handles))
    {
        // Reproject script-owned state over every Blitz radio peer as well as the protected
        // target: pinned Blitz groups by name only and may have changed unrelated controls.
        checkedness_changed = checked_controls.reconcile_document(document) || checkedness_changed;
    }
    checkedness_changed
}

fn install_temporary_radio_name(
    document: &mut BaseDocument,
    protected_checked_target: Option<GuardedNode>,
) -> Option<TemporaryRadioNameFacade> {
    let target = protected_checked_target?.raw;
    let is_unnamed_radio = document
        .get_node(target)
        .and_then(blitz_dom::Node::element_data)
        .is_some_and(|element| {
            element.name.ns == ns!(html)
                && element.name.local.as_ref() == "input"
                && element.attr(local_name!("type")) == Some("radio")
                && element.attr(local_name!("name")).is_none()
        });
    if !is_unnamed_radio {
        return None;
    }

    // Pinned Blitz unwraps a radio's name and groups every special checkbox facade by that name.
    // Give only this default a collision-free private group, then remove it before any generated
    // event is exposed or Quox reconciles the author-visible input descriptor.
    let mut suffix = 0_u32;
    let value = loop {
        let candidate = format!("__quox_unnamed_radio_{target}_{suffix}");
        let collision = document.tree().iter().any(|(_, node)| {
            node.element_data()
                .and_then(|element| element.attr(local_name!("name")))
                == Some(candidate.as_str())
        });
        if !collision {
            break candidate;
        }
        suffix = suffix.checked_add(1)?;
    };
    document
        .get_node_mut(target)
        .and_then(blitz_dom::Node::element_data_mut)?
        .attrs
        .push(Attribute {
            name: QualName {
                prefix: None,
                ns: ns!(),
                local: local_name!("name"),
            },
            value: value.clone(),
        });
    Some(TemporaryRadioNameFacade { target, value })
}

fn restore_temporary_radio_name(
    document: &mut BaseDocument,
    temporary: Option<TemporaryRadioNameFacade>,
) {
    let Some(temporary) = temporary else {
        return;
    };
    let Some(element) = document
        .get_node_mut(temporary.target)
        .and_then(blitz_dom::Node::element_data_mut)
    else {
        return;
    };
    let injected = element.attrs.remove(&QualName {
        prefix: None,
        ns: ns!(),
        local: local_name!("name"),
    });
    debug_assert!(injected.is_some_and(|attribute| attribute.value == temporary.value));
}

fn raw_node_is_live(guard: GuardedRawNode, document: &BaseDocument, handles: &NodeHandles) -> bool {
    node_is_live(guard.public, document, handles)
        && document.get_node(guard.raw).is_some()
        && public_dom_node_id(document, guard.raw) == Some(guard.public.raw)
}

fn pointer_author_target_id(document: &BaseDocument, mut raw: usize) -> Option<usize> {
    loop {
        raw = public_dom_node_id(document, raw)?;
        let node = document.get_node(raw)?;
        if matches!(&node.data, blitz_dom::NodeData::Element(_)) {
            return Some(raw);
        }
        raw = node.parent.or_else(|| node.layout_parent.get())?;
    }
}

fn event_has_element_target(data: &DomEventData) -> bool {
    matches!(
        data,
        DomEventData::PointerMove(_)
            | DomEventData::PointerDown(_)
            | DomEventData::PointerUp(_)
            | DomEventData::PointerEnter(_)
            | DomEventData::PointerLeave(_)
            | DomEventData::PointerOver(_)
            | DomEventData::PointerOut(_)
            | DomEventData::MouseMove(_)
            | DomEventData::MouseDown(_)
            | DomEventData::MouseUp(_)
            | DomEventData::MouseEnter(_)
            | DomEventData::MouseLeave(_)
            | DomEventData::MouseOver(_)
            | DomEventData::MouseOut(_)
            | DomEventData::Click(_)
            | DomEventData::ContextMenu(_)
            | DomEventData::DoubleClick(_)
            | DomEventData::Wheel(_)
    )
}

fn event_is_composed(data: &DomEventData) -> bool {
    !matches!(
        data,
        DomEventData::PointerEnter(_)
            | DomEventData::PointerLeave(_)
            | DomEventData::MouseEnter(_)
            | DomEventData::MouseLeave(_)
            | DomEventData::Scroll(_)
    )
}

fn event_payload(data: &DomEventData, metadata: &EventMetadata) -> Option<DispatchEventPayload> {
    match data {
        DomEventData::PointerMove(event) => Some(DispatchEventPayload::Pointer(pointer_payload(
            event,
            metadata,
            metadata.pointer_move_button.unwrap_or(-1),
            0,
            true,
        ))),
        DomEventData::PointerEnter(event)
        | DomEventData::PointerLeave(event)
        | DomEventData::PointerOver(event)
        | DomEventData::PointerOut(event) => Some(DispatchEventPayload::Pointer(pointer_payload(
            event, metadata, -1, 0, false,
        ))),
        DomEventData::PointerDown(event) | DomEventData::PointerUp(event) => {
            Some(DispatchEventPayload::Pointer(pointer_payload(
                event,
                metadata,
                mouse_button_number(event.button),
                0,
                false,
            )))
        }
        DomEventData::Click(event) => Some(DispatchEventPayload::Pointer(click_pointer_payload(
            event,
            metadata,
            mouse_button_number(event.button),
            pointer_detail(metadata),
        ))),
        DomEventData::ContextMenu(event) => Some(DispatchEventPayload::Pointer(
            click_pointer_payload(event, metadata, mouse_button_number(event.button), 0),
        )),
        DomEventData::MouseMove(event) => Some(DispatchEventPayload::Mouse(mouse_payload(
            event, metadata, 0, 0, true,
        ))),
        DomEventData::MouseEnter(event)
        | DomEventData::MouseLeave(event)
        | DomEventData::MouseOver(event)
        | DomEventData::MouseOut(event) => Some(DispatchEventPayload::Mouse(mouse_payload(
            event, metadata, 0, 0, false,
        ))),
        DomEventData::MouseDown(event)
        | DomEventData::MouseUp(event)
        | DomEventData::DoubleClick(event) => Some(DispatchEventPayload::Mouse(mouse_payload(
            event,
            metadata,
            mouse_button_number(event.button),
            pointer_detail(metadata),
            false,
        ))),
        DomEventData::Wheel(event) => {
            let mouse = wheel_mouse_payload(event, metadata);
            let (delta_x, delta_y, delta_mode) = metadata.wheel.map_or_else(
                || match event.delta {
                    BlitzWheelDelta::Lines(x, y) => (x, y, 1),
                    BlitzWheelDelta::Pixels(x, y) => (x, y, 0),
                },
                |native| (native.delta_x, native.delta_y, native.delta_mode),
            );
            Some(DispatchEventPayload::Wheel(WheelPayload {
                mouse,
                delta_x,
                delta_y,
                delta_z: 0.0,
                delta_mode,
            }))
        }
        DomEventData::KeyPress(event)
        | DomEventData::KeyDown(event)
        | DomEventData::KeyUp(event) => Some(DispatchEventPayload::Keyboard(keyboard_payload(
            event, metadata,
        ))),
        DomEventData::Input(_) => metadata.composition_data.as_ref().map_or_else(
            || {
                Some(DispatchEventPayload::Input(
                    metadata
                        .edit_intent
                        .as_ref()
                        .map_or_else(InputPayload::empty, EditIntent::payload),
                ))
            },
            |data| Some(DispatchEventPayload::Composition { data: data.clone() }),
        ),
        DomEventData::Focus(_)
        | DomEventData::Blur(_)
        | DomEventData::FocusIn(_)
        | DomEventData::FocusOut(_) => Some(DispatchEventPayload::Focus {
            related_target: metadata.related_target.map(|target| target.handle),
        }),
        DomEventData::Scroll(_)
        | DomEventData::Ime(_)
        | DomEventData::AppleStandardKeybinding(_) => None,
    }
}

fn pointer_payload(
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
    button: i16,
    detail: u32,
    include_movement: bool,
) -> PointerPayload {
    let (pointer_id, pointer_type) = match event.id {
        BlitzPointerId::Mouse => (1.0, "mouse"),
        BlitzPointerId::Pen => (2.0, "pen"),
        BlitzPointerId::Finger(id) => {
            #[allow(
                clippy::cast_precision_loss,
                reason = "Blitz touch ids cross a JavaScript number boundary; Quox currently emits only mouse input"
            )]
            let id = id as f64;
            (id + 3.0, "touch")
        }
    };
    let mouse = mouse_payload(event, metadata, button, detail, include_movement);
    let active = mouse.buttons != 0;
    let pressure = if event.is_mouse() {
        if active { 0.5 } else { 0.0 }
    } else {
        event.details.pressure
    };
    PointerPayload {
        mouse,
        pointer_id,
        pointer_type,
        is_primary: event.is_primary,
        width: 1.0,
        height: 1.0,
        pressure,
        tangential_pressure: f64::from(event.details.tangential_pressure),
        tilt_x: event.details.tilt_x,
        tilt_y: event.details.tilt_y,
        twist: event.details.twist,
        altitude_angle: if event.is_mouse() {
            std::f64::consts::FRAC_PI_2
        } else {
            event.details.altitude
        },
        azimuth_angle: event.details.azimuth,
        persistent_device_id: 0,
    }
}

fn click_pointer_payload(
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
    button: i16,
    detail: u32,
) -> PointerPayload {
    let mut payload = pointer_payload(event, metadata, button, detail, false);
    payload.is_primary = false;
    payload.width = 1.0;
    payload.height = 1.0;
    payload.pressure = 0.0;
    payload.tangential_pressure = 0.0;
    payload.tilt_x = 0;
    payload.tilt_y = 0;
    payload.twist = 0;
    payload.altitude_angle = std::f64::consts::FRAC_PI_2;
    payload.azimuth_angle = 0.0;
    payload.persistent_device_id = 0;
    payload
}

fn mouse_payload(
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
    button: i16,
    detail: u32,
    include_movement: bool,
) -> MousePayload {
    let coords = metadata.pointer.map_or(
        NativePointerCoordinates {
            client_x: f64::from(event.coords.client_x),
            client_y: f64::from(event.coords.client_y),
            screen: None,
            page_x: f64::from(event.coords.page_x),
            page_y: f64::from(event.coords.page_y),
            offset_x: f64::from(event.element.x),
            offset_y: f64::from(event.element.y),
        },
        |native| native.coords,
    );
    mouse_payload_from_parts(
        coords,
        if include_movement {
            metadata.pointer.map_or((0.0, 0.0), |pointer| {
                (pointer.movement_x, pointer.movement_y)
            })
        } else {
            (0.0, 0.0)
        },
        button,
        event.buttons.bits(),
        detail,
        event.mods,
        metadata
            .pointer
            .and_then(|pointer| pointer.modifier_bits)
            .or_else(|| {
                metadata
                    .key
                    .as_ref()
                    .map(|key| pointer_modifier_bits_from_key(key.modifier_bits))
            }),
        metadata.related_target,
    )
}

fn pointer_modifier_bits_from_key(bits: u32) -> u32 {
    let mut pointer_bits = 0;
    for (key_bit, pointer_bit) in [
        (KEY_MOD_SHIFT, POINTER_MOD_SHIFT),
        (KEY_MOD_CONTROL, POINTER_MOD_CONTROL),
        (KEY_MOD_ALT, POINTER_MOD_ALT),
        (KEY_MOD_META, POINTER_MOD_META),
        (KEY_MOD_CAPS_LOCK, POINTER_MOD_CAPS_LOCK),
        (KEY_MOD_ALT_GRAPH, POINTER_MOD_ALT_GRAPH),
        (KEY_MOD_FN, POINTER_MOD_FN),
        (KEY_MOD_NUM_LOCK, POINTER_MOD_NUM_LOCK),
        (KEY_MOD_SCROLL_LOCK, POINTER_MOD_SCROLL_LOCK),
    ] {
        if bits & key_bit != 0 {
            pointer_bits |= pointer_bit;
        }
    }
    pointer_bits
}

fn pointer_detail(metadata: &EventMetadata) -> u32 {
    metadata
        .click_detail
        .or_else(|| metadata.pointer.map(|native| native.detail))
        .unwrap_or(0)
}

fn wheel_mouse_payload(event: &BlitzWheelEvent, metadata: &EventMetadata) -> MousePayload {
    let coords = metadata.wheel.map_or(
        NativePointerCoordinates {
            client_x: f64::from(event.coords.client_x),
            client_y: f64::from(event.coords.client_y),
            screen: None,
            page_x: f64::from(event.coords.page_x),
            page_y: f64::from(event.coords.page_y),
            offset_x: 0.0,
            offset_y: 0.0,
        },
        |native| native.coords,
    );
    mouse_payload_from_parts(
        coords,
        (0.0, 0.0),
        0,
        event.buttons.bits(),
        0,
        event.mods,
        metadata.wheel.and_then(|wheel| wheel.modifier_bits),
        metadata.related_target,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the payload combines independent native coordinates, buttons, modifiers, and DOM relationship metadata"
)]
fn mouse_payload_from_parts(
    coords: NativePointerCoordinates,
    movement: (f64, f64),
    button: i16,
    buttons: u8,
    detail: u32,
    mods: keyboard_types::Modifiers,
    modifier_bits: Option<u32>,
    related_target: Option<GuardedNode>,
) -> MousePayload {
    let (screen_x, screen_y) = coords.screen.unwrap_or((0.0, 0.0));
    let modifier = |bit, fallback| modifier_bits.map_or(fallback, |bits| bits & bit != 0);
    MousePayload {
        client_x: coords.client_x,
        client_y: coords.client_y,
        screen_x,
        screen_y,
        page_x: coords.page_x,
        page_y: coords.page_y,
        offset_x: coords.offset_x,
        offset_y: coords.offset_y,
        movement_x: movement.0,
        movement_y: movement.1,
        button,
        buttons,
        detail,
        shift_key: modifier(
            POINTER_MOD_SHIFT,
            mods.contains(keyboard_types::Modifiers::SHIFT),
        ),
        ctrl_key: modifier(
            POINTER_MOD_CONTROL,
            mods.contains(keyboard_types::Modifiers::CONTROL),
        ),
        alt_key: modifier(
            POINTER_MOD_ALT,
            mods.contains(keyboard_types::Modifiers::ALT),
        ),
        meta_key: modifier(
            POINTER_MOD_META,
            mods.contains(keyboard_types::Modifiers::META),
        ),
        caps_lock: modifier(
            POINTER_MOD_CAPS_LOCK,
            mods.contains(keyboard_types::Modifiers::CAPS_LOCK),
        ),
        alt_graph_key: modifier(
            POINTER_MOD_ALT_GRAPH,
            mods.contains(keyboard_types::Modifiers::ALT_GRAPH),
        ),
        fn_key: modifier(POINTER_MOD_FN, mods.contains(keyboard_types::Modifiers::FN)),
        num_lock: modifier(
            POINTER_MOD_NUM_LOCK,
            mods.contains(keyboard_types::Modifiers::NUM_LOCK),
        ),
        scroll_lock: modifier(
            POINTER_MOD_SCROLL_LOCK,
            mods.contains(keyboard_types::Modifiers::SCROLL_LOCK),
        ),
        related_target: related_target.map(|target| target.handle),
    }
}

fn keyboard_payload(
    event: &blitz_traits::events::BlitzKeyEvent,
    metadata: &EventMetadata,
) -> KeyboardPayload {
    let exact = metadata.key.as_ref();
    let modifier = |bit, fallback| exact.map_or(fallback, |key| key.modifier_bits & bit != 0);
    KeyboardPayload {
        key: exact.map_or_else(|| event.key.to_string(), |key| key.key.clone()),
        code: exact.map_or_else(|| event.code.to_string(), |key| key.code.clone()),
        location: exact.map_or_else(|| key_location_number(event.location), |key| key.location),
        repeat: event.is_auto_repeating,
        is_composing: event.is_composing,
        key_code: exact.map_or(0, |key| key.keycode),
        shift_key: modifier(
            KEY_MOD_SHIFT,
            event.modifiers.contains(keyboard_types::Modifiers::SHIFT),
        ),
        ctrl_key: modifier(
            KEY_MOD_CONTROL,
            event.modifiers.contains(keyboard_types::Modifiers::CONTROL),
        ),
        alt_key: modifier(
            KEY_MOD_ALT,
            event.modifiers.contains(keyboard_types::Modifiers::ALT),
        ),
        meta_key: modifier(
            KEY_MOD_META,
            event.modifiers.contains(keyboard_types::Modifiers::META),
        ),
        caps_lock: modifier(
            KEY_MOD_CAPS_LOCK,
            event
                .modifiers
                .contains(keyboard_types::Modifiers::CAPS_LOCK),
        ),
        alt_graph_key: modifier(
            KEY_MOD_ALT_GRAPH,
            event
                .modifiers
                .contains(keyboard_types::Modifiers::ALT_GRAPH),
        ),
        fn_key: modifier(
            KEY_MOD_FN,
            event.modifiers.contains(keyboard_types::Modifiers::FN),
        ),
        num_lock: modifier(
            KEY_MOD_NUM_LOCK,
            event
                .modifiers
                .contains(keyboard_types::Modifiers::NUM_LOCK),
        ),
        scroll_lock: modifier(
            KEY_MOD_SCROLL_LOCK,
            event
                .modifiers
                .contains(keyboard_types::Modifiers::SCROLL_LOCK),
        ),
    }
}

const fn mouse_button_number(button: MouseEventButton) -> i16 {
    match button {
        MouseEventButton::Main => 0,
        MouseEventButton::Auxiliary => 1,
        MouseEventButton::Secondary => 2,
        MouseEventButton::Fourth => 3,
        MouseEventButton::Fifth => 4,
    }
}

const fn mouse_button_index(button: MouseEventButton) -> usize {
    match button {
        MouseEventButton::Main => 0,
        MouseEventButton::Auxiliary => 1,
        MouseEventButton::Secondary => 2,
        MouseEventButton::Fourth => 3,
        MouseEventButton::Fifth => 4,
    }
}

const fn key_location_number(location: keyboard_types::Location) -> u32 {
    match location {
        keyboard_types::Location::Standard => 0,
        keyboard_types::Location::Left => 1,
        keyboard_types::Location::Right => 2,
        keyboard_types::Location::Numpad => 3,
    }
}

fn native_screen_coordinates(
    known: bool,
    screen_x: f64,
    screen_y: f64,
) -> Result<Option<(f64, f64)>, NumericArgumentError> {
    if !known {
        return Ok(None);
    }
    Ok(Some((
        finite_f64(screen_x, "screenX")?,
        finite_f64(screen_y, "screenY")?,
    )))
}

fn native_pointer_coordinates(
    client_x: f64,
    client_y: f64,
    screen: Option<(f64, f64)>,
    scroll_x: f64,
    scroll_y: f64,
) -> NativePointerCoordinates {
    NativePointerCoordinates {
        client_x,
        client_y,
        screen,
        page_x: client_x + scroll_x,
        page_y: client_y + scroll_y,
        offset_x: 0.0,
        offset_y: 0.0,
    }
}

fn mouse_movement(
    last: &mut Option<NativePointerCoordinates>,
    current: NativePointerCoordinates,
) -> (f64, f64) {
    let Some(previous) = last.replace(current) else {
        return (0.0, 0.0);
    };
    // Screen positions remain authoritative while moving the application window. Wayland does
    // not expose global coordinates, so its stable client positions are the best available basis.
    match (previous.screen, current.screen) {
        (Some(previous), Some(current)) => (current.0 - previous.0, current.1 - previous.1),
        _ => (
            current.client_x - previous.client_x,
            current.client_y - previous.client_y,
        ),
    }
}

#[cfg(target_arch = "wasm32")]
fn event_time_stamp() -> f64 {
    use js_sys::Function;
    use wasm_bindgen::JsCast;

    let global = js_sys::global();
    let Ok(performance) = Reflect::get(&global, &JsValue::from_str("performance")) else {
        return 0.0;
    };
    let Ok(now) = Reflect::get(&performance, &JsValue::from_str("now")) else {
        return 0.0;
    };
    let Ok(now) = now.dyn_into::<Function>() else {
        return 0.0;
    };
    now.call0(&performance)
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

#[cfg(not(target_arch = "wasm32"))]
fn event_time_stamp() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;

    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_secs_f64() * 1_000.0
}

impl DispatchStep {
    fn into_js(self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        match self {
            Self::Event(event) => {
                set(&object, "kind", JsValue::from_str("event"))?;
                set(&object, "frameId", f64::from(event.frame_id).into())?;
                set(&object, "eventId", f64::from(event.event_id).into())?;
                set(&object, "type", JsValue::from_str(&event.event_type))?;
                set(&object, "target", f64::from(event.target).into())?;
                let path = Array::new();
                for handle in event.path {
                    path.push(&JsValue::from_f64(f64::from(handle)));
                }
                set(&object, "path", path.into())?;
                set(&object, "bubbles", event.bubbles.into())?;
                set(&object, "cancelable", event.cancelable.into())?;
                set(&object, "composed", event.composed.into())?;
                set(&object, "timeStamp", event.time_stamp.into())?;
                if let Some(payload) = event.payload {
                    set(&object, "payload", (*payload).into_js()?)?;
                }
            }
            Self::Complete {
                frame_id,
                redraw_requested,
            } => {
                set(&object, "kind", JsValue::from_str("complete"))?;
                set(&object, "frameId", f64::from(frame_id).into())?;
                set(&object, "redrawRequested", redraw_requested.into())?;
            }
        }
        Ok(object.into())
    }
}

impl DispatchEventPayload {
    fn into_js(self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        match self {
            Self::Mouse(mouse) => set_mouse_payload(&object, &mouse)?,
            Self::Pointer(pointer) => {
                set_mouse_payload(&object, &pointer.mouse)?;
                set(&object, "pointerId", pointer.pointer_id.into())?;
                set(
                    &object,
                    "pointerType",
                    JsValue::from_str(pointer.pointer_type),
                )?;
                set(&object, "isPrimary", pointer.is_primary.into())?;
                set(&object, "width", pointer.width.into())?;
                set(&object, "height", pointer.height.into())?;
                set(&object, "pressure", pointer.pressure.into())?;
                set(
                    &object,
                    "tangentialPressure",
                    pointer.tangential_pressure.into(),
                )?;
                set(&object, "tiltX", f64::from(pointer.tilt_x).into())?;
                set(&object, "tiltY", f64::from(pointer.tilt_y).into())?;
                set(&object, "twist", f64::from(pointer.twist).into())?;
                set(&object, "altitudeAngle", pointer.altitude_angle.into())?;
                set(&object, "azimuthAngle", pointer.azimuth_angle.into())?;
                set(
                    &object,
                    "persistentDeviceId",
                    f64::from(pointer.persistent_device_id).into(),
                )?;
            }
            Self::Wheel(wheel) => {
                set_mouse_payload(&object, &wheel.mouse)?;
                set(&object, "deltaX", wheel.delta_x.into())?;
                set(&object, "deltaY", wheel.delta_y.into())?;
                set(&object, "deltaZ", wheel.delta_z.into())?;
                set(&object, "deltaMode", f64::from(wheel.delta_mode).into())?;
            }
            Self::Keyboard(keyboard) => {
                set(&object, "key", JsValue::from_str(&keyboard.key))?;
                set(&object, "code", JsValue::from_str(&keyboard.code))?;
                set(&object, "location", f64::from(keyboard.location).into())?;
                set(&object, "repeat", keyboard.repeat.into())?;
                set(&object, "isComposing", keyboard.is_composing.into())?;
                set(&object, "keyCode", f64::from(keyboard.key_code).into())?;
                set(&object, "shiftKey", keyboard.shift_key.into())?;
                set(&object, "ctrlKey", keyboard.ctrl_key.into())?;
                set(&object, "altKey", keyboard.alt_key.into())?;
                set(&object, "metaKey", keyboard.meta_key.into())?;
                set(&object, "capsLock", keyboard.caps_lock.into())?;
                set(&object, "altGraphKey", keyboard.alt_graph_key.into())?;
                set(&object, "fnKey", keyboard.fn_key.into())?;
                set(&object, "numLock", keyboard.num_lock.into())?;
                set(&object, "scrollLock", keyboard.scroll_lock.into())?;
            }
            Self::Input(input) => {
                set(
                    &object,
                    "data",
                    input
                        .data
                        .map_or(JsValue::NULL, |data| JsValue::from_str(&data)),
                )?;
                set(&object, "inputType", JsValue::from_str(input.input_type))?;
                set(&object, "isComposing", input.is_composing.into())?;
            }
            Self::Composition { data } => {
                set(&object, "data", JsValue::from_str(&data))?;
            }
            Self::Focus { related_target } => {
                set(
                    &object,
                    "relatedTarget",
                    related_target.map_or(JsValue::NULL, |target| f64::from(target).into()),
                )?;
            }
        }
        Ok(object.into())
    }
}

fn set_mouse_payload(object: &Object, mouse: &MousePayload) -> Result<(), JsValue> {
    set(object, "clientX", mouse.client_x.into())?;
    set(object, "clientY", mouse.client_y.into())?;
    set(object, "pageX", mouse.page_x.into())?;
    set(object, "pageY", mouse.page_y.into())?;
    set(object, "screenX", mouse.screen_x.into())?;
    set(object, "screenY", mouse.screen_y.into())?;
    set(object, "offsetX", mouse.offset_x.into())?;
    set(object, "offsetY", mouse.offset_y.into())?;
    set(object, "movementX", mouse.movement_x.into())?;
    set(object, "movementY", mouse.movement_y.into())?;
    set(object, "button", f64::from(mouse.button).into())?;
    set(object, "buttons", f64::from(mouse.buttons).into())?;
    set(object, "detail", f64::from(mouse.detail).into())?;
    set(object, "shiftKey", mouse.shift_key.into())?;
    set(object, "ctrlKey", mouse.ctrl_key.into())?;
    set(object, "altKey", mouse.alt_key.into())?;
    set(object, "metaKey", mouse.meta_key.into())?;
    set(object, "capsLock", mouse.caps_lock.into())?;
    set(object, "altGraphKey", mouse.alt_graph_key.into())?;
    set(object, "fnKey", mouse.fn_key.into())?;
    set(object, "numLock", mouse.num_lock.into())?;
    set(object, "scrollLock", mouse.scroll_lock.into())?;
    set(
        object,
        "relatedTarget",
        mouse
            .related_target
            .map_or(JsValue::NULL, |target| f64::from(target).into()),
    )?;
    Ok(())
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "the helper consumes temporary JsValues at compact object-construction call sites"
)]
fn set(object: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value).map(|_| ())
}

fn resolve_input_layout(state: &mut QuoxRendererState) -> ResolvedInputLayout<'_> {
    let width = state.width;
    let height = state.height;
    let framebuffer_width = state.framebuffer_width;
    let framebuffer_height = state.framebuffer_height;
    let device_pixel_ratio = state.device_pixel_ratio;
    let QuoxRendererState {
        document,
        text_controls,
        checked_controls,
        node_handles,
        ..
    } = state;
    ResolvedInputLayout::new(
        document,
        text_controls,
        checked_controls,
        node_handles,
        width,
        height,
        framebuffer_width,
        framebuffer_height,
        device_pixel_ratio,
    )
}

fn begin_request(
    state: &mut QuoxRendererState,
    request: DispatchRequest,
) -> Result<DispatchStep, DispatchError> {
    let QuoxRendererState {
        document,
        text_controls,
        checked_controls,
        redraw_requested,
        node_handles,
        dispatch_stack,
        ..
    } = state;
    dispatch_stack.begin(
        document,
        text_controls,
        checked_controls,
        node_handles,
        redraw_requested.as_ref(),
        request,
    )
}

fn resume_request(
    state: &mut QuoxRendererState,
    frame_id: u32,
    event_id: u32,
    default_prevented: bool,
) -> Result<DispatchStep, DispatchError> {
    let QuoxRendererState {
        document,
        text_controls,
        checked_controls,
        redraw_requested,
        node_handles,
        dispatch_stack,
        ..
    } = state;
    dispatch_stack.resume(
        document,
        text_controls,
        checked_controls,
        node_handles,
        redraw_requested.as_ref(),
        frame_id,
        event_id,
        default_prevented,
    )
}

fn finish_step(
    state: &mut QuoxRendererState,
    step: Result<DispatchStep, DispatchError>,
) -> Result<JsValue, JsValue> {
    state.refresh_ime_cursor_area();
    let step = step.map_err(DispatchError::into_js)?;
    step.into_js()
}

#[allow(
    clippy::too_many_arguments,
    reason = "the flat WASM ABI carries browser event fields without allocating an input object"
)]
fn begin_pointer_boundary_request(
    renderer: &QuoxRenderer,
    x: f64,
    y: f64,
    screen_known: bool,
    screen_x: f64,
    screen_y: f64,
    buttons: f64,
    modifier_bits: f64,
    time_stamp: f64,
    boundary: NativePointerBoundary,
) -> Result<JsValue, JsValue> {
    let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
    let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
    let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
        .map_err(NumericArgumentError::into_js)?;
    let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
    let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
    let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
    let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
        .map_err(NumericArgumentError::into_js)?;
    let time_stamp =
        nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
    let mut state = renderer.state.borrow_mut();
    let request = resolve_input_layout(&mut state).pointer_boundary_request(PointerBoundaryInput {
        native_x,
        native_y,
        screen,
        x,
        y,
        buttons,
        modifier_bits,
        time_stamp,
        boundary,
    });
    state.refresh_ime_cursor_area();
    let step = begin_request(&mut state, request);
    finish_step(&mut state, step)
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Resolve pending layout and emit browser boundary events for a mouse which has not moved.
    pub fn begin_stationary_pointer_refresh(&self) -> Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let snapshot = state.dispatch_stack.stationary_pointer.clone();
        let request = snapshot.map_or(DispatchRequest::Empty, |snapshot| {
            resolve_input_layout(&mut state).stationary_pointer_request(snapshot)
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_move(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
        let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
            .map_err(NumericArgumentError::into_js)?;
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let time_stamp =
            nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = resolve_input_layout(&mut state).pointer_request(PointerInput {
            native_x,
            native_y,
            screen,
            x,
            y,
            button: MouseEventButton::Main,
            buttons,
            modifier_bits,
            time_stamp,
            detail: 0,
            flavor: PointerFlavor::Move,
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_enter(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        begin_pointer_boundary_request(
            self,
            x,
            y,
            screen_known,
            screen_x,
            screen_y,
            buttons,
            modifier_bits,
            time_stamp,
            NativePointerBoundary::Enter,
        )
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_leave(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        begin_pointer_boundary_request(
            self,
            x,
            y,
            screen_known,
            screen_x,
            screen_y,
            buttons,
            modifier_bits,
            time_stamp,
            NativePointerBoundary::Leave,
        )
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_cancel(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        canceled_buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
        let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
            .map_err(NumericArgumentError::into_js)?;
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let canceled_buttons =
            pointer_buttons(canceled_buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let time_stamp =
            nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = resolve_input_layout(&mut state).pointer_cancel_request(PointerCancelInput {
            native_x,
            native_y,
            screen,
            x,
            y,
            canceled_buttons,
            modifier_bits,
            time_stamp,
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_down(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        button: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
        detail: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
        let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
            .map_err(NumericArgumentError::into_js)?;
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let button = mouse_button(button).map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let time_stamp =
            nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
        let detail = uint32(detail, "detail").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = resolve_input_layout(&mut state).pointer_request(PointerInput {
            native_x,
            native_y,
            screen,
            x,
            y,
            button,
            buttons,
            modifier_bits,
            time_stamp,
            detail,
            flavor: PointerFlavor::Down,
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the flat WASM ABI carries browser event fields without allocating an input object"
    )]
    pub fn begin_pointer_up(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        button: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
        detail: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
        let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
            .map_err(NumericArgumentError::into_js)?;
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let button = mouse_button(button).map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let time_stamp =
            nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
        let detail = uint32(detail, "detail").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = resolve_input_layout(&mut state).pointer_request(PointerInput {
            native_x,
            native_y,
            screen,
            x,
            y,
            button,
            buttons,
            modifier_bits,
            time_stamp,
            detail,
            flavor: PointerFlavor::Up,
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "raw browser wheel fields stay separate from the deltas converted for Blitz"
    )]
    pub fn begin_wheel(
        &self,
        x: f64,
        y: f64,
        screen_known: bool,
        screen_x: f64,
        screen_y: f64,
        blitz_delta_x: f64,
        blitz_delta_y: f64,
        delta_x: f64,
        delta_y: f64,
        delta_mode: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
        let screen = native_screen_coordinates(screen_known, screen_x, screen_y)
            .map_err(NumericArgumentError::into_js)?;
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let blitz_delta_x =
            finite_f64(blitz_delta_x, "blitzDeltaX").map_err(NumericArgumentError::into_js)?;
        let blitz_delta_y =
            finite_f64(blitz_delta_y, "blitzDeltaY").map_err(NumericArgumentError::into_js)?;
        let delta_x = finite_f64(delta_x, "deltaX").map_err(NumericArgumentError::into_js)?;
        let delta_y = finite_f64(delta_y, "deltaY").map_err(NumericArgumentError::into_js)?;
        let delta_mode =
            integer_range(delta_mode, 0, 2, "deltaMode").map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let time_stamp =
            nonnegative_f64(time_stamp, "timeStamp").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = resolve_input_layout(&mut state).wheel_request(WheelInput {
            native_x,
            native_y,
            screen,
            x,
            y,
            blitz_delta_x,
            blitz_delta_y,
            delta_x,
            delta_y,
            delta_mode,
            buttons,
            modifier_bits,
            time_stamp,
        });
        state.refresh_ime_cursor_area();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_key_event(
        &self,
        code: &str,
        key: &str,
        keycode: f64,
        modifier_bits: f64,
        location: f64,
        event_flags: f64,
    ) -> Result<JsValue, JsValue> {
        let (modifier_bits, location, event_flags) =
            validate_key_abi(modifier_bits, location, event_flags)
                .map_err(NumericArgumentError::into_js)?;
        let keycode = uint32(keycode, "keycode").map_err(NumericArgumentError::into_js)?;
        let event = key_event(code, key, modifier_bits, location, event_flags);
        let request = DispatchRequest::Key {
            event,
            metadata: EventMetadata::key(
                event_time_stamp(),
                NativeKeyMetadata {
                    code: code.to_owned(),
                    key: key.to_owned(),
                    keycode,
                    modifier_bits,
                    location,
                },
            ),
            suppress_default: event_flags & KEY_EVENT_PRESSED != 0
                && event_flags & KEY_EVENT_PREVENT_DEFAULT != 0,
        };
        let mut state = self.state.borrow_mut();
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_focus(&self, node_handle: f64) -> Result<JsValue, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        if let Some(focus_id) = actual_focus_node_id(&state.document) {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.sync_editor_value(document, focus_id);
        }
        // Programmatic focusability depends on the latest connected tree and computed display.
        // Resolve pending DOM/style work before planning which element, if any, may receive focus.
        resolve_input_layout(&mut state);
        let step = begin_request(&mut state, DispatchRequest::Focus(node_id));
        finish_step(&mut state, step)
    }

    pub fn begin_blur(&self, node_handle: f64) -> Result<JsValue, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let step = begin_request(&mut state, DispatchRequest::Blur(node_id));
        finish_step(&mut state, step)
    }

    pub fn begin_apple_standard_keybinding(&self, command: &str) -> Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let step = begin_request(
            &mut state,
            DispatchRequest::AppleStandardKeybinding(command.to_owned()),
        );
        finish_step(&mut state, step)
    }

    pub fn begin_ime_enabled(&self) -> Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let step = begin_request(&mut state, DispatchRequest::Ime(BlitzImeEvent::Enabled));
        finish_step(&mut state, step)
    }

    pub fn begin_ime_disabled(&self) -> Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let step = begin_request(&mut state, DispatchRequest::Ime(BlitzImeEvent::Disabled));
        finish_step(&mut state, step)
    }

    pub fn begin_ime_preedit(
        &self,
        text: &str,
        cursor_start: Option<f64>,
        cursor_end: Option<f64>,
    ) -> Result<JsValue, JsValue> {
        let cursor = preedit_cursor(text, cursor_start, cursor_end)
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let step = begin_request(
            &mut state,
            DispatchRequest::Ime(BlitzImeEvent::Preedit(text.to_owned(), cursor)),
        );
        finish_step(&mut state, step)
    }

    pub fn begin_ime_commit(&self, text: &str) -> Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let step = begin_request(&mut state, DispatchRequest::ImeCommit(text.to_owned()));
        finish_step(&mut state, step)
    }

    pub fn begin_ime_delete_surrounding(
        &self,
        before_bytes: f64,
        after_bytes: f64,
    ) -> Result<JsValue, JsValue> {
        let before_bytes =
            wasm_usize(before_bytes, "beforeBytes").map_err(NumericArgumentError::into_js)?;
        let after_bytes =
            wasm_usize(after_bytes, "afterBytes").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let step = begin_request(
            &mut state,
            DispatchRequest::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            },
        );
        finish_step(&mut state, step)
    }

    pub fn resume_dom_dispatch(
        &self,
        frame_id: f64,
        event_id: f64,
        default_prevented: bool,
    ) -> Result<JsValue, JsValue> {
        let frame_id = positive_id(frame_id, "frameId")?;
        let event_id = positive_id(event_id, "eventId")?;
        let mut state = self.state.borrow_mut();
        let step = resume_request(&mut state, frame_id, event_id, default_prevented);
        finish_step(&mut state, step)
    }

    pub fn abort_dom_dispatch(&self, frame_id: f64) -> Result<bool, JsValue> {
        let frame_id = positive_id(frame_id, "frameId")?;
        let mut state = self.state.borrow_mut();
        let QuoxRendererState {
            document,
            checked_controls,
            node_handles,
            redraw_requested,
            dispatch_stack,
            ..
        } = &mut *state;
        let redraw_requested = dispatch_stack.abort(
            document,
            checked_controls,
            node_handles,
            redraw_requested.as_ref(),
            frame_id,
        );
        state.refresh_ime_cursor_area();
        Ok(redraw_requested)
    }
}

fn positive_id(value: f64, name: &'static str) -> Result<u32, JsValue> {
    let value = uint32(value, name).map_err(NumericArgumentError::into_js)?;
    if value == 0 {
        return Err(
            NumericArgumentError::new(name, "be a positive unsigned 32-bit integer").into_js(),
        );
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ImeRequestMailbox, QuoxShellProvider};
    use blitz_dom::{DocumentConfig, LocalName, NodeData, QualName, ns};
    use blitz_html::HtmlDocument;
    use blitz_traits::events::{
        BlitzFocusEvent, BlitzInputEvent, BlitzKeyEvent, KeyState, MouseEventButtons,
        PointerCoords, PointerDetails,
    };
    use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
    use keyboard_types::{Code, Key, Location, Modifiers};
    use std::sync::Arc;

    struct TestContext {
        document: BaseDocument,
        text_controls: TextControlStates,
        checked_controls: CheckedControlStates,
        handles: NodeHandles,
        stack: DispatchStack,
        redraw: Arc<AtomicBool>,
        ime_requests: Arc<ImeRequestMailbox>,
    }

    impl TestContext {
        fn new(body: &str) -> Self {
            let redraw = Arc::new(AtomicBool::new(false));
            let ime_requests = Arc::new(ImeRequestMailbox::default());
            let shell_provider = Arc::new(QuoxShellProvider {
                redraw_requested: Arc::clone(&redraw),
                ime_requests: Arc::clone(&ime_requests),
            });
            Self::build(body, redraw, ime_requests, shell_provider)
        }

        fn with_shell(body: &str, shell_provider: Arc<dyn ShellProvider>) -> Self {
            Self::build(
                body,
                Arc::new(AtomicBool::new(false)),
                Arc::new(ImeRequestMailbox::default()),
                shell_provider,
            )
        }

        fn build(
            body: &str,
            redraw: Arc<AtomicBool>,
            ime_requests: Arc<ImeRequestMailbox>,
            shell_provider: Arc<dyn ShellProvider>,
        ) -> Self {
            let mut document = HtmlDocument::from_html(
                &format!("<!doctype html><html><body>{body}</body></html>"),
                DocumentConfig {
                    viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
                    shell_provider: Some(shell_provider),
                    ..Default::default()
                },
            )
            .into_inner();
            let mut text_controls = TextControlStates::default();
            text_controls.reconcile_document(&mut document);
            let mut checked_controls = CheckedControlStates::default();
            checked_controls.reconcile_document(&mut document);
            let mut context = Self {
                document,
                text_controls,
                checked_controls,
                handles: NodeHandles::default(),
                stack: DispatchStack::default(),
                redraw,
                ime_requests,
            };
            context.document.resolve(0.0);
            let _ = context.redraw.swap(false, Ordering::Relaxed);
            context
        }

        fn begin(&mut self, request: DispatchRequest) -> DispatchStep {
            self.stack
                .begin(
                    &mut self.document,
                    &mut self.text_controls,
                    &mut self.checked_controls,
                    &mut self.handles,
                    self.redraw.as_ref(),
                    request,
                )
                .expect("dispatch should begin")
        }

        fn resume(&mut self, event: &DispatchEventStep, default_prevented: bool) -> DispatchStep {
            self.stack
                .resume(
                    &mut self.document,
                    &mut self.text_controls,
                    &mut self.checked_controls,
                    &mut self.handles,
                    self.redraw.as_ref(),
                    event.frame_id,
                    event.event_id,
                    default_prevented,
                )
                .expect("dispatch should resume")
        }

        fn abort(&mut self, frame_id: u32) -> bool {
            self.stack.abort(
                &mut self.document,
                &mut self.checked_controls,
                &self.handles,
                self.redraw.as_ref(),
                frame_id,
            )
        }

        fn element(&self, id: &str) -> usize {
            self.document
                .tree()
                .iter()
                .find_map(|(node_id, node)| {
                    node.element_data().and_then(|element| {
                        (element.attr(LocalName::from("id")) == Some(id)).then_some(node_id)
                    })
                })
                .unwrap_or_else(|| panic!("test element #{id} should exist"))
        }

        fn body(&self) -> usize {
            self.document
                .root_element()
                .children
                .iter()
                .copied()
                .find(|child_id| {
                    self.document.get_node(*child_id).is_some_and(|child| {
                        child.element_data().is_some_and(|element| {
                            element.name.ns == ns!(html) && element.name.local.as_ref() == "body"
                        })
                    })
                })
                .expect("test document should have a body")
        }

        fn text_child(&self, parent_id: usize) -> usize {
            self.document
                .get_node(parent_id)
                .expect("test parent should exist")
                .children
                .iter()
                .copied()
                .find(|child_id| {
                    self.document
                        .get_node(*child_id)
                        .is_some_and(|child| matches!(&child.data, NodeData::Text(_)))
                })
                .expect("test parent should have a text child")
        }

        /// Mirror the public attribute path's filename-mode bookkeeping without constructing a
        /// GPU-backed `QuoxRenderer` in this pure dispatch harness.
        fn set_input_type(&mut self, node_id: usize, value: &str) {
            self.document.mutate().set_attribute(
                node_id,
                QualName {
                    prefix: None,
                    ns: ns!(),
                    local: LocalName::from("type"),
                },
                value,
            );
            self.text_controls
                .reconcile_document_with_handles(&mut self.document, &mut self.handles);
        }

        #[allow(
            clippy::cast_possible_truncation,
            reason = "test pointer inputs use the same f32 coordinate boundary as Blitz"
        )]
        fn center(&self, node_id: usize) -> (f32, f32) {
            let rect = self
                .document
                .get_client_bounding_rect(node_id)
                .expect("test element should have a client rect");
            (
                (rect.x + rect.width / 2.0) as f32,
                (rect.y + rect.height / 2.0) as f32,
            )
        }

        #[allow(
            clippy::cast_possible_truncation,
            reason = "test hit inputs use the same f32 coordinate boundary as Blitz"
        )]
        fn points_hitting(&self, node_id: usize) -> Vec<(f32, f32)> {
            let mut bounds_id = node_id;
            let rect = loop {
                if let Some(rect) = self.document.get_client_bounding_rect(bounds_id)
                    && rect.width > 0.0
                    && rect.height > 0.0
                {
                    break rect;
                }
                let Some(node) = self.document.get_node(bounds_id) else {
                    return Vec::new();
                };
                let Some(parent) = node.parent.or_else(|| node.layout_parent.get()) else {
                    return Vec::new();
                };
                bounds_id = parent;
            };
            let mut points = Vec::new();
            for y_step in 0..24 {
                for x_step in 0..24 {
                    let x = rect.x + rect.width * (f64::from(x_step) + 0.5) / 24.0;
                    let y = rect.y + rect.height * (f64::from(y_step) + 0.5) / 24.0;
                    if self
                        .document
                        .hit(x as f32, y as f32)
                        .is_some_and(|hit| hit.node_id == node_id)
                    {
                        points.push((x as f32, y as f32));
                    }
                }
            }
            points
        }

        fn point_hitting(&self, node_id: usize) -> Option<(f32, f32)> {
            self.points_hitting(node_id).into_iter().next()
        }

        #[allow(
            clippy::cast_possible_truncation,
            reason = "test hit inputs use the same f32 coordinate boundary as Blitz"
        )]
        fn glyph_points_targeting(&self, element_id: usize) -> Vec<(f32, f32)> {
            let mut bounds_id = element_id;
            let rect = loop {
                if let Some(rect) = self.document.get_client_bounding_rect(bounds_id)
                    && rect.width > 0.0
                    && rect.height > 0.0
                {
                    break rect;
                }
                let Some(node) = self.document.get_node(bounds_id) else {
                    return Vec::new();
                };
                let Some(parent) = node.parent.or_else(|| node.layout_parent.get()) else {
                    return Vec::new();
                };
                bounds_id = parent;
            };
            let mut points = Vec::new();
            for y_step in 0..24 {
                for x_step in 0..24 {
                    let x = rect.x + rect.width * (f64::from(x_step) + 0.5) / 24.0;
                    let y = rect.y + rect.height * (f64::from(y_step) + 0.5) / 24.0;
                    if self.document.hit(x as f32, y as f32).is_some_and(|hit| {
                        hit.is_text
                            && pointer_author_target_id(&self.document, hit.node_id)
                                == Some(element_id)
                    }) {
                        points.push((x as f32, y as f32));
                    }
                }
            }
            points
        }

        fn raw_text(&mut self, node_id: usize) -> String {
            let mut value = None;
            self.document.with_text_input(node_id, |driver| {
                value = Some(driver.editor.raw_text().to_owned());
            });
            value.expect("test node should be a text input")
        }

        fn live_value(&mut self, node_id: usize) -> String {
            self.text_controls
                .value(&mut self.document, node_id)
                .expect("test node should have a live text-control value")
        }

        fn set_style(&mut self, node_id: usize, value: &str) {
            self.document.mutate().set_attribute(
                node_id,
                QualName {
                    prefix: None,
                    ns: ns!(),
                    local: LocalName::from("style"),
                },
                value,
            );
        }

        fn begin_trusted_pointer(
            &mut self,
            x: f32,
            y: f32,
            button: MouseEventButton,
            buttons: MouseEventButtons,
            flavor: PointerFlavor,
        ) -> DispatchStep {
            let detail = u32::from(!matches!(flavor, PointerFlavor::Move));
            let request = ResolvedInputLayout::new(
                &mut self.document,
                &mut self.text_controls,
                &mut self.checked_controls,
                &mut self.handles,
                800,
                600,
                800,
                600,
                1.0,
            )
            .pointer_request(PointerInput {
                native_x: f64::from(x),
                native_y: f64::from(y),
                screen: None,
                x,
                y,
                button,
                buttons,
                modifier_bits: 0,
                time_stamp: event_time_stamp(),
                detail,
                flavor,
            });
            self.begin(request)
        }

        #[allow(
            clippy::too_many_arguments,
            reason = "the test helper exposes the complete native boundary occurrence"
        )]
        fn begin_trusted_boundary(
            &mut self,
            x: f32,
            y: f32,
            buttons: MouseEventButtons,
            modifier_bits: u32,
            time_stamp: f64,
            screen: Option<(f64, f64)>,
            boundary: NativePointerBoundary,
        ) -> DispatchStep {
            let request = ResolvedInputLayout::new(
                &mut self.document,
                &mut self.text_controls,
                &mut self.checked_controls,
                &mut self.handles,
                800,
                600,
                800,
                600,
                1.0,
            )
            .pointer_boundary_request(PointerBoundaryInput {
                native_x: f64::from(x),
                native_y: f64::from(y),
                screen,
                x,
                y,
                buttons,
                modifier_bits,
                time_stamp,
                boundary,
            });
            self.begin(request)
        }

        fn begin_trusted_wheel(&mut self, x: f32, y: f32) -> DispatchStep {
            self.begin_trusted_wheel_at(x, y, event_time_stamp())
        }

        fn begin_trusted_wheel_at(&mut self, x: f32, y: f32, time_stamp: f64) -> DispatchStep {
            let request = ResolvedInputLayout::new(
                &mut self.document,
                &mut self.text_controls,
                &mut self.checked_controls,
                &mut self.handles,
                800,
                600,
                800,
                600,
                1.0,
            )
            .wheel_request(WheelInput {
                native_x: f64::from(x),
                native_y: f64::from(y),
                screen: None,
                x,
                y,
                blitz_delta_x: 0.0,
                blitz_delta_y: -1.0,
                delta_x: 0.0,
                delta_y: 1.0,
                delta_mode: 1,
                buttons: MouseEventButtons::None,
                modifier_bits: 0,
                time_stamp,
            });
            self.begin(request)
        }

        fn begin_stationary_pointer_refresh(&mut self) -> DispatchStep {
            let snapshot = self.stack.stationary_pointer.clone();
            let request = snapshot.map_or(DispatchRequest::Empty, |snapshot| {
                ResolvedInputLayout::new(
                    &mut self.document,
                    &mut self.text_controls,
                    &mut self.checked_controls,
                    &mut self.handles,
                    800,
                    600,
                    800,
                    600,
                    1.0,
                )
                .stationary_pointer_request(snapshot)
            });
            self.begin(request)
        }

        fn begin_programmatic_focus(&mut self, node_id: usize) -> DispatchStep {
            if let Some(focus_id) = actual_focus_node_id(&self.document) {
                self.text_controls
                    .sync_editor_value(&mut self.document, focus_id);
            }
            ResolvedInputLayout::new(
                &mut self.document,
                &mut self.text_controls,
                &mut self.checked_controls,
                &mut self.handles,
                800,
                600,
                800,
                600,
                1.0,
            );
            self.begin(DispatchRequest::Focus(node_id))
        }

        fn begin_programmatic_blur(&mut self, node_id: usize) -> DispatchStep {
            self.begin(DispatchRequest::Blur(node_id))
        }
    }

    fn event(step: DispatchStep) -> DispatchEventStep {
        match step {
            DispatchStep::Event(event) => event,
            DispatchStep::Complete { .. } => panic!("expected an event step"),
        }
    }

    fn complete(step: DispatchStep) -> (u32, bool) {
        match step {
            DispatchStep::Complete {
                frame_id,
                redraw_requested,
            } => (frame_id, redraw_requested),
            DispatchStep::Event(event) => panic!("unexpected {} event", event.event_type),
        }
    }

    fn drain(context: &mut TestContext, mut step: DispatchStep) -> (Vec<String>, u32, bool) {
        let mut types = Vec::new();
        loop {
            match step {
                DispatchStep::Event(ref current) => {
                    types.push(current.event_type.clone());
                    let current = current.clone();
                    step = context.resume(&current, false);
                }
                DispatchStep::Complete {
                    frame_id,
                    redraw_requested,
                } => return (types, frame_id, redraw_requested),
            }
        }
    }

    fn drain_steps(context: &mut TestContext, mut step: DispatchStep) -> Vec<DispatchEventStep> {
        let mut events = Vec::new();
        while let DispatchStep::Event(current) = step {
            events.push(current.clone());
            step = context.resume(&current, false);
        }
        events
    }

    fn dispatch_click_at(
        context: &mut TestContext,
        x: f32,
        y: f32,
        button: MouseEventButton,
        mask: MouseEventButtons,
        down_time_stamp: f64,
        native_detail: u32,
    ) -> Vec<DispatchEventStep> {
        let down = context.begin(pointer_request_at(
            x,
            y,
            button,
            mask,
            PointerFlavor::Down,
            down_time_stamp,
            native_detail,
        ));
        let _ = drain(context, down);
        let up = context.begin(pointer_request_at(
            x,
            y,
            button,
            MouseEventButtons::None,
            PointerFlavor::Up,
            down_time_stamp + 1.0,
            native_detail,
        ));
        drain_steps(context, up)
    }

    fn drain_pointer_mouse_records(
        context: &mut TestContext,
        mut step: DispatchStep,
    ) -> Vec<(String, i16, u8)> {
        let mut records = Vec::new();
        while let DispatchStep::Event(current) = step {
            let fields = match current.payload.as_deref() {
                Some(DispatchEventPayload::Pointer(payload))
                    if matches!(
                        current.event_type.as_str(),
                        "pointermove" | "pointerdown" | "pointerup"
                    ) =>
                {
                    Some((payload.mouse.button, payload.mouse.buttons))
                }
                Some(DispatchEventPayload::Mouse(payload))
                    if matches!(
                        current.event_type.as_str(),
                        "mousemove" | "mousedown" | "mouseup"
                    ) =>
                {
                    Some((payload.button, payload.buttons))
                }
                _ => None,
            };
            if let Some((button, buttons)) = fields {
                records.push((current.event_type.clone(), button, buttons));
            }
            step = context.resume(&current, false);
        }
        records
    }

    fn next_event_of_type(
        context: &mut TestContext,
        mut step: DispatchStep,
        event_type: &str,
    ) -> DispatchEventStep {
        loop {
            match step {
                DispatchStep::Event(current) if current.event_type == event_type => return current,
                DispatchStep::Event(current) => {
                    step = context.resume(&current, false);
                }
                DispatchStep::Complete { .. } => {
                    panic!("dispatch completed before {event_type}")
                }
            }
        }
    }

    fn set_disabled(context: &mut TestContext, target: usize, disabled: bool) {
        let name = QualName {
            prefix: None,
            ns: ns!(),
            local: LocalName::from("disabled"),
        };
        if disabled {
            context.document.mutate().set_attribute(target, name, "");
        } else {
            context.document.mutate().clear_attribute(target, name);
        }
    }

    fn pointer(
        x: f32,
        y: f32,
        button: MouseEventButton,
        buttons: MouseEventButtons,
    ) -> BlitzPointerEvent {
        BlitzPointerEvent {
            id: BlitzPointerId::Mouse,
            is_primary: true,
            coords: PointerCoords {
                page_x: x,
                page_y: y,
                screen_x: x,
                screen_y: y,
                client_x: x,
                client_y: y,
            },
            button,
            buttons,
            mods: Modifiers::empty(),
            details: PointerDetails::default(),
            element: blitz_traits::events::Point::default(),
        }
    }

    fn pointer_request_at(
        x: f32,
        y: f32,
        button: MouseEventButton,
        buttons: MouseEventButtons,
        flavor: PointerFlavor,
        time_stamp: f64,
        detail: u32,
    ) -> DispatchRequest {
        pointer_request_with_screen_at(x, y, button, buttons, flavor, time_stamp, detail, None)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the test helper exposes the complete native pointer occurrence"
    )]
    fn pointer_request_with_screen_at(
        x: f32,
        y: f32,
        button: MouseEventButton,
        buttons: MouseEventButtons,
        flavor: PointerFlavor,
        time_stamp: f64,
        detail: u32,
        screen: Option<(f64, f64)>,
    ) -> DispatchRequest {
        DispatchRequest::Pointer {
            event: pointer(x, y, button, buttons),
            flavor,
            metadata: EventMetadata::pointer(
                time_stamp,
                native_pointer_coordinates(f64::from(x), f64::from(y), screen, 0.0, 0.0),
                detail,
            ),
        }
    }

    fn pointer_cancel_request_at(
        x: f32,
        y: f32,
        canceled_buttons: MouseEventButtons,
        metadata: EventMetadata,
    ) -> DispatchRequest {
        DispatchRequest::PointerCancel {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            canceled_buttons,
            metadata,
        }
    }

    fn key(key: Key, code: Code, state: KeyState) -> BlitzKeyEvent {
        BlitzKeyEvent {
            key,
            code,
            modifiers: Modifiers::empty(),
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state,
            text: None,
        }
    }

    fn host_key_metadata(key: &str) -> EventMetadata {
        EventMetadata::key(
            event_time_stamp(),
            NativeKeyMetadata {
                code: "Unidentified".to_owned(),
                key: key.to_owned(),
                keycode: 0,
                modifier_bits: 0,
                location: 0,
            },
        )
    }

    fn tab_request(
        state: KeyState,
        shift: bool,
        repeat: bool,
        suppress_default: bool,
    ) -> DispatchRequest {
        let mut event = key(Key::Tab, Code::Tab, state);
        event.is_auto_repeating = repeat;
        if shift {
            event.modifiers.insert(Modifiers::SHIFT);
        }
        DispatchRequest::Key {
            event,
            metadata: EventMetadata::key(
                500.0,
                NativeKeyMetadata {
                    code: "Tab".to_owned(),
                    key: "Tab".to_owned(),
                    keycode: 9,
                    modifier_bits: if shift { KEY_MOD_SHIFT } else { 0 },
                    location: 0,
                },
            ),
            suppress_default,
        }
    }

    fn enter_request(
        state: KeyState,
        repeat: bool,
        composing: bool,
        suppress_default: bool,
        modifier_bits: u32,
    ) -> DispatchRequest {
        let mut event = key(Key::Enter, Code::Enter, state);
        event.is_auto_repeating = repeat;
        event.is_composing = composing;
        DispatchRequest::Key {
            event,
            metadata: EventMetadata::key(
                700.25,
                NativeKeyMetadata {
                    code: "Enter".to_owned(),
                    key: "Enter".to_owned(),
                    keycode: 13,
                    modifier_bits,
                    location: 0,
                },
            ),
            suppress_default,
        }
    }

    fn space_request(
        state: KeyState,
        repeat: bool,
        composing: bool,
        suppress_default: bool,
        modifier_bits: u32,
        time_stamp: f64,
    ) -> DispatchRequest {
        let mut event = key(Key::Character(" ".into()), Code::Space, state);
        event.is_auto_repeating = repeat;
        event.is_composing = composing;
        DispatchRequest::Key {
            event,
            metadata: EventMetadata::key(
                time_stamp,
                NativeKeyMetadata {
                    code: "Space".to_owned(),
                    key: " ".to_owned(),
                    keycode: 32,
                    modifier_bits,
                    location: 0,
                },
            ),
            suppress_default,
        }
    }

    fn focus_related_target(event: &DispatchEventStep) -> Option<u32> {
        let Some(DispatchEventPayload::Focus { related_target }) = event.payload.as_deref() else {
            panic!("{} should carry a focus payload", event.event_type);
        };
        *related_target
    }

    fn is_focus_event_name(name: &str) -> bool {
        matches!(name, "blur" | "focusout" | "focus" | "focusin")
    }

    #[allow(
        clippy::float_cmp,
        reason = "generated focus records must retain the exact causal native timestamp"
    )]
    fn assert_focus_transition_metadata(
        context: &mut TestContext,
        mut step: DispatchStep,
        time_stamp: f64,
        old_handle: u32,
        new_handle: u32,
    ) {
        let mut saw_blur = false;
        let mut saw_focus = false;
        while let DispatchStep::Event(current) = step {
            assert_eq!(current.time_stamp, time_stamp);
            let expected_related_target = match current.event_type.as_str() {
                "blur" => {
                    saw_blur = true;
                    Some(new_handle)
                }
                "focus" => {
                    saw_focus = true;
                    Some(old_handle)
                }
                _ => None,
            };
            if let Some(related_target) = expected_related_target {
                assert_eq!(
                    current.payload.as_deref(),
                    Some(&DispatchEventPayload::Focus {
                        related_target: Some(related_target),
                    })
                );
            }
            step = context.resume(&current, false);
        }
        assert!(saw_blur && saw_focus);
    }

    fn stage_generated(
        context: &mut TestContext,
        target: usize,
        data: DomEventData,
    ) -> DispatchEventStep {
        stage_generated_with_metadata(context, target, data, EventMetadata::native())
    }

    fn stage_generated_with_metadata(
        context: &mut TestContext,
        target: usize,
        data: DomEventData,
        metadata: EventMetadata,
    ) -> DispatchEventStep {
        let guarded = guard_queued_event(
            &context.document,
            &mut context.handles,
            DomEvent::new(target, data),
            metadata,
        )
        .expect("target handles should fit")
        .expect("generated target should be live");
        let frame_id = context
            .stack
            .allocate_frame_id()
            .expect("frame id should fit");
        context.stack.frames.push(DispatchFrame {
            id: frame_id,
            planned: VecDeque::new(),
            generated: VecDeque::from([guarded]),
            pending: None,
            redraw_requested: false,
        });
        event(
            context
                .stack
                .advance(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                )
                .expect("generated event should stage"),
        )
    }

    #[test]
    fn preserves_pinned_hover_and_compatibility_mouse_order() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let _ = context.redraw.swap(false, Ordering::Relaxed);

        let step = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, step);
        assert_eq!(
            types,
            [
                "pointerout",
                "mouseout",
                "pointerleave",
                "mouseleave",
                "pointerover",
                "mouseover",
                "pointerenter",
                "mouseenter",
                "pointermove",
                "mousemove",
            ]
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "native boundary metadata must retain exact host coordinates and timestamps"
    )]
    fn native_pointer_boundaries_use_dom_order_targets_and_metadata_without_moves() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let target_handle = context.handles.expose(target).unwrap();
        let (x, y) = context.center(target);
        let modifier_bits =
            POINTER_MOD_SHIFT | POINTER_MOD_CAPS_LOCK | POINTER_MOD_FN | POINTER_MOD_NUM_LOCK;

        let entered = context.begin_trusted_boundary(
            x,
            y,
            MouseEventButtons::Primary,
            modifier_bits,
            41.25,
            Some((1_001.125, 702.875)),
            NativePointerBoundary::Enter,
        );
        assert_eq!(context.document.get_hover_node_id(), Some(target));
        let entered = drain_steps(&mut context, entered);
        let target_entered: Vec<_> = entered
            .iter()
            .filter(|step| step.target == target_handle)
            .collect();
        assert_eq!(
            target_entered
                .iter()
                .map(|step| step.event_type.as_str())
                .collect::<Vec<_>>(),
            ["pointerover", "mouseover", "pointerenter", "mouseenter"]
        );
        assert!(
            entered
                .iter()
                .all(|step| !matches!(step.event_type.as_str(), "pointermove" | "mousemove"))
        );
        for step in target_entered {
            assert_eq!(step.time_stamp, 41.25);
            let (mouse, expected_button) = match step.payload.as_deref().unwrap() {
                DispatchEventPayload::Pointer(payload) => (&payload.mouse, -1),
                DispatchEventPayload::Mouse(payload) => (payload, 0),
                _ => panic!("boundary event should carry mouse fields"),
            };
            assert_eq!(
                (mouse.client_x, mouse.client_y),
                (f64::from(x), f64::from(y))
            );
            assert_eq!((mouse.screen_x, mouse.screen_y), (1_001.125, 702.875));
            assert_eq!((mouse.movement_x, mouse.movement_y), (0.0, 0.0));
            assert_eq!(
                (mouse.button, mouse.detail, mouse.buttons),
                (expected_button, 0, 1)
            );
            assert!(mouse.shift_key && mouse.caps_lock && mouse.fn_key && mouse.num_lock);
            assert_eq!(mouse.related_target, None);
        }

        let left = context.begin_trusted_boundary(
            -5.25,
            y,
            MouseEventButtons::Primary,
            modifier_bits,
            42.5,
            Some((1_002.25, 704.5)),
            NativePointerBoundary::Leave,
        );
        assert_eq!(context.document.get_hover_node_id(), None);
        let left = drain_steps(&mut context, left);
        let target_left: Vec<_> = left
            .iter()
            .filter(|step| step.target == target_handle)
            .collect();
        assert_eq!(
            target_left
                .iter()
                .map(|step| step.event_type.as_str())
                .collect::<Vec<_>>(),
            ["pointerout", "mouseout", "pointerleave", "mouseleave"]
        );
        for step in target_left {
            let (mouse, expected_button) = match step.payload.as_deref().unwrap() {
                DispatchEventPayload::Pointer(payload) => (&payload.mouse, -1),
                DispatchEventPayload::Mouse(payload) => (payload, 0),
                _ => panic!("boundary event should carry mouse fields"),
            };
            assert_eq!(mouse.related_target, None);
            assert_eq!((mouse.button, mouse.detail), (expected_button, 0));
            assert_eq!(mouse.client_x, -5.25);
        }
    }

    #[test]
    fn native_enter_then_move_does_not_duplicate_boundaries() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        let entered = context.begin_trusted_boundary(
            x,
            y,
            MouseEventButtons::None,
            0,
            1.0,
            None,
            NativePointerBoundary::Enter,
        );
        let _ = drain(&mut context, entered);

        let moved = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let (types, _, _) = drain(&mut context, moved);
        assert_eq!(types, ["pointermove", "mousemove"]);
    }

    #[test]
    fn native_leave_clears_only_hover_and_wheel_state_while_a_button_is_pressed() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let guarded = guard_node(&context.document, &mut context.handles, target)
            .unwrap()
            .unwrap();
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, down);
        let press_before = context.stack.mouse_button_presses[0].unwrap();
        context.stack.wheel_transaction = Some(WheelTransaction {
            default_target: GuardedRawNode::from_public(guarded),
            author_target: guarded,
            last_time_stamp: 1.0,
        });

        let left = context.begin_trusted_boundary(
            x,
            y,
            MouseEventButtons::Primary,
            0,
            2.0,
            None,
            NativePointerBoundary::Leave,
        );
        assert_eq!(context.document.get_hover_node_id(), None);
        assert!(context.stack.wheel_transaction.is_none());
        let press_after = context.stack.mouse_button_presses[0].unwrap();
        assert_eq!(press_after.author_target, press_before.author_target);
        assert_eq!(press_after.dragged, press_before.dragged);
        assert_eq!(
            (press_after.page_x, press_after.page_y),
            (press_before.page_x, press_before.page_y)
        );
        let (types, _, _) = drain(&mut context, left);
        assert!(types.iter().any(|event_type| event_type == "pointerout"));
        assert!(types.iter().any(|event_type| event_type == "mouseleave"));
        assert!(context.stack.mouse_button_presses[0].is_some());
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "native cancellation metadata must retain exact f64 host values"
    )]
    fn interrupted_mouse_stream_dispatches_pointer_only_cancel_then_exit_and_cleans_state() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let a_handle = context.handles.expose(a).unwrap();
        let b_handle = context.handles.expose(b).unwrap();
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);

        let moved = context.begin_trusted_pointer(
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let _ = drain(&mut context, moved);
        let down = context.begin_trusted_pointer(
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, down);
        let dragged = context.begin_trusted_pointer(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Move,
        );
        let _ = drain(&mut context, dragged);
        let press = context.stack.mouse_button_presses[0].unwrap();
        assert_eq!(press.author_target.unwrap().raw, a);
        assert!(press.dragged);
        let guarded_a = press.author_target.unwrap();
        context.stack.prevent_compatibility_mouse = true;
        context.stack.click_sequence = Some(ClickSequence {
            button: 0,
            target: guarded_a,
            native_detail: 1,
            detail: 1,
        });
        context.stack.wheel_transaction = Some(WheelTransaction {
            default_target: GuardedRawNode::from_public(guarded_a),
            author_target: guarded_a,
            last_time_stamp: 80.0,
        });

        let client_x = f64::from(bx) + 0.123_456_789;
        let client_y = f64::from(by) + 0.987_654_321;
        let modifier_bits = POINTER_MOD_SHIFT | POINTER_MOD_META | POINTER_MOD_FN;
        let metadata = EventMetadata::pointer_with_modifiers(
            81.25,
            native_pointer_coordinates(client_x, client_y, Some((1_301.125, 902.875)), 0.0, 0.0),
            0,
            modifier_bits,
        );
        let cancel = event(context.begin(pointer_cancel_request_at(
            bx,
            by,
            MouseEventButtons::Primary,
            metadata,
        )));

        assert_eq!(cancel.event_type, "pointercancel");
        assert_eq!(
            cancel.target, a_handle,
            "the live pressed target beats hover"
        );
        assert!(cancel.bubbles && cancel.composed);
        assert!(!cancel.cancelable);
        assert_eq!(cancel.time_stamp, 81.25);
        let Some(DispatchEventPayload::Pointer(payload)) = cancel.payload.as_deref() else {
            panic!("pointercancel should carry a pointer payload");
        };
        assert_eq!(
            (payload.mouse.client_x, payload.mouse.client_y),
            (client_x, client_y)
        );
        assert_eq!(
            (payload.mouse.screen_x, payload.mouse.screen_y),
            (1_301.125, 902.875)
        );
        assert_eq!(
            (payload.mouse.movement_x, payload.mouse.movement_y),
            (0.0, 0.0)
        );
        assert_eq!(
            (
                payload.mouse.button,
                payload.mouse.buttons,
                payload.mouse.detail
            ),
            (-1, 0, 0)
        );
        assert!(payload.mouse.shift_key && payload.mouse.meta_key && payload.mouse.fn_key);
        assert_eq!(payload.pointer_type, "mouse");
        assert_eq!(payload.pointer_id, 1.0);
        assert_eq!(payload.pressure, 0.0);

        assert!(
            context
                .stack
                .mouse_button_presses
                .iter()
                .all(Option::is_none)
        );
        assert!(
            context
                .stack
                .ignored_mouse_ups
                .contains(MouseEventButtons::Primary)
        );
        assert!(!context.stack.prevent_compatibility_mouse);
        assert!(context.stack.click_sequence.is_none());
        assert!(context.stack.wheel_transaction.is_none());
        assert_eq!(context.document.get_hover_node_id(), None);
        assert!(
            context
                .document
                .get_node(a)
                .is_some_and(|node| !node.is_active())
        );

        let resumed = context.resume(&cancel, true);
        let exits = drain_steps(&mut context, resumed);
        assert_eq!(
            exits.first().map(|step| step.event_type.as_str()),
            Some("pointerout")
        );
        assert_eq!(exits.first().map(|step| step.target), Some(b_handle));
        assert!(
            exits
                .iter()
                .skip(1)
                .all(|step| step.event_type == "pointerleave")
        );
        assert!(
            exits
                .iter()
                .all(|step| !step.event_type.starts_with("mouse"))
        );

        let duplicate = context.begin(pointer_cancel_request_at(
            bx,
            by,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                81.5,
                native_pointer_coordinates(f64::from(bx), f64::from(by), None, 0.0, 0.0),
                0,
            ),
        ));
        complete(duplicate);
        assert!(
            context
                .stack
                .ignored_mouse_ups
                .contains(MouseEventButtons::Primary)
        );

        let ignored_up = context.begin(pointer_request_at(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            82.0,
            1,
        ));
        complete(ignored_up);
        assert!(
            !context
                .stack
                .ignored_mouse_ups
                .contains(MouseEventButtons::Primary)
        );
    }

    #[test]
    fn idle_pointer_cancel_is_a_noop_and_preserves_hover() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        let moved = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let _ = drain(&mut context, moved);
        assert_eq!(context.document.get_hover_node_id(), Some(target));

        let cancel = context.begin(pointer_cancel_request_at(
            x,
            y,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                1.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                0,
            ),
        ));
        complete(cancel);
        assert_eq!(context.document.get_hover_node_id(), Some(target));
        assert_eq!(context.stack.ignored_mouse_ups, MouseEventButtons::None);
    }

    #[test]
    fn pointer_cancel_falls_back_from_a_stale_press_target_to_hover_then_root() {
        let mut hovered = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = hovered.element("a");
        let b = hovered.element("b");
        let b_handle = hovered.handles.expose(b).unwrap();
        let (ax, ay) = hovered.center(a);
        let (bx, by) = hovered.center(b);
        assert!(hovered.document.set_hover_to(ax, ay));
        let down = hovered.begin_trusted_pointer(
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut hovered, down);
        let moved = hovered.begin_trusted_pointer(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Move,
        );
        let _ = drain(&mut hovered, moved);
        hovered.document.mutate().remove_and_drop_node(a);
        let cancel = event(hovered.begin(pointer_cancel_request_at(
            bx,
            by,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                1.0,
                native_pointer_coordinates(f64::from(bx), f64::from(by), None, 0.0, 0.0),
                0,
            ),
        )));
        assert_eq!(cancel.target, b_handle);
        let _ = drain(&mut hovered, DispatchStep::Event(cancel));

        let mut rooted = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = rooted.element("target");
        let root = rooted.document.root_element().id;
        let root_handle = rooted.handles.expose(root).unwrap();
        let (x, y) = rooted.center(target);
        assert!(rooted.document.set_hover_to(x, y));
        let down = rooted.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut rooted, down);
        let left = rooted.begin_trusted_boundary(
            x,
            y,
            MouseEventButtons::Primary,
            0,
            2.0,
            None,
            NativePointerBoundary::Leave,
        );
        let _ = drain(&mut rooted, left);
        rooted.document.mutate().remove_and_drop_node(target);
        let cancel = event(rooted.begin(pointer_cancel_request_at(
            x,
            y,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                3.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                0,
            ),
        )));
        assert_eq!(cancel.target, root_handle);
        let _ = drain(&mut rooted, DispatchStep::Event(cancel));
    }

    #[test]
    fn subset_pointer_cancel_suppresses_late_ups_for_the_whole_active_stream() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));

        let primary = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            1.0,
            1,
        ));
        let _ = drain(&mut context, primary);
        let secondary = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Secondary,
            MouseEventButtons::Primary | MouseEventButtons::Secondary,
            PointerFlavor::Down,
            2.0,
            1,
        ));
        let _ = drain(&mut context, secondary);
        assert!(context.stack.mouse_button_presses[0].is_some());
        assert!(context.stack.mouse_button_presses[2].is_some());

        let cancel = event(context.begin(pointer_cancel_request_at(
            x,
            y,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                3.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                0,
            ),
        )));
        let _ = drain(&mut context, DispatchStep::Event(cancel));
        assert!(
            context
                .stack
                .mouse_button_presses
                .iter()
                .all(Option::is_none)
        );
        assert!(
            context
                .stack
                .ignored_mouse_ups
                .contains(MouseEventButtons::Primary | MouseEventButtons::Secondary)
        );

        let secondary_up = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Secondary,
            MouseEventButtons::Primary,
            PointerFlavor::Up,
            4.0,
            1,
        ));
        complete(secondary_up);
        let primary_up = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            5.0,
            1,
        ));
        complete(primary_up);
        assert_eq!(context.stack.ignored_mouse_ups, MouseEventButtons::None);
    }

    #[test]
    fn outside_pointer_move_marks_a_retained_press_as_dragged_without_dom_events() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, down);
        assert!(
            context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );

        let moved = context.begin_trusted_pointer(
            -10.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Move,
        );
        let (types, _, _) = drain(&mut context, moved);
        assert!(types.is_empty());
        assert!(context.stack.mouse_button_presses[0].unwrap().dragged);
        assert!(
            context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );
    }

    #[test]
    fn outside_final_up_clears_cancelled_press_state_without_clicking() {
        let mut context = TestContext::new(
            "<button id='target' style='display:block;width:100px;height:40px'>go</button>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let pointer_down = next_event_of_type(&mut context, down, "pointerdown");
        let remainder = context.resume(&pointer_down, true);
        let _ = drain(&mut context, remainder);
        assert!(context.stack.prevent_compatibility_mouse);
        assert!(context.stack.mouse_button_presses[0].is_some());
        assert!(
            context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );

        let up = context.begin_trusted_pointer(
            810.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
        );
        let (types, _, _) = drain(&mut context, up);
        assert!(types.is_empty());
        assert!(context.stack.mouse_button_presses[0].is_none());
        assert!(!context.stack.prevent_compatibility_mouse);
        assert!(
            !context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );
        assert!(context.stack.click_sequence.is_none());
    }

    #[test]
    fn outside_chord_releases_clear_each_press_and_unactive_only_on_final_up() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let first_down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, first_down);
        let chord_down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Secondary,
            MouseEventButtons::Primary | MouseEventButtons::Secondary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, chord_down);
        assert!(context.stack.mouse_button_presses[0].is_some());
        assert!(context.stack.mouse_button_presses[2].is_some());

        let chord_up = context.begin_trusted_pointer(
            -10.0,
            y,
            MouseEventButton::Secondary,
            MouseEventButtons::Primary,
            PointerFlavor::Up,
        );
        let (chord_types, _, _) = drain(&mut context, chord_up);
        assert!(chord_types.is_empty());
        assert!(context.stack.mouse_button_presses[0].is_some());
        assert!(context.stack.mouse_button_presses[2].is_none());
        assert!(
            context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );

        let final_up = context.begin_trusted_pointer(
            -10.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
        );
        let (final_types, _, _) = drain(&mut context, final_up);
        assert!(final_types.is_empty());
        assert!(
            context
                .stack
                .mouse_button_presses
                .iter()
                .all(Option::is_none)
        );
        assert!(
            !context
                .document
                .get_node(target)
                .is_some_and(blitz_dom::Node::is_active)
        );
    }

    #[test]
    fn native_enter_hit_tests_fresh_layout() {
        let mut context = TestContext::new(
            "<div id='target' style='position:absolute;left:300px;top:0;width:80px;height:40px'></div>",
        );
        let target = context.element("target");
        let target_handle = context.handles.expose(target).unwrap();
        context.set_style(
            target,
            "position:absolute;left:0;top:0;width:80px;height:40px",
        );

        let entered = context.begin_trusted_boundary(
            20.0,
            20.0,
            MouseEventButtons::None,
            0,
            1.0,
            None,
            NativePointerBoundary::Enter,
        );
        let pointer_over = next_event_of_type(&mut context, entered, "pointerover");
        assert_eq!(pointer_over.target, target_handle);
        let remainder = context.resume(&pointer_over, false);
        let _ = drain(&mut context, remainder);
    }

    #[test]
    fn chorded_mouse_buttons_emit_only_first_down_and_final_up_pointer_events() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = context.redraw.swap(false, Ordering::Relaxed);

        let first_down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, first_down),
            [
                ("pointerdown".to_owned(), 0, 1),
                ("mousedown".to_owned(), 0, 1)
            ]
        );

        let chord_down = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Secondary,
                MouseEventButtons::Primary | MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, chord_down),
            [
                ("pointermove".to_owned(), 2, 3),
                ("mousedown".to_owned(), 2, 3)
            ]
        );

        let chord_up = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Secondary,
                MouseEventButtons::Primary,
            ),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, chord_up),
            [
                ("pointermove".to_owned(), 2, 1),
                ("mouseup".to_owned(), 2, 1)
            ]
        );

        let final_up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, final_up),
            [("pointerup".to_owned(), 0, 0), ("mouseup".to_owned(), 0, 0)]
        );
    }

    #[test]
    fn every_extended_button_keeps_its_chord_mask_and_changed_button() {
        for (button, bit, number) in [
            (MouseEventButton::Auxiliary, MouseEventButtons::Auxiliary, 1),
            (MouseEventButton::Fourth, MouseEventButtons::Fourth, 3),
            (MouseEventButton::Fifth, MouseEventButtons::Fifth, 4),
        ] {
            let mut context = TestContext::new(
                "<div id='target' style='display:block;width:100px;height:40px'></div>",
            );
            let target = context.element("target");
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));
            let _ = context.redraw.swap(false, Ordering::Relaxed);
            let primary = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            });
            let _ = drain(&mut context, primary);

            let chord_down = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, MouseEventButtons::Primary | bit),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            });
            assert_eq!(
                drain_pointer_mouse_records(&mut context, chord_down),
                [
                    ("pointermove".to_owned(), number, 1 | bit.bits()),
                    ("mousedown".to_owned(), number, 1 | bit.bits()),
                ]
            );

            let chord_up = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, MouseEventButtons::Primary),
                flavor: PointerFlavor::Up,
                metadata: EventMetadata::native(),
            });
            assert_eq!(
                drain_pointer_mouse_records(&mut context, chord_up),
                [
                    ("pointermove".to_owned(), number, 1),
                    ("mouseup".to_owned(), number, 1),
                ]
            );
        }
    }

    #[test]
    fn cancelled_first_pointerdown_suppresses_compatibility_mouse_until_final_up() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let _ = context.redraw.swap(false, Ordering::Relaxed);

        let down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(ax, ay, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(down.event_type, "pointerdown");
        complete(context.resume(&down, true));

        let moved = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        });
        let (move_types, _, _) = drain(&mut context, moved);
        assert!(move_types.iter().any(|event_type| event_type == "mouseout"));
        assert!(
            move_types
                .iter()
                .any(|event_type| event_type == "mouseenter")
        );
        assert!(
            move_types
                .iter()
                .any(|event_type| event_type == "pointermove")
        );
        assert!(
            !move_types
                .iter()
                .any(|event_type| event_type == "mousemove")
        );

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (up_types, _, _) = drain(&mut context, up);
        assert!(up_types.iter().any(|event_type| event_type == "pointerup"));
        assert!(!up_types.iter().any(|event_type| event_type == "mouseup"));

        let next_down = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, next_down),
            [
                ("pointerdown".to_owned(), 0, 1),
                ("mousedown".to_owned(), 0, 1)
            ]
        );
    }

    #[test]
    fn cancelled_first_pointerdown_suppresses_chord_mouse_transitions() {
        for (first_button, first_mask, chord_button, chord_mask, chord_number, activation) in [
            (
                MouseEventButton::Main,
                MouseEventButtons::Primary,
                MouseEventButton::Secondary,
                MouseEventButtons::Secondary,
                2,
                "contextmenu",
            ),
            (
                MouseEventButton::Secondary,
                MouseEventButtons::Secondary,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
                0,
                "click",
            ),
        ] {
            let mut context = TestContext::new(
                "<input id='target' style='display:block;width:100px;height:40px'>",
            );
            let target = context.element("target");
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));
            let down = event(context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, first_button, first_mask),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            }));
            complete(context.resume(&down, true));

            let chord_down = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, chord_button, first_mask | chord_mask),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            });
            assert_eq!(
                drain_pointer_mouse_records(&mut context, chord_down),
                [(
                    "pointermove".to_owned(),
                    chord_number,
                    (first_mask | chord_mask).bits()
                )]
            );
            assert_ne!(context.document.get_focussed_node_id(), Some(target));

            let chord_up = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, chord_button, first_mask),
                flavor: PointerFlavor::Up,
                metadata: EventMetadata::native(),
            });
            let (types, _, _) = drain(&mut context, chord_up);
            assert!(types.iter().any(|event_type| event_type == "pointermove"));
            assert!(!types.iter().any(|event_type| event_type == "mouseup"));
            assert!(types.iter().any(|event_type| event_type == activation));
        }
    }

    #[test]
    fn suppressed_chord_drag_does_not_activate_on_release() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'>text</div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Secondary,
                MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        complete(context.resume(&down, true));

        let chord_down = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Primary | MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, chord_down);
        let moved = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x + 3.0,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Primary | MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, moved);

        let chord_up = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x + 3.0,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, chord_up);
        assert!(types.iter().any(|event_type| event_type == "pointermove"));
        assert!(!types.iter().any(|event_type| event_type == "mouseup"));
        assert!(!types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn cancelled_pointerdown_uses_per_press_drag_state_for_final_click() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);

        // Prime Blitz's global drag origin at B. The next canceled pointerdown at A cannot update
        // that private origin, so only the adapter's per-press state can recognize A-to-B drag.
        assert!(context.document.set_hover_to(bx, by));
        let prime_down = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, prime_down);
        let prime_up = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, prime_up);

        let down_step = context.begin(DispatchRequest::Pointer {
            event: pointer(ax, ay, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let down = next_event_of_type(&mut context, down_step, "pointerdown");
        complete(context.resume(&down, true));
        let moved = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, moved);
        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(!types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn chord_and_final_pointer_cancellation_do_not_hide_physical_mouse_transitions() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = context.redraw.swap(false, Ordering::Relaxed);
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let chord = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Secondary,
                MouseEventButtons::Primary | MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(chord.event_type, "pointermove");
        let mouse_down = event(context.resume(&chord, true));
        assert_eq!(mouse_down.event_type, "mousedown");
        let after_mouse_down = context.resume(&mouse_down, false);
        let _ = drain(&mut context, after_mouse_down);

        let chord_up = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Secondary,
                MouseEventButtons::Primary,
            ),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, chord_up);

        let final_up = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(final_up.event_type, "pointerup");
        let mouse_up = event(context.resume(&final_up, true));
        assert_eq!(mouse_up.event_type, "mouseup");
        let after_mouse_up = context.resume(&mouse_up, false);
        let _ = drain(&mut context, after_mouse_up);
    }

    #[test]
    fn cancelled_final_pointerup_still_runs_the_click_default() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let up = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        }));
        let mouse_up = event(context.resume(&up, true));
        assert_eq!(mouse_up.event_type, "mouseup");
        let after_mouse_up = context.resume(&mouse_up, false);
        let (types, _, _) = drain(&mut context, after_mouse_up);
        assert!(types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn cancelled_mouseup_still_runs_the_click_default() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let pointer_up = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(pointer_up.event_type, "pointerup");
        let mouse_up = event(context.resume(&pointer_up, false));
        assert_eq!(mouse_up.event_type, "mouseup");
        let after_mouse_up = context.resume(&mouse_up, true);
        let (types, _, _) = drain(&mut context, after_mouse_up);
        assert!(types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn aborting_final_pointerup_clears_compatibility_mouse_suppression() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));

        let down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        complete(context.resume(&down, true));

        let final_up = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(final_up.event_type, "pointerup");
        let _ = context.abort(final_up.frame_id);

        let next_down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        assert_eq!(
            drain_pointer_mouse_records(&mut context, next_down),
            [
                ("pointerdown".to_owned(), 0, 1),
                ("mousedown".to_owned(), 0, 1)
            ]
        );
    }

    #[test]
    fn unmatched_primary_release_does_not_click() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(types.iter().any(|event_type| event_type == "pointerup"));
        assert!(types.iter().any(|event_type| event_type == "mouseup"));
        assert!(!types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn crossed_primary_release_clicks_the_nearest_common_ancestor() {
        let mut context = TestContext::new(
            "<div id='parent' style='display:flex;width:220px;height:60px'>\
               <div id='a' style='width:100px;height:40px'></div>\
               <div id='b' style='width:100px;height:40px'></div>\
             </div>",
        );
        let parent = context.element("parent");
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(ax, ay, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let mut step = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let mut click_target = None;
        while let DispatchStep::Event(current) = step {
            if current.event_type == "click" {
                click_target = context.handles.resolve(current.target);
            }
            step = context.resume(&current, false);
        }
        assert_eq!(click_target, Some(parent));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the trusted second release retains its exact integral timestamp"
    )]
    fn double_click_uses_final_target_sequence_and_follows_click_defaults() {
        let mut context =
            TestContext::new("<input id='box' type='checkbox' style='width:24px;height:24px'>");
        let checkbox = context.element("box");
        let (x, y) = context.center(checkbox);
        assert!(context.document.set_hover_to(x, y));

        let first = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let second = dispatch_click_at(
            &mut context,
            x + 2.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            599.0,
            2,
        );
        let click_details = first
            .iter()
            .chain(&second)
            .filter(|event| event.event_type == "click")
            .map(|event| {
                let Some(DispatchEventPayload::Pointer(payload)) = event.payload.as_deref() else {
                    panic!("click should carry a pointer payload");
                };
                payload.mouse.detail
            })
            .collect::<Vec<_>>();
        assert_eq!(click_details, [1, 2]);

        let second_types = second
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        let click_index = second_types
            .iter()
            .position(|kind| *kind == "click")
            .unwrap();
        let input_index = second_types
            .iter()
            .position(|kind| *kind == "input")
            .unwrap();
        let double_index = second_types
            .iter()
            .position(|kind| *kind == "dblclick")
            .unwrap();
        assert!(click_index < input_index && input_index < double_index);
        assert_eq!(
            second_types
                .iter()
                .filter(|kind| **kind == "dblclick")
                .count(),
            1,
            "the poisoned Blitz double-click must be replaced rather than duplicated",
        );
        let double_click = &second[double_index];
        assert_eq!(context.handles.resolve(double_click.target), Some(checkbox));
        assert_eq!(double_click.time_stamp, 600.0);
        let Some(DispatchEventPayload::Mouse(payload)) = double_click.payload.as_deref() else {
            panic!("dblclick should carry a mouse payload");
        };
        assert_eq!(payload.button, 0);
        assert_eq!(payload.detail, 2);
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .expect("checkbox should expose checkedness")
        );

        let third = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            700.0,
            3,
        );
        assert!(!third.iter().any(|event| event.event_type == "dblclick"));
        let third_click = third
            .iter()
            .find(|event| event.event_type == "click")
            .unwrap();
        let Some(DispatchEventPayload::Pointer(payload)) = third_click.payload.as_deref() else {
            panic!("click should carry a pointer payload");
        };
        assert_eq!(payload.mouse.detail, 3);
    }

    #[test]
    fn intervening_auxclick_breaks_the_primary_double_click_sequence() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));

        let first = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let auxiliary = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Auxiliary,
            MouseEventButtons::Auxiliary,
            200.0,
            1,
        );
        let second_primary = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            300.0,
            1,
        );
        for events in [&first, &auxiliary, &second_primary] {
            let click = events
                .iter()
                .find(|event| matches!(event.event_type.as_str(), "click" | "auxclick"))
                .unwrap();
            let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
                panic!("click-family event should carry a pointer payload");
            };
            assert_eq!(payload.mouse.detail, 1);
        }
        assert!(
            !second_primary
                .iter()
                .any(|event| event.event_type == "dblclick")
        );

        let restarted_second = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            400.0,
            2,
        );
        assert!(
            restarted_second
                .iter()
                .any(|event| event.event_type == "dblclick")
        );
    }

    #[test]
    fn an_intervening_drag_breaks_the_completed_click_sequence() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let down = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            200.0,
            2,
        ));
        let _ = drain(&mut context, down);
        let moved = context.begin(pointer_request_at(
            x + 3.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Move,
            201.0,
            0,
        ));
        let _ = drain(&mut context, moved);
        let up = context.begin(pointer_request_at(
            x + 3.0,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            202.0,
            2,
        ));
        let (drag_types, _, _) = drain(&mut context, up);
        assert!(!drag_types.iter().any(|kind| kind == "click"));

        let after_drag = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            300.0,
            3,
        );
        let click = after_drag
            .iter()
            .find(|event| event.event_type == "click")
            .unwrap();
        let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
            panic!("click should carry a pointer payload");
        };
        assert_eq!(payload.mouse.detail, 1);
        assert!(
            !after_drag
                .iter()
                .any(|event| event.event_type == "dblclick")
        );
    }

    #[test]
    fn double_click_uses_native_sequence_and_final_target() {
        for (second_time, offset, native_detail, expected_detail, expected_double) in [
            (599.0, 2.0, 2, 2, true),
            (600.0, 0.0, 1, 1, false),
            (599.0, 2.25, 3, 1, false),
        ] {
            let mut context = TestContext::new(
                "<div id='target' style='display:block;width:100px;height:40px'></div>",
            );
            let target = context.element("target");
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));
            let _ = dispatch_click_at(
                &mut context,
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
                100.0,
                1,
            );
            let second = dispatch_click_at(
                &mut context,
                x + offset,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
                second_time,
                native_detail,
            );
            let click = second
                .iter()
                .find(|event| event.event_type == "click")
                .unwrap();
            let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
                panic!("click should carry a pointer payload");
            };
            assert_eq!(payload.mouse.detail, expected_detail);
            assert_eq!(
                second.iter().any(|event| event.event_type == "dblclick"),
                expected_double,
            );
        }

        let mut context = TestContext::new(
            "<div id='a' style='display:block;width:100px;height:40px'></div>\
             <div id='b' style='display:block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        let _ = dispatch_click_at(
            &mut context,
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let _ = dispatch_click_at(
            &mut context,
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            200.0,
            2,
        );
        let next_a = dispatch_click_at(
            &mut context,
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            300.0,
            3,
        );
        let click = next_a
            .iter()
            .find(|event| event.event_type == "click")
            .unwrap();
        let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
            panic!("click should carry a pointer payload");
        };
        assert_eq!(payload.mouse.detail, 1);
        assert!(!next_a.iter().any(|event| event.event_type == "dblclick"));
    }

    #[test]
    fn crossed_clicks_can_qualify_their_common_parent_for_double_click() {
        let mut context = TestContext::new(
            "<div id='parent' style='display:flex;width:240px;height:80px'>\
               <div id='a' style='width:100px;height:40px'></div>\
               <div id='b' style='width:100px;height:40px'></div>\
             </div>",
        );
        let parent = context.element("parent");
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let down = context.begin(pointer_request_at(
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            100.0,
            1,
        ));
        let _ = drain(&mut context, down);
        let crossed = context.begin(pointer_request_at(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            101.0,
            1,
        ));
        let crossed = drain_steps(&mut context, crossed);
        let crossed_click = crossed
            .iter()
            .find(|event| event.event_type == "click")
            .unwrap();
        assert_eq!(context.handles.resolve(crossed_click.target), Some(parent));

        {
            let mut mutator = context.document.mutate();
            mutator.remove_node(a);
            mutator.remove_node(b);
        }
        context.document.resolve(0.0);
        assert_eq!(
            context
                .document
                .hit(ax, ay)
                .and_then(|hit| pointer_author_target_id(&context.document, hit.node_id)),
            Some(parent),
        );

        let parent_click = dispatch_click_at(
            &mut context,
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            200.0,
            2,
        );
        let click = parent_click
            .iter()
            .find(|event| event.event_type == "click")
            .unwrap();
        let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
            panic!("click should carry a pointer payload");
        };
        assert_eq!(payload.mouse.detail, 2);
        let double_click = parent_click
            .iter()
            .find(|event| event.event_type == "dblclick")
            .expect("matching completed click targets should qualify dblclick");
        assert_eq!(context.handles.resolve(double_click.target), Some(parent));
    }

    #[test]
    fn cancelling_the_second_click_still_dispatches_double_click() {
        let mut context =
            TestContext::new("<input id='box' type='checkbox' style='width:24px;height:24px'>");
        let checkbox = context.element("box");
        let (x, y) = context.center(checkbox);
        assert!(context.document.set_hover_to(x, y));
        let _ = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );

        let down = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            200.0,
            2,
        ));
        let _ = drain(&mut context, down);
        let mut step = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            201.0,
            2,
        ));
        let mut types = Vec::new();
        while let DispatchStep::Event(current) = step {
            types.push(current.event_type.clone());
            step = context.resume(&current, current.event_type == "click");
        }
        assert!(types.iter().any(|kind| kind == "dblclick"));
        assert!(!types.iter().any(|kind| kind == "input"));
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );
    }

    #[test]
    fn cancelling_the_second_mouseup_still_dispatches_click_and_double_click() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let down = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            200.0,
            2,
        ));
        let _ = drain(&mut context, down);
        let mut step = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            201.0,
            2,
        ));
        let mut types = Vec::new();
        while let DispatchStep::Event(current) = step {
            types.push(current.event_type.clone());
            step = context.resume(&current, current.event_type == "mouseup");
        }
        assert!(types.iter().any(|kind| kind == "click"));
        assert!(types.iter().any(|kind| kind == "dblclick"));
    }

    #[test]
    fn double_click_keeps_its_target_but_uses_listener_mutated_ancestry() {
        let mut context = TestContext::new(
            "<div id='old'><button id='target' style='width:80px;height:30px'>go</button></div>\
             <div id='new'></div>",
        );
        let target = context.element("target");
        let new_parent = context.element("new");
        let new_parent_handle = context.handles.expose(new_parent).unwrap();
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );

        let down = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            200.0,
            2,
        ));
        let _ = drain(&mut context, down);
        let up = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            201.0,
            2,
        ));
        let click = next_event_of_type(&mut context, up, "click");
        {
            let mut mutator = context.document.mutate();
            mutator.remove_node(target);
            mutator.append_children(new_parent, &[target]);
        }
        let after_click = context.resume(&click, false);
        let events = drain_steps(&mut context, after_click);
        let double_click = events
            .iter()
            .find(|event| event.event_type == "dblclick")
            .expect("moving the live target should retain dblclick");
        assert_eq!(context.handles.resolve(double_click.target), Some(target));
        assert!(double_click.path.contains(&new_parent_handle));
    }

    #[test]
    fn detaching_the_second_click_target_suppresses_pending_double_click() {
        let mut context =
            TestContext::new("<button id='target' style='width:80px;height:30px'>go</button>");
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let _ = dispatch_click_at(
            &mut context,
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            100.0,
            1,
        );
        let down = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            200.0,
            2,
        ));
        let _ = drain(&mut context, down);
        let up = context.begin(pointer_request_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            201.0,
            2,
        ));
        let click = next_event_of_type(&mut context, up, "click");
        context.document.mutate().remove_node(target);
        let after_click = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, after_click);
        assert!(!types.iter().any(|kind| kind == "dblclick"));
    }

    #[test]
    fn detaching_the_press_target_before_mouseup_suppresses_click() {
        let mut context = TestContext::new(
            "<div style='display:flex;width:220px;height:60px'>\
               <div id='a' style='width:100px;height:40px'></div>\
               <div id='b' style='width:100px;height:40px'></div>\
             </div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(ax, ay, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let pointer_up = next_event_of_type(&mut context, up, "pointerup");
        context.document.mutate().remove_node(a);
        let after_pointer_up = context.resume(&pointer_up, false);
        let (types, _, _) = drain(&mut context, after_pointer_up);
        assert!(!types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    fn a_reused_press_target_generation_cannot_match_release() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);
        let stale_handle = context
            .handles
            .invalidate_node(target)
            .expect("the press target should have a public handle");
        let replacement_handle = context
            .handles
            .expose(target)
            .expect("the replacement generation should fit");
        assert_ne!(replacement_handle, stale_handle);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(!types.iter().any(|event_type| event_type == "click"));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the Pointer Events defaults and fixed mouse pointer id are exact constants"
    )]
    fn matched_non_primary_releases_emit_pointer_auxclick() {
        for (button, mask, number) in [
            (MouseEventButton::Auxiliary, MouseEventButtons::Auxiliary, 1),
            (MouseEventButton::Secondary, MouseEventButtons::Secondary, 2),
            (MouseEventButton::Fourth, MouseEventButtons::Fourth, 3),
            (MouseEventButton::Fifth, MouseEventButtons::Fifth, 4),
        ] {
            let mut context = TestContext::new(
                "<div id='target' style='display:block;width:100px;height:40px'></div>",
            );
            let target = context.element("target");
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));
            let down = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, mask),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            });
            let _ = drain(&mut context, down);

            let mut step = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, MouseEventButtons::None),
                flavor: PointerFlavor::Up,
                metadata: EventMetadata::native(),
            });
            let mut types = Vec::new();
            let mut aux_payload = None;
            while let DispatchStep::Event(current) = step {
                types.push(current.event_type.clone());
                if current.event_type == "auxclick" {
                    let Some(DispatchEventPayload::Pointer(payload)) = current.payload.as_deref()
                    else {
                        panic!("auxclick should carry a pointer payload");
                    };
                    assert!(!payload.is_primary);
                    assert_eq!(payload.pressure, 0.0);
                    assert_eq!(payload.tangential_pressure, 0.0);
                    assert_eq!(payload.tilt_x, 0);
                    assert_eq!(payload.tilt_y, 0);
                    assert_eq!(payload.twist, 0);
                    assert_eq!(payload.altitude_angle, std::f64::consts::FRAC_PI_2);
                    assert_eq!(payload.azimuth_angle, 0.0);
                    assert_eq!(payload.persistent_device_id, 0);
                    aux_payload = Some((
                        context.handles.resolve(current.target),
                        payload.mouse.button,
                        payload.mouse.buttons,
                    ));
                }
                step = context.resume(&current, false);
            }
            assert_eq!(aux_payload, Some((Some(target), number, 0)));
            assert_eq!(
                types
                    .iter()
                    .filter(|event_type| *event_type == "auxclick")
                    .count(),
                1
            );
            if matches!(button, MouseEventButton::Secondary) {
                let context_index = types
                    .iter()
                    .position(|event_type| event_type == "contextmenu")
                    .expect("secondary release should emit contextmenu");
                let aux_index = types
                    .iter()
                    .position(|event_type| event_type == "auxclick")
                    .expect("secondary release should emit auxclick");
                assert!(context_index < aux_index);
            }
        }
    }

    #[test]
    fn auxclick_survives_pointer_cancellation_but_not_a_drag() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Auxiliary,
                MouseEventButtons::Auxiliary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        complete(context.resume(&down, true));
        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Auxiliary, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(types.iter().any(|event_type| event_type == "auxclick"));

        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Auxiliary,
                MouseEventButtons::Auxiliary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);
        let moved = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x + 3.0,
                y,
                MouseEventButton::Auxiliary,
                MouseEventButtons::Auxiliary,
            ),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, moved);
        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x + 3.0,
                y,
                MouseEventButton::Auxiliary,
                MouseEventButtons::None,
            ),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(!types.iter().any(|event_type| event_type == "auxclick"));
    }

    #[test]
    fn auxclick_retargets_after_the_preceding_contextmenu_listener() {
        let mut context = TestContext::new(
            "<div id='old' style='display:flex;width:220px;height:60px'>\
               <div id='down' style='width:100px;height:40px'></div>\
               <div id='up' style='width:100px;height:40px'></div>\
             </div>\
             <div id='new'></div>",
        );
        let down_target = context.element("down");
        let up_target = context.element("up");
        let new_parent = context.element("new");
        let (down_x, down_y) = context.center(down_target);
        let (up_x, up_y) = context.center(up_target);
        assert!(context.document.set_hover_to(down_x, down_y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(
                down_x,
                down_y,
                MouseEventButton::Secondary,
                MouseEventButtons::Secondary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(
                up_x,
                up_y,
                MouseEventButton::Secondary,
                MouseEventButtons::None,
            ),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let contextmenu = next_event_of_type(&mut context, up, "contextmenu");
        {
            let mut mutator = context.document.mutate();
            mutator.remove_node(down_target);
            mutator.remove_node(up_target);
            mutator.append_children(new_parent, &[down_target, up_target]);
        }
        let mut step = context.resume(&contextmenu, false);
        let mut aux_target = None;
        while let DispatchStep::Event(current) = step {
            if current.event_type == "auxclick" {
                aux_target = context.handles.resolve(current.target);
            }
            step = context.resume(&current, false);
        }
        assert_eq!(aux_target, Some(new_parent));
    }

    #[test]
    fn auxclick_does_not_reuse_primary_control_activation() {
        let mut context =
            TestContext::new("<input id='box' type='checkbox' style='width:24px;height:24px'>");
        let checkbox = context.element("box");
        let (x, y) = context.center(checkbox);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(
                x,
                y,
                MouseEventButton::Auxiliary,
                MouseEventButtons::Auxiliary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let _ = drain(&mut context, down);
        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Auxiliary, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);

        assert!(types.iter().any(|event_type| event_type == "auxclick"));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .expect("checkbox should expose checkedness")
        );
    }

    #[test]
    fn trusted_pointer_targets_use_layout_resolved_at_occurrence() {
        let mut context = TestContext::new(
            "<div id='old' style='position:absolute;left:0;top:0;width:100px;height:100px'></div>\
             <div id='new' style='position:absolute;left:240px;top:0;width:100px;height:100px'></div>",
        );
        let old = context.element("old");
        let new = context.element("new");
        let point = (40.0, 40.0);
        assert_eq!(
            context
                .document
                .hit(point.0, point.1)
                .map(|hit| hit.node_id),
            Some(old)
        );

        let away_style = "position:absolute;left:240px;top:0;width:100px;height:100px";
        let here_style = "position:absolute;left:0;top:0;width:100px;height:100px";
        context.set_style(old, away_style);
        context.set_style(new, here_style);
        // Mutation invalidates style/layout but does not itself paint or resolve geometry.
        assert_eq!(
            context
                .document
                .hit(point.0, point.1)
                .map(|hit| hit.node_id),
            Some(old)
        );
        let step = context.begin_trusted_pointer(
            point.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let pointer_move = next_event_of_type(&mut context, step, "pointermove");
        assert_eq!(context.handles.resolve(pointer_move.target), Some(new));
        let remainder = context.resume(&pointer_move, false);
        let _ = drain(&mut context, remainder);

        context.set_style(old, here_style);
        context.set_style(new, away_style);
        assert_eq!(
            context
                .document
                .hit(point.0, point.1)
                .map(|hit| hit.node_id),
            Some(new)
        );
        let step = context.begin_trusted_pointer(
            point.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let down = next_event_of_type(&mut context, step, "pointerdown");
        assert_eq!(context.handles.resolve(down.target), Some(old));
        let remainder = context.resume(&down, false);
        let _ = drain(&mut context, remainder);

        context.set_style(old, away_style);
        context.set_style(new, here_style);
        assert_eq!(
            context
                .document
                .hit(point.0, point.1)
                .map(|hit| hit.node_id),
            Some(old)
        );
        let step = context.begin_trusted_pointer(
            point.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
        );
        let up = next_event_of_type(&mut context, step, "pointerup");
        assert_eq!(context.handles.resolve(up.target), Some(new));
        let remainder = context.resume(&up, false);
        let _ = drain(&mut context, remainder);
    }

    #[test]
    fn trusted_wheel_default_uses_layout_resolved_at_occurrence() {
        let mut context = TestContext::new(
            "<div id='scroller' style='overflow:auto;width:120px;height:80px'>\
               <div id='content' style='height:40px'></div>\
             </div>",
        );
        let scroller = context.element("scroller");
        let content_id = context.element("content");
        let point = context.center(content_id);
        assert!(context.document.set_hover_to(point.0, point.1));
        assert!(
            context
                .document
                .get_node(scroller)
                .expect("scroller should exist")
                .final_layout
                .scroll_height()
                .abs()
                < f32::EPSILON
        );

        context.set_style(content_id, "height:400px");
        // Until trusted input flushes layout, Blitz still sees the old non-scrollable geometry.
        assert!(
            context
                .document
                .get_node(scroller)
                .expect("scroller should exist")
                .final_layout
                .scroll_height()
                .abs()
                < f32::EPSILON
        );
        let wheel_event = event(context.begin_trusted_wheel(point.0, point.1));
        assert_eq!(wheel_event.event_type, "wheel");
        let remainder = context.resume(&wheel_event, false);
        let _ = drain(&mut context, remainder);
        assert!(
            (context
                .document
                .get_node(scroller)
                .expect("scroller should exist")
                .scroll_offset
                .y
                - 20.0)
                .abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn trusted_wheel_reports_viewport_scroll_and_cancellation_suppresses_it() {
        let body = "<div id='target' style='height:1200px'>target</div>";
        let mut cancelled_context = TestContext::new(body);
        let target = cancelled_context.element("target");
        let point = cancelled_context
            .point_hitting(target)
            .expect("tall document target should be hittable");
        let wheel = event(cancelled_context.begin_trusted_wheel(point.0, point.1));
        let completed = cancelled_context.resume(&wheel, true);
        let (_, redraw_requested) = complete(completed);
        assert!(!redraw_requested);
        assert!(cancelled_context.document.viewport_scroll().y.abs() < f64::EPSILON);

        let mut context = TestContext::new(body);
        let root = context.document.root_element().id;
        let target = context.element("target");
        let point = context
            .point_hitting(target)
            .expect("tall document target should be hittable");
        let wheel = event(context.begin_trusted_wheel(point.0, point.1));
        let scroll = event(context.resume(&wheel, false));
        assert_eq!(scroll.event_type, "scroll");
        assert_eq!(context.handles.resolve(scroll.target), Some(root));
        let (_, redraw_requested) = complete(context.resume(&scroll, false));
        assert!(redraw_requested);
        assert!(context.document.viewport_scroll().y > 0.0);
    }

    #[test]
    fn viewport_scroll_marker_follows_nested_element_markers() {
        let mut context = TestContext::new(
            "<div id='scroller' style='overflow:auto;width:120px;height:60px'>\
               <div id='target' style='height:300px'>target</div>\
             </div>\
             <div style='height:1200px'></div>",
        );
        let root = context.document.root_element().id;
        let scroller = context.element("scroller");
        let target = context.element("target");
        let point = context
            .point_hitting(target)
            .expect("nested scroll target should be hittable");
        let scroll_limit = f64::from(
            context
                .document
                .get_node(scroller)
                .expect("scroller should exist")
                .final_layout
                .scroll_height(),
        );
        assert!(scroll_limit > 10.0);
        context
            .document
            .get_node_mut(scroller)
            .expect("scroller should exist")
            .scroll_offset
            .y = scroll_limit - 10.0;

        let wheel = event(context.begin_trusted_wheel(point.0, point.1));
        let element_scroll = event(context.resume(&wheel, false));
        assert_eq!(element_scroll.event_type, "scroll");
        assert_eq!(
            context.handles.resolve(element_scroll.target),
            Some(scroller)
        );

        // Scroll is noncancelable. Even incorrect cancellation feedback must not hide the later
        // viewport marker which belongs to the same default action.
        let viewport_scroll = event(context.resume(&element_scroll, true));
        assert_eq!(viewport_scroll.event_type, "scroll");
        assert_eq!(context.handles.resolve(viewport_scroll.target), Some(root));
        let (_, redraw_requested) = complete(context.resume(&viewport_scroll, false));
        assert!(redraw_requested);
        assert!(context.document.viewport_scroll().y > 0.0);
    }

    #[test]
    fn first_trusted_wheel_uses_its_occurrence_hit_without_hover() {
        let mut context = TestContext::new(
            "<div id='scroller' style='overflow:auto;width:120px;height:60px'>\
               <div id='target' style='display:block;width:100px;padding:4px'>\
                 <span>inline text</span><div style='display:block;height:20px'>block</div>\
               </div>\
               <div style='height:300px'></div>\
             </div>",
        );
        let scroller = context.element("scroller");
        let target = context.element("target");
        let (raw_target, point) = context
            .document
            .tree()
            .iter()
            .filter(|(_, node)| {
                node.parent == Some(target) && matches!(node.data, NodeData::AnonymousBlock(_))
            })
            .find_map(|(node_id, _)| context.point_hitting(node_id).map(|point| (node_id, point)))
            .expect("mixed inline/block children should create a hittable anonymous wrapper");
        let raw_hit = context
            .document
            .hit(point.0, point.1)
            .expect("wheel point should hit the anonymous wrapper");
        assert_eq!(raw_hit.node_id, raw_target);
        assert_eq!(
            public_dom_node_id(&context.document, raw_target),
            Some(target)
        );
        assert_eq!(context.document.get_hover_node_id(), None);

        let wheel = event(context.begin_trusted_wheel(point.0, point.1));
        assert_eq!(wheel.event_type, "wheel");
        assert_eq!(context.handles.resolve(wheel.target), Some(target));
        let occurrence_raw = context
            .stack
            .frames
            .last()
            .and_then(|frame| frame.pending.as_ref())
            .map(|pending| pending.guarded.default_target.raw)
            .expect("wheel should retain its raw occurrence hit");
        assert_ne!(occurrence_raw, target);
        assert_eq!(
            context
                .document
                .hit(point.0, point.1)
                .map(|hit| hit.node_id),
            Some(occurrence_raw)
        );
        assert_eq!(
            public_dom_node_id(&context.document, occurrence_raw),
            Some(target)
        );
        assert_eq!(context.document.get_hover_node_id(), None);
        let remainder = context.resume(&wheel, false);
        let _ = drain(&mut context, remainder);

        assert!(
            (context
                .document
                .get_node(scroller)
                .expect("scroller should exist")
                .scroll_offset
                .y
                - 20.0)
                .abs()
                < f64::EPSILON
        );
        assert_eq!(context.document.get_hover_node_id(), None);
    }

    #[test]
    fn trusted_wheel_ignores_stale_hover_at_another_node() {
        let mut context = TestContext::new(
            "<div id='left' style='position:absolute;left:0;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='left-target' style='height:300px'></div>\
             </div>\
             <div id='right' style='position:absolute;left:200px;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='right-target' style='height:300px'></div>\
             </div>",
        );
        let left = context.element("left");
        let left_target = context.element("left-target");
        let right = context.element("right");
        let right_target = context.element("right-target");
        let left_point = context
            .point_hitting(left_target)
            .expect("left target should be hittable");
        let right_point = context
            .point_hitting(right_target)
            .expect("right target should be hittable");
        assert!(context.document.set_hover_to(left_point.0, left_point.1));
        assert_eq!(context.document.get_hover_node_id(), Some(left_target));
        let _ = context.redraw.swap(false, Ordering::Relaxed);

        let wheel = event(context.begin_trusted_wheel(right_point.0, right_point.1));
        assert_eq!(wheel.event_type, "wheel");
        assert_eq!(context.handles.resolve(wheel.target), Some(right_target));
        assert_eq!(context.document.get_hover_node_id(), Some(left_target));
        let remainder = context.resume(&wheel, false);
        let _ = drain(&mut context, remainder);

        assert!(
            context
                .document
                .get_node(left)
                .expect("left scroller should exist")
                .scroll_offset
                .y
                .abs()
                < f64::EPSILON
        );
        assert!(
            (context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y
                - 20.0)
                .abs()
                < f64::EPSILON
        );
        assert_eq!(context.document.get_hover_node_id(), Some(left_target));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "native coordinates and integral line-scroll defaults are copied exactly"
    )]
    fn wheel_transaction_retains_its_first_target_until_the_idle_timeout() {
        let mut context = TestContext::new(
            "<div id='left' style='position:absolute;left:0;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='left-target' style='height:300px'></div>\
             </div>\
             <div id='right' style='position:absolute;left:200px;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='right-target' style='height:300px'></div>\
             </div>",
        );
        let left = context.element("left");
        let left_target = context.element("left-target");
        let right = context.element("right");
        let right_target = context.element("right-target");
        let left_point = context
            .point_hitting(left_target)
            .expect("left target should be hittable");
        let right_point = context
            .point_hitting(right_target)
            .expect("right target should be hittable");

        let first = event(context.begin_trusted_wheel_at(left_point.0, left_point.1, 100.0));
        assert_eq!(context.handles.resolve(first.target), Some(left_target));
        let resumed = context.resume(&first, false);
        let _ = drain(&mut context, resumed);

        let second = event(context.begin_trusted_wheel_at(right_point.0, right_point.1, 200.0));
        assert_eq!(context.handles.resolve(second.target), Some(left_target));
        let Some(DispatchEventPayload::Wheel(payload)) = second.payload.as_deref() else {
            panic!("wheel should carry its occurrence coordinates");
        };
        assert_eq!(payload.mouse.client_x, f64::from(right_point.0));
        assert_eq!(payload.mouse.client_y, f64::from(right_point.1));
        let resumed = context.resume(&second, false);
        let _ = drain(&mut context, resumed);

        assert_eq!(
            context
                .document
                .get_node(left)
                .expect("left scroller should exist")
                .scroll_offset
                .y,
            40.0
        );
        assert_eq!(
            context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y,
            0.0
        );

        let after_timeout = event(context.begin_trusted_wheel_at(
            right_point.0,
            right_point.1,
            200.0 + WHEEL_TRANSACTION_TIMEOUT_MS + 1.0,
        ));
        assert_eq!(
            context.handles.resolve(after_timeout.target),
            Some(right_target)
        );
        let resumed = context.resume(&after_timeout, false);
        let _ = drain(&mut context, resumed);
        assert_eq!(
            context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y,
            20.0
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "integral line-scroll defaults and canceled zero offsets are exact"
    )]
    fn cancelled_wheel_keeps_its_transaction_without_running_a_default() {
        let mut context = TestContext::new(
            "<div id='left' style='position:absolute;left:0;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='left-target' style='height:300px'></div>\
             </div>\
             <div id='right' style='position:absolute;left:200px;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='right-target' style='height:300px'></div>\
             </div>",
        );
        let left = context.element("left");
        let left_target = context.element("left-target");
        let right = context.element("right");
        let right_target = context.element("right-target");
        let left_point = context
            .point_hitting(left_target)
            .expect("left target should be hittable");
        let right_point = context
            .point_hitting(right_target)
            .expect("right target should be hittable");

        let cancelled = event(context.begin_trusted_wheel_at(left_point.0, left_point.1, 100.0));
        let resumed = context.resume(&cancelled, true);
        let (generated, _, _) = drain(&mut context, resumed);
        assert!(generated.is_empty());
        assert_eq!(context.document.viewport_scroll().y, 0.0);
        assert_eq!(
            context
                .document
                .get_node(left)
                .expect("left scroller should exist")
                .scroll_offset
                .y,
            0.0
        );

        let retained = event(context.begin_trusted_wheel_at(right_point.0, right_point.1, 200.0));
        assert_eq!(context.handles.resolve(retained.target), Some(left_target));
        let resumed = context.resume(&retained, false);
        let _ = drain(&mut context, resumed);
        assert_eq!(
            context
                .document
                .get_node(left)
                .expect("left scroller should exist")
                .scroll_offset
                .y,
            20.0
        );
        assert_eq!(
            context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y,
            0.0
        );

        let stale_handle = context
            .handles
            .invalidate_node(left_target)
            .expect("the transaction target should have a public handle");
        context.document.mutate().remove_and_drop_node(left_target);
        assert_eq!(context.handles.resolve(stale_handle), None);
        let replacement =
            event(context.begin_trusted_wheel_at(right_point.0, right_point.1, 300.0));
        assert_eq!(
            context.handles.resolve(replacement.target),
            Some(right_target)
        );
        let resumed = context.resume(&replacement, false);
        let _ = drain(&mut context, resumed);
        assert_eq!(
            context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y,
            20.0
        );
    }

    #[test]
    #[allow(clippy::float_cmp, reason = "integral line-scroll defaults are exact")]
    fn wheel_transaction_keeps_its_element_when_the_raw_hit_moves() {
        let mut context = TestContext::new(
            "<div id='left' style='position:absolute;left:0;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='left-target' style='height:300px'>wheel text</div>\
             </div>\
             <div id='right' style='position:absolute;left:200px;top:0;overflow:auto;width:120px;height:60px'>\
               <div id='right-target' style='height:300px'></div>\
             </div>",
        );
        let left = context.element("left");
        let left_target = context.element("left-target");
        let right = context.element("right");
        let right_target = context.element("right-target");
        let text = context.text_child(left_target);
        let left_point = context
            .glyph_points_targeting(left_target)
            .into_iter()
            .next()
            .expect("left text should be hittable");
        let right_point = context
            .point_hitting(right_target)
            .expect("right target should be hittable");

        let first = event(context.begin_trusted_wheel_at(left_point.0, left_point.1, 100.0));
        assert_eq!(context.handles.resolve(first.target), Some(left_target));
        let resumed = context.resume(&first, false);
        let _ = drain(&mut context, resumed);

        {
            let mut mutator = context.document.mutate();
            mutator.remove_node(text);
            mutator.append_children(right_target, &[text]);
        }
        let second = event(context.begin_trusted_wheel_at(right_point.0, right_point.1, 200.0));
        assert_eq!(context.handles.resolve(second.target), Some(left_target));
        let resumed = context.resume(&second, false);
        let _ = drain(&mut context, resumed);

        assert_eq!(
            context
                .document
                .get_node(left)
                .expect("left scroller should exist")
                .scroll_offset
                .y,
            40.0
        );
        assert_eq!(
            context
                .document
                .get_node(right)
                .expect("right scroller should exist")
                .scroll_offset
                .y,
            0.0
        );
    }

    #[test]
    fn pointer_down_ends_the_active_wheel_transaction() {
        let mut context = TestContext::new(
            "<div id='left' style='position:absolute;left:0;top:0;width:120px;height:60px'></div>\
             <div id='right' style='position:absolute;left:200px;top:0;width:120px;height:60px'></div>",
        );
        let left = context.element("left");
        let right = context.element("right");
        let left_point = context.center(left);
        let right_point = context.center(right);

        let first = event(context.begin_trusted_wheel_at(left_point.0, left_point.1, 100.0));
        assert_eq!(context.handles.resolve(first.target), Some(left));
        let resumed = context.resume(&first, true);
        let _ = drain(&mut context, resumed);

        let pointer_down = context.begin_trusted_pointer(
            right_point.0,
            right_point.1,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, pointer_down);

        let next = event(context.begin_trusted_wheel_at(right_point.0, right_point.1, 120.0));
        assert_eq!(context.handles.resolve(next.target), Some(right));
        let resumed = context.resume(&next, true);
        let _ = drain(&mut context, resumed);
    }

    #[test]
    fn stationary_pointer_refresh_emits_layout_boundaries_without_moving_the_baseline() {
        let mut context = TestContext::new(
            "<div id='b' style='position:absolute;left:0;top:0;width:100px;height:40px'></div>\
             <div id='a' style='position:absolute;left:0;top:0;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let point = context
            .point_hitting(a)
            .expect("the front element should be hittable");

        let first = context.begin_trusted_pointer(
            point.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let _ = drain(&mut context, first);
        assert_eq!(context.document.get_hover_node_id(), Some(a));
        let baseline = context.stack.last_mouse_move;
        assert!(context.stack.stationary_pointer.is_some());

        context.set_style(
            a,
            "position:absolute;left:200px;top:0;width:100px;height:40px",
        );
        let refresh = context.begin_stationary_pointer_refresh();
        let boundaries = drain_steps(&mut context, refresh);
        let types = boundaries
            .iter()
            .map(|step| step.event_type.as_str())
            .collect::<Vec<_>>();
        assert!(types.contains(&"pointerout"));
        assert!(types.contains(&"pointerleave"));
        assert!(types.contains(&"pointerover"));
        assert!(types.contains(&"pointerenter"));
        assert!(types.contains(&"mouseout"));
        assert!(types.contains(&"mouseover"));
        assert!(!types.contains(&"pointermove"));
        assert!(!types.contains(&"mousemove"));
        assert_eq!(context.document.get_hover_node_id(), Some(b));
        assert_eq!(context.stack.last_mouse_move, baseline);

        let moved = context.begin_trusted_pointer(
            point.0 + 5.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let pointer_move = next_event_of_type(&mut context, moved, "pointermove");
        let Some(DispatchEventPayload::Pointer(payload)) = pointer_move.payload.as_deref() else {
            panic!("pointermove should carry a pointer payload");
        };
        assert_eq!(
            (payload.mouse.movement_x, payload.mouse.movement_y),
            (5.0, 0.0)
        );
        let resumed = context.resume(&pointer_move, false);
        let _ = drain(&mut context, resumed);
    }

    #[test]
    fn native_pointer_presence_records_update_and_clear_the_stationary_snapshot() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:100px;height:40px'></div>",
        );
        let target = context.element("target");
        let point = context.center(target);

        let moved = context.begin_trusted_pointer(
            point.0,
            point.1,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
        );
        let _ = drain(&mut context, moved);
        assert!(context.stack.stationary_pointer.is_some());

        let left = context.begin_trusted_boundary(
            point.0,
            point.1,
            MouseEventButtons::None,
            0,
            2.0,
            None,
            NativePointerBoundary::Leave,
        );
        let _ = drain(&mut context, left);
        assert!(context.stack.stationary_pointer.is_none());

        let entered = context.begin_trusted_boundary(
            point.0,
            point.1,
            MouseEventButtons::None,
            0,
            3.0,
            None,
            NativePointerBoundary::Enter,
        );
        let _ = drain(&mut context, entered);
        assert!(context.stack.stationary_pointer.is_some());

        let canceled = context.begin(pointer_cancel_request_at(
            point.0,
            point.1,
            MouseEventButtons::Primary,
            EventMetadata::pointer(
                4.0,
                native_pointer_coordinates(f64::from(point.0), f64::from(point.1), None, 0.0, 0.0),
                0,
            ),
        ));
        complete(canceled);
        assert!(context.stack.stationary_pointer.is_none());

        let wheel = context.begin_trusted_wheel(point.0, point.1);
        let _ = drain(&mut context, wheel);
        assert!(context.stack.stationary_pointer.is_some());
    }

    #[test]
    fn related_targets_are_checked_when_each_boundary_step_stages() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        assert!(context.document.set_hover_to(ax, ay));
        let related_handle = context.handles.expose(b).unwrap();
        let metadata = EventMetadata::pointer(
            10.0,
            native_pointer_coordinates(f64::from(bx), f64::from(by), None, 0.0, 0.0),
            0,
        );

        let pointer_out = event(context.begin(DispatchRequest::Pointer {
            event: pointer(bx, by, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Move,
            metadata,
        }));
        assert_eq!(pointer_out.event_type, "pointerout");
        let Some(DispatchEventPayload::Pointer(payload)) = pointer_out.payload.as_deref() else {
            panic!("pointerout should carry a pointer payload");
        };
        assert_eq!(payload.mouse.related_target, Some(related_handle));

        // Detachment preserves node identity, so the following mouseout still exposes B.
        context.document.mutate().remove_node(b);
        let mouse_out = event(context.resume(&pointer_out, false));
        assert_eq!(mouse_out.event_type, "mouseout");
        let Some(DispatchEventPayload::Mouse(payload)) = mouse_out.payload.as_deref() else {
            panic!("mouseout should carry a mouse payload");
        };
        assert_eq!(payload.related_target, Some(related_handle));

        // Destruction invalidates the generation. The still-valid leave event for A must stage
        // with null rather than handing TypeScript a handle it can no longer resolve.
        assert_eq!(context.handles.invalidate_node(b), Some(related_handle));
        context.document.mutate().remove_and_drop_node(b);
        let pointer_leave = event(context.resume(&mouse_out, false));
        assert_eq!(pointer_leave.event_type, "pointerleave");
        let Some(DispatchEventPayload::Pointer(payload)) = pointer_leave.payload.as_deref() else {
            panic!("pointerleave should carry a pointer payload");
        };
        assert_eq!(payload.mouse.related_target, None);
    }

    #[test]
    fn anonymous_hover_wrappers_do_not_duplicate_public_boundary_events() {
        let mut context = TestContext::new(
            "<div id='host' style='display:block;width:320px;padding:24px'>\
               <span>inline text</span><div style='display:block;height:40px'>block</div>\
             </div>",
        );
        let host = context.element("host");
        let (anonymous, anonymous_point) = context
            .document
            .tree()
            .iter()
            .filter(|(_, node)| {
                node.parent == Some(host) && matches!(node.data, NodeData::AnonymousBlock(_))
            })
            .find_map(|(node_id, _)| context.point_hitting(node_id).map(|point| (node_id, point)))
            .expect("mixed inline/block children should create a hittable anonymous wrapper");
        let host_point = context
            .point_hitting(host)
            .expect("host padding should be directly hittable");
        assert_eq!(public_dom_node_id(&context.document, anonymous), Some(host));
        assert!(
            context
                .document
                .set_hover_to(anonymous_point.0, anonymous_point.1)
        );
        assert_eq!(context.document.get_hover_node_id(), Some(anonymous));

        let pointer_move = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                host_point.0,
                host_point.1,
                MouseEventButton::Main,
                MouseEventButtons::None,
            ),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(context.handles.resolve(pointer_move.target), Some(host));
        assert_eq!(context.handles.resolve(pointer_move.path[0]), Some(host));
        let (types, _, _) = drain(&mut context, DispatchStep::Event(pointer_move));
        assert_eq!(types, ["pointermove", "mousemove"]);

        assert!(
            context
                .document
                .set_hover_to(anonymous_point.0, anonymous_point.1)
        );
        let pointer_down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                anonymous_point.0,
                anonymous_point.1,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(pointer_down.event_type, "pointerdown");
        assert_eq!(context.handles.resolve(pointer_down.target), Some(host));
        assert_eq!(context.handles.resolve(pointer_down.path[0]), Some(host));
        assert!(
            context
                .document
                .get_node(anonymous)
                .is_some_and(blitz_dom::Node::is_active)
        );
        complete(context.resume(&pointer_down, true));
        context.document.unactive_node();
    }

    #[test]
    fn text_glyph_pointer_targets_are_elements_while_raw_defaults_extend_selection() {
        let mut context =
            TestContext::new("<span id='label' style='font-size:32px'>Selectable words</span>");
        let label = context.element("label");
        let points = context.glyph_points_targeting(label);
        let start = points
            .iter()
            .copied()
            .min_by(|left, right| left.0.total_cmp(&right.0))
            .expect("the first text glyph should be hittable");
        let end = points
            .iter()
            .copied()
            .max_by(|left, right| left.0.total_cmp(&right.0))
            .expect("the last text glyph should be hittable");
        assert!(end.0 - start.0 > 2.0);
        let start_hit = context.document.hit(start.0, start.1).unwrap();
        let end_hit = context.document.hit(end.0, end.1).unwrap();
        assert!(start_hit.is_text);
        assert!(end_hit.is_text);
        assert_eq!(
            pointer_author_target_id(&context.document, start_hit.node_id),
            Some(label)
        );
        assert_eq!(
            pointer_author_target_id(&context.document, end_hit.node_id),
            Some(label)
        );
        assert!(context.document.set_hover_to(start.0, start.1));

        let pointer_down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                start.0,
                start.1,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
            ),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(context.handles.resolve(pointer_down.target), Some(label));
        assert_eq!(context.handles.resolve(pointer_down.path[0]), Some(label));
        assert_eq!(
            context
                .stack
                .frames
                .last()
                .and_then(|frame| frame.pending.as_ref())
                .map(|pending| pending.guarded.default_target.raw),
            Some(start_hit.node_id)
        );

        let mouse_down = event(context.resume(&pointer_down, false));
        assert_eq!(mouse_down.event_type, "mousedown");
        assert_eq!(context.handles.resolve(mouse_down.target), Some(label));
        complete(context.resume(&mouse_down, false));

        let pointer_move = event(context.begin(DispatchRequest::Pointer {
            event: pointer(
                end.0,
                end.1,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
            ),
            flavor: PointerFlavor::Move,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(pointer_move.event_type, "pointermove");
        assert_eq!(context.handles.resolve(pointer_move.target), Some(label));
        let mouse_move = event(context.resume(&pointer_move, false));
        assert_eq!(mouse_move.event_type, "mousemove");
        assert_eq!(context.handles.resolve(mouse_move.target), Some(label));
        complete(context.resume(&mouse_move, false));

        assert!(context.document.has_text_selection());
        assert!(
            context
                .document
                .get_selected_text()
                .is_some_and(|text| !text.is_empty())
        );
    }

    #[test]
    fn text_glyph_click_targets_the_label_while_its_default_activates_the_control() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox'>\
             <label id='label' for='box' style='font-size:32px'>Toggle</label>",
        );
        let checkbox = context.element("box");
        let label = context.element("label");
        let (x, y) = context
            .glyph_points_targeting(label)
            .into_iter()
            .next()
            .expect("the label's text glyph should be hittable");
        let hit = context.document.hit(x, y).unwrap();
        assert!(hit.is_text);
        assert_eq!(
            pointer_author_target_id(&context.document, hit.node_id),
            Some(label)
        );
        assert!(context.document.set_hover_to(x, y));

        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let (down_types, _, _) = drain(&mut context, down);
        assert_eq!(down_types, ["pointerdown", "mousedown"]);

        let mut step = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let mut types = Vec::new();
        let mut click_targets = Vec::new();
        while let DispatchStep::Event(current) = step {
            types.push(current.event_type.clone());
            if matches!(current.event_type.as_str(), "pointerup" | "mouseup") {
                assert_eq!(context.handles.resolve(current.target), Some(label));
                assert_eq!(context.handles.resolve(current.path[0]), Some(label));
            }
            if current.event_type == "click" {
                let target = context.handles.resolve(current.target).unwrap();
                click_targets.push(target);
                let default_target = context
                    .stack
                    .frames
                    .last()
                    .and_then(|frame| frame.pending.as_ref())
                    .map(|pending| pending.guarded.default_target.raw);
                if click_targets.len() == 1 {
                    assert_eq!(target, label);
                    assert_eq!(default_target, Some(hit.node_id));
                } else {
                    assert_eq!(target, checkbox);
                    assert_eq!(default_target, Some(checkbox));
                    assert!(
                        context
                            .checked_controls
                            .checked(&mut context.document, checkbox)
                            .unwrap(),
                        "the generated control click must expose preactivated checkedness",
                    );
                }
            }
            step = context.resume(&current, false);
        }

        assert_eq!(click_targets, [label, checkbox]);
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert_eq!(context.document.get_focussed_node_id(), Some(checkbox));
    }

    #[test]
    fn label_and_generated_control_clicks_are_independently_cancelable() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox'><label id='label' for='box'>Toggle</label>",
        );
        let checkbox = context.element("box");
        let label = context.element("label");

        let label_click = stage_generated(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        complete(context.resume(&label_click, true));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );

        let label_click = stage_generated(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        let control_click = event(context.resume(&label_click, false));
        assert_eq!(control_click.event_type, "click");
        assert_eq!(
            context.handles.resolve(control_click.target),
            Some(checkbox)
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap(),
            "the generated click must use ordinary legacy preactivation",
        );
        let remainder = context.resume(&control_click, true);
        let (types, _, _) = drain(&mut context, remainder);
        assert!(!types.iter().any(|event_type| event_type == "input"));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap(),
            "canceling the generated click must roll preactivation back",
        );
        assert_eq!(actual_focus_node_id(&context.document), None);
    }

    #[test]
    fn label_activation_uses_the_live_association_after_its_click_listener() {
        let mut context = TestContext::new(
            "<input id='first' type='checkbox'><input id='second' type='checkbox'>\
             <label id='label' for='first'>Toggle</label>",
        );
        let first = context.element("first");
        let second = context.element("second");
        let label = context.element("label");
        let label_click = stage_generated(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );

        context.document.mutate().set_attribute(
            label,
            QualName {
                prefix: None,
                ns: ns!(),
                local: LocalName::from("for"),
            },
            "second",
        );
        let control_click = event(context.resume(&label_click, false));
        assert_eq!(control_click.event_type, "click");
        assert_eq!(context.handles.resolve(control_click.target), Some(second));
        let remainder = context.resume(&control_click, false);
        let (types, _, _) = drain(&mut context, remainder);
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, first)
                .unwrap()
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, second)
                .unwrap()
        );
    }

    #[test]
    fn generated_label_click_focuses_text_inputs_after_the_control_listener() {
        let mut context =
            TestContext::new("<input id='editor'><label id='label' for='editor'>Edit</label>");
        let editor = context.element("editor");
        let label = context.element("label");
        let label_click = stage_generated(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        let control_click = event(context.resume(&label_click, false));
        assert_eq!(context.handles.resolve(control_click.target), Some(editor));
        let remainder = context.resume(&control_click, false);
        let (types, _, _) = drain(&mut context, remainder);
        assert!(types.iter().any(|event_type| event_type == "focus"));
        assert_eq!(actual_focus_node_id(&context.document), Some(editor));
    }

    #[test]
    fn labels_do_not_dispatch_control_clicks_for_disabled_or_interactive_targets() {
        let mut disabled = TestContext::new(
            "<input id='box' type='checkbox' disabled><label id='label' for='box'>Toggle</label>",
        );
        let checkbox = disabled.element("box");
        let label = disabled.element("label");
        let click = stage_generated(
            &mut disabled,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        complete(disabled.resume(&click, false));
        assert!(
            !disabled
                .checked_controls
                .checked(&mut disabled.document, checkbox)
                .unwrap()
        );

        let mut interactive = TestContext::new(
            "<input id='box' type='checkbox'><label id='label' for='box'>\
               <button id='button' type='button'>Own click</button>\
             </label>",
        );
        let button = interactive.element("button");
        let guarded = guard_queued_event(
            &interactive.document,
            &mut interactive.handles,
            DomEvent::new(
                button,
                DomEventData::Click(pointer(
                    1.0,
                    1.0,
                    MouseEventButton::Main,
                    MouseEventButtons::None,
                )),
            ),
            EventMetadata::native(),
        )
        .unwrap()
        .unwrap();
        assert!(matches!(
            label_click_default(&interactive.document, &guarded),
            LabelClickDefault::NotLabel
        ));
    }

    #[test]
    fn removed_raw_glyph_retargets_the_default_to_its_live_author_element() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox'><label id='label' for='box'>Original</label>\
             <input id='other' type='checkbox'><label id='other-label' for='other'></label>",
        );
        let checkbox = context.element("box");
        let other_checkbox = context.element("other");
        let label = context.element("label");
        let other_label = context.element("other-label");
        let text = context.text_child(label);
        let click = stage_generated(
            &mut context,
            text,
            DomEventData::Click(pointer(
                0.0,
                0.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert_eq!(context.handles.resolve(click.target), Some(label));

        let stale_handle = context
            .handles
            .invalidate_node(text)
            .expect("the raw text target should have been guarded");
        let replacement = {
            let mut mutator = context.document.mutate();
            mutator.remove_and_drop_node(text);
            let replacement = mutator.create_text_node("Replacement");
            mutator.append_children(other_label, &[replacement]);
            replacement
        };
        assert_eq!(replacement, text, "the Blitz slab should reuse the raw id");
        let replacement_handle = context
            .handles
            .expose(replacement)
            .expect("replacement handle should fit");
        assert_ne!(replacement_handle, stale_handle);

        let resumed = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, resumed);
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert_eq!(context.document.get_focussed_node_id(), Some(checkbox));
        assert_ne!(
            context.document.get_focussed_node_id(),
            Some(other_checkbox)
        );
    }

    #[test]
    fn destroyed_author_element_suppresses_its_pending_raw_glyph_default() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox'><label id='label' for='box'>Original</label>",
        );
        let checkbox = context.element("box");
        let label = context.element("label");
        let text = context.text_child(label);
        let initial_focus = context.document.get_focussed_node_id();
        let click = stage_generated(
            &mut context,
            text,
            DomEventData::Click(pointer(
                0.0,
                0.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert_eq!(context.handles.resolve(click.target), Some(label));

        context
            .handles
            .invalidate_node(label)
            .expect("the author target should have been guarded");
        context.document.mutate().remove_and_drop_node(label);

        complete(context.resume(&click, false));
        assert_eq!(context.document.get_focussed_node_id(), initial_focus);
        assert_ne!(context.document.get_focussed_node_id(), Some(checkbox));
    }

    #[test]
    fn pointer_or_compatibility_mouse_cancellation_suppresses_pointer_default() {
        for cancel_pointer in [true, false] {
            let mut context = TestContext::new(
                "<input id='editor' style='display:block;width:160px;height:30px' value='abc'>",
            );
            let input = context.element("editor");
            let (x, y) = context.center(input);
            assert!(context.document.set_hover_to(x, y));
            let _ = context.redraw.swap(false, Ordering::Relaxed);

            let pointer_step = event(context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            }));
            assert_eq!(pointer_step.event_type, "pointerdown");
            let next = context.resume(&pointer_step, cancel_pointer);
            if cancel_pointer {
                complete(next);
            } else {
                let mouse_step = event(next);
                assert_eq!(mouse_step.event_type, "mousedown");
                complete(context.resume(&mouse_step, true));
            }

            assert_ne!(context.document.get_focussed_node_id(), Some(input));
        }

        let mut context = TestContext::new(
            "<input id='editor' style='display:block;width:160px;height:30px' value='abc'>",
        );
        let input = context.element("editor");
        let (x, y) = context.center(input);
        assert!(context.document.set_hover_to(x, y));
        let pointer_step = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        let mouse_step = event(context.resume(&pointer_step, false));
        let _focus_step = event(context.resume(&mouse_step, false));
        assert_eq!(context.document.get_focussed_node_id(), Some(input));
    }

    #[test]
    fn uncancelled_mousedown_focuses_the_nearest_focusable_ancestor_before_pointer_defaults() {
        let mut context = TestContext::new(
            "<input id='old'>\
             <button id='button' type='button' style='display:block;width:120px;height:40px'>\
               <span id='inner' style='display:block;width:80px;height:20px'>focus me</span>\
             </button>",
        );
        let old = context.element("old");
        let button = context.element("button");
        let inner = context.element("inner");
        assert!(context.document.set_focus_to(old));
        let (x, y) = context.center(inner);
        assert!(context.document.set_hover_to(x, y));

        let pointer_down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        assert_eq!(pointer_down.event_type, "pointerdown");
        assert_eq!(context.handles.resolve(pointer_down.target), Some(inner));
        assert_eq!(actual_focus_node_id(&context.document), Some(old));

        let mouse_down = event(context.resume(&pointer_down, false));
        assert_eq!(mouse_down.event_type, "mousedown");
        assert_eq!(context.handles.resolve(mouse_down.target), Some(inner));
        assert_eq!(actual_focus_node_id(&context.document), Some(old));

        let blur = event(context.resume(&mouse_down, false));
        assert_eq!(blur.event_type, "blur");
        assert_eq!(context.handles.resolve(blur.target), Some(old));
        assert_eq!(actual_focus_node_id(&context.document), None);
        let focusout = event(context.resume(&blur, false));
        assert_eq!(focusout.event_type, "focusout");
        let focus = event(context.resume(&focusout, false));
        assert_eq!(focus.event_type, "focus");
        assert_eq!(context.handles.resolve(focus.target), Some(button));
        assert_eq!(actual_focus_node_id(&context.document), Some(button));
        let focusin = event(context.resume(&focus, false));
        assert_eq!(focusin.event_type, "focusin");
        complete(context.resume(&focusin, false));

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert!(!types.iter().any(|kind| is_focus_event_name(kind)));
        assert_eq!(actual_focus_node_id(&context.document), Some(button));
    }

    #[test]
    fn cancelled_pointer_or_mouse_down_cannot_focus_later_through_click() {
        for cancel_pointer in [true, false] {
            let mut context = TestContext::new(
                "<input id='old'>\
                 <input id='box' type='checkbox' style='display:block;width:24px;height:24px'>",
            );
            let old = context.element("old");
            let checkbox = context.element("box");
            assert!(context.document.set_focus_to(old));
            let (x, y) = context.center(checkbox);
            assert!(context.document.set_hover_to(x, y));

            let pointer_down = event(context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            }));
            let remainder = context.resume(&pointer_down, cancel_pointer);
            if cancel_pointer {
                complete(remainder);
            } else {
                let mouse_down = event(remainder);
                assert_eq!(mouse_down.event_type, "mousedown");
                complete(context.resume(&mouse_down, true));
            }
            assert_eq!(actual_focus_node_id(&context.document), Some(old));

            let up = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
                flavor: PointerFlavor::Up,
                metadata: EventMetadata::native(),
            });
            let (types, _, _) = drain(&mut context, up);
            assert!(types.iter().any(|kind| kind == "click"));
            assert!(types.iter().any(|kind| kind == "input"));
            assert!(!types.iter().any(|kind| is_focus_event_name(kind)));
            assert_eq!(actual_focus_node_id(&context.document), Some(old));
        }
    }

    #[test]
    fn non_mouse_clicks_retain_the_pinned_focus_path() {
        for pointer_id in [BlitzPointerId::Pen, BlitzPointerId::Finger(7)] {
            let mut context = TestContext::new(
                "<input id='old'>\
                 <input id='box' type='checkbox' style='display:block;width:24px;height:24px'>",
            );
            let old = context.element("old");
            let checkbox = context.element("box");
            assert!(context.document.set_focus_to(old));
            let (x, y) = context.center(checkbox);
            let mut click_data = pointer(x, y, MouseEventButton::Main, MouseEventButtons::None);
            click_data.id = pointer_id;
            let click = stage_generated_with_metadata(
                &mut context,
                checkbox,
                DomEventData::Click(click_data),
                EventMetadata::native(),
            );

            let step = context.resume(&click, false);
            let (types, _, _) = drain(&mut context, step);
            assert!(types.iter().any(|kind| kind == "input"));
            assert!(types.iter().any(|kind| kind == "focus"));
            assert_eq!(actual_focus_node_id(&context.document), Some(checkbox));
        }
    }

    #[test]
    fn focus_neutral_click_defaults_do_not_restart_the_ime_context() {
        let mut context = TestContext::new(
            "<input id='editor' value='seed'>\
             <input id='box' type='checkbox' style='display:block;width:24px;height:24px'>",
        );
        let editor = context.element("editor");
        let checkbox = context.element("box");
        assert!(context.document.set_focus_to(editor));
        let initial_request = context
            .ime_requests
            .peek_snapshot()
            .unwrap()
            .expect("initial text focus should enable IME");
        context
            .ime_requests
            .acknowledge_snapshot(uint32(initial_request[0], "revision").unwrap())
            .unwrap();
        assert!(context.ime_requests.peek_snapshot().unwrap().is_none());
        context.document.with_text_input(editor, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });
        let (x, y) = context.center(checkbox);
        let click = stage_generated_with_metadata(
            &mut context,
            checkbox,
            DomEventData::Click(pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::native(),
        );

        let step = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, step);
        assert_eq!(types, ["input", "change"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(editor));
        assert!(
            context.ime_requests.peek_snapshot().unwrap().is_none(),
            "a focus-neutral default must not publish a native IME restart"
        );
        let mut composition_survived = false;
        context.document.with_text_input(editor, |driver| {
            composition_survived = driver.editor.raw_compose().is_some();
        });
        assert!(composition_survived);
    }

    #[test]
    fn ime_suppressing_shell_delegates_every_other_capability() {
        struct RecordingShell {
            close_requested: AtomicBool,
            clipboard_written: AtomicBool,
            ime_called: AtomicBool,
        }

        impl ShellProvider for RecordingShell {
            fn set_ime_enabled(&self, _enabled: bool) {
                self.ime_called.store(true, Ordering::Relaxed);
            }

            fn set_ime_cursor_area(&self, _x: f32, _y: f32, _width: f32, _height: f32) {
                self.ime_called.store(true, Ordering::Relaxed);
            }

            fn get_clipboard_text(&self) -> Result<String, ClipboardError> {
                Ok("clipboard".to_owned())
            }

            fn set_clipboard_text(&self, _text: String) -> Result<(), ClipboardError> {
                self.clipboard_written.store(true, Ordering::Relaxed);
                Err(ClipboardError)
            }

            fn request_window_close(&self) {
                self.close_requested.store(true, Ordering::Relaxed);
            }

            fn is_window_maximized(&self) -> bool {
                true
            }
        }

        let inner = Arc::new(RecordingShell {
            close_requested: AtomicBool::new(false),
            clipboard_written: AtomicBool::new(false),
            ime_called: AtomicBool::new(false),
        });
        let shell = ImeSuppressingShellProvider {
            inner: inner.clone(),
        };

        shell.request_window_close();
        assert!(inner.close_requested.load(Ordering::Relaxed));
        assert!(shell.is_window_maximized());
        assert_eq!(
            shell.get_clipboard_text().ok().as_deref(),
            Some("clipboard")
        );
        assert!(shell.set_clipboard_text("write".to_owned()).is_err());
        assert!(inner.clipboard_written.load(Ordering::Relaxed));
        shell.set_ime_enabled(true);
        shell.set_ime_cursor_area(1.0, 2.0, 3.0, 4.0);
        assert!(!inner.ime_called.load(Ordering::Relaxed));
    }

    #[test]
    fn nested_blur_listener_focus_wins_over_deferred_pointer_default() {
        let mut context = TestContext::new(
            "<input id='old'>\
             <input id='target' style='display:block;width:120px;height:30px'>\
             <input id='redirect'>",
        );
        let old = context.element("old");
        let target = context.element("target");
        let redirect = context.element("redirect");
        assert!(context.document.set_focus_to(old));
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));

        let pointer_down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        let mouse_down = event(context.resume(&pointer_down, false));
        let blur = event(context.resume(&mouse_down, false));
        assert_eq!(blur.event_type, "blur");
        assert_eq!(actual_focus_node_id(&context.document), None);

        let nested = context.begin_programmatic_focus(redirect);
        let (nested_types, _, _) = drain(&mut context, nested);
        assert_eq!(nested_types, ["focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(redirect));

        let remainder = context.resume(&blur, false);
        let (outer_types, _, _) = drain(&mut context, remainder);
        assert_eq!(outer_types, ["focusout"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(redirect));
    }

    #[test]
    fn deferred_pointer_default_resolves_layout_after_focus_listeners() {
        let mut context = TestContext::new(
            "<input id='target' value='abcdefghij' \
             style='display:block;width:240px;height:30px'>",
        );
        let target = context.element("target");
        let initial = context
            .text_controls
            .selection(&mut context.document, target)
            .unwrap();
        assert_eq!((initial.start, initial.end), (0, 0));
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));

        let pointer_down = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        let mouse_down = event(context.resume(&pointer_down, false));
        let focus = event(context.resume(&mouse_down, false));
        assert_eq!(focus.event_type, "focus");

        context.set_style(
            target,
            "display:block;width:240px;height:30px;margin-left:400px",
        );
        let focusin = event(context.resume(&focus, false));
        assert_eq!(focusin.event_type, "focusin");
        complete(context.resume(&focusin, false));

        let selection = context
            .text_controls
            .selection(&mut context.document, target)
            .unwrap();
        assert_eq!(
            (selection.start, selection.end),
            (0, 0),
            "the stale pre-focus layout must not place the caret"
        );
    }

    #[test]
    fn browser_navigation_buttons_do_not_change_mouse_focus() {
        for (button, buttons) in [
            (MouseEventButton::Fourth, MouseEventButtons::Fourth),
            (MouseEventButton::Fifth, MouseEventButtons::Fifth),
        ] {
            let mut context = TestContext::new(
                "<input id='old'><button id='target' type='button' \
                 style='display:block;width:100px;height:30px'>target</button>",
            );
            let old = context.element("old");
            let target = context.element("target");
            assert!(context.document.set_focus_to(old));
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));

            let down = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, buttons),
                flavor: PointerFlavor::Down,
                metadata: EventMetadata::native(),
            });
            let (down_types, _, _) = drain(&mut context, down);
            assert_eq!(down_types, ["pointerdown", "mousedown"]);
            assert_eq!(actual_focus_node_id(&context.document), Some(old));

            let up = context.begin(DispatchRequest::Pointer {
                event: pointer(x, y, button, MouseEventButtons::None),
                flavor: PointerFlavor::Up,
                metadata: EventMetadata::native(),
            });
            let (up_types, _, _) = drain(&mut context, up);
            assert_eq!(up_types, ["pointerup", "mouseup", "auxclick"]);
            assert_eq!(actual_focus_node_id(&context.document), Some(old));
        }
    }

    #[test]
    fn generated_events_keep_fifo_order_and_multiplicity() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox' style='display:block;width:24px;height:24px'>",
        );
        let checkbox = context.element("box");
        let (x, y) = context.center(checkbox);
        assert!(context.document.set_hover_to(x, y));

        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        });
        let (down_types, _, _) = drain(&mut context, down);
        assert_eq!(down_types, ["pointerdown", "mousedown", "focus", "focusin"]);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert_eq!(types, ["pointerup", "mouseup", "click", "input", "change"]);
    }

    #[test]
    fn programmatic_focus_transfers_in_browser_order_with_live_state_and_relationships() {
        let mut context =
            TestContext::new("<input id='old' value='old'><button id='new'>new</button>");
        let old = context.element("old");
        let new = context.element("new");
        assert!(context.document.set_focus_to(old));

        let blur = event(context.begin_programmatic_focus(new));
        assert_eq!(blur.event_type, "blur");
        assert!(!blur.bubbles);
        assert!(!blur.cancelable);
        assert!(blur.composed);
        assert_eq!(actual_focus_node_id(&context.document), None);
        let old_handle = blur.target;
        let new_handle = focus_related_target(&blur).expect("blur should identify its destination");

        let focusout = event(context.resume(&blur, false));
        assert_eq!(focusout.event_type, "focusout");
        assert!(focusout.bubbles);
        assert!(!focusout.cancelable);
        assert_eq!(focusout.target, old_handle);
        assert_eq!(focus_related_target(&focusout), Some(new_handle));
        assert_eq!(actual_focus_node_id(&context.document), None);

        let focus = event(context.resume(&focusout, false));
        assert_eq!(focus.event_type, "focus");
        assert!(!focus.bubbles);
        assert_eq!(focus.target, new_handle);
        assert_eq!(focus_related_target(&focus), Some(old_handle));
        assert_eq!(actual_focus_node_id(&context.document), Some(new));

        let focusin = event(context.resume(&focus, false));
        assert_eq!(focusin.event_type, "focusin");
        assert!(focusin.bubbles);
        assert_eq!(focusin.target, new_handle);
        assert_eq!(focus_related_target(&focusin), Some(old_handle));
        assert_eq!(focusin.time_stamp.to_bits(), blur.time_stamp.to_bits());
        let (_, redraw_requested) = complete(context.resume(&focusin, false));
        assert!(redraw_requested);
        assert_eq!(actual_focus_node_id(&context.document), Some(new));
    }

    #[test]
    fn programmatic_focus_and_blur_noops_match_the_current_owner() {
        let mut context = TestContext::new("<button id='button'>button</button><input id='other'>");
        let button = context.element("button");
        let other = context.element("other");

        let first = context.begin_programmatic_focus(button);
        let (types, _, redraw_requested) = drain(&mut context, first);
        assert_eq!(types, ["focus", "focusin"]);
        assert!(redraw_requested);
        assert_eq!(actual_focus_node_id(&context.document), Some(button));

        let same = context.begin_programmatic_focus(button);
        assert!(!complete(same).1);
        let wrong_blur = context.begin_programmatic_blur(other);
        assert!(!complete(wrong_blur).1);
        assert_eq!(actual_focus_node_id(&context.document), Some(button));

        let blur = event(context.begin_programmatic_blur(button));
        assert_eq!(blur.event_type, "blur");
        assert_eq!(focus_related_target(&blur), None);
        assert_eq!(actual_focus_node_id(&context.document), None);
        let focusout = event(context.resume(&blur, false));
        assert_eq!(focusout.event_type, "focusout");
        assert_eq!(focus_related_target(&focusout), None);
        let (_, redraw_requested) = complete(context.resume(&focusout, false));
        assert!(redraw_requested);
        assert_eq!(actual_focus_node_id(&context.document), None);
    }

    #[test]
    fn programmatic_focus_accepts_negative_tabindex_and_rejects_ineligible_targets() {
        let mut context = TestContext::new(
            "<input id='owner'>\
             <div id='negative' tabindex='-1'></div>\
             <a id='link' href='https://example.com'>link</a>\
             <div id='plain'></div>\
             <button id='disabled' disabled>disabled</button>\
             <input id='hidden-input' type='hidden'>\
             <section hidden><button id='hidden-child'>hidden</button></section>\
             <section style='display:none'><button id='display-child'>hidden</button></section>\
             <section inert><button id='inert-child'>inert</button></section>\
             <button id='visibility-hidden' style='visibility:hidden'>hidden</button>\
             <button id='visibility-collapse' style='visibility:collapse'>collapsed</button>\
             <section style='visibility:hidden'>\
               <button id='visibility-override' style='visibility:visible'>visible</button>\
             </section>",
        );
        let owner = context.element("owner");
        assert!(context.document.set_focus_to(owner));

        for id in [
            "plain",
            "disabled",
            "hidden-input",
            "hidden-child",
            "display-child",
            "inert-child",
            "visibility-hidden",
            "visibility-collapse",
        ] {
            let target = context.element(id);
            let rejected = context.begin_programmatic_focus(target);
            complete(rejected);
            assert_eq!(
                actual_focus_node_id(&context.document),
                Some(owner),
                "#{id} must not take focus",
            );
        }

        context.document.clear_focus();
        let negative = context.element("negative");
        let (types, _, _) = {
            let step = context.begin_programmatic_focus(negative);
            drain(&mut context, step)
        };
        assert_eq!(types, ["focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(negative));

        context.document.clear_focus();
        let link = context.element("link");
        let (types, _, _) = {
            let step = context.begin_programmatic_focus(link);
            drain(&mut context, step)
        };
        assert_eq!(types, ["focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(link));

        context.document.clear_focus();
        let visibility_override = context.element("visibility-override");
        let (types, _, _) = {
            let step = context.begin_programmatic_focus(visibility_override);
            drain(&mut context, step)
        };
        assert_eq!(types, ["focus", "focusin"]);
        assert_eq!(
            actual_focus_node_id(&context.document),
            Some(visibility_override),
        );
    }

    #[test]
    fn disabled_fieldsets_exempt_only_the_first_legend_subtree() {
        let mut context = TestContext::new(
            "<input id='owner'>\
             <fieldset disabled>\
               <legend><input id='first-legend'></legend>\
               <input id='nonlegend'>\
               <legend><input id='second-legend'></legend>\
             </fieldset>\
             <fieldset disabled>\
               <legend>\
                 <fieldset disabled>\
                   <legend><input id='nested-exempt'></legend>\
                   <input id='nested-inner-disabled'>\
                 </fieldset>\
               </legend>\
             </fieldset>\
             <fieldset disabled>\
               <div>\
                 <fieldset disabled>\
                   <legend><input id='nested-outer-disabled'></legend>\
                 </fieldset>\
               </div>\
             </fieldset>",
        );
        let owner = context.element("owner");
        assert!(context.document.set_focus_to(owner));

        for id in [
            "nonlegend",
            "second-legend",
            "nested-inner-disabled",
            "nested-outer-disabled",
        ] {
            let target = context.element(id);
            let rejected = context.begin_programmatic_focus(target);
            assert!(!complete(rejected).1);
            assert_eq!(
                actual_focus_node_id(&context.document),
                Some(owner),
                "#{id} must inherit disabled fieldset state",
            );
        }

        for id in ["first-legend", "nested-exempt"] {
            context.document.clear_focus();
            let target = context.element(id);
            let step = context.begin_programmatic_focus(target);
            let (types, _, redraw_requested) = drain(&mut context, step);
            assert_eq!(types, ["focus", "focusin"], "#{id} should accept tabindex");
            assert!(redraw_requested);
            assert_eq!(actual_focus_node_id(&context.document), Some(target));
        }
    }

    #[test]
    fn actually_disabled_special_controls_reject_explicit_tabindex() {
        let mut context = TestContext::new(
            "<input id='owner'>\
             <fieldset id='disabled-fieldset' disabled tabindex='0'></fieldset>\
             <option id='disabled-option' disabled tabindex='0' style='display:block'>disabled</option>\
             <optgroup id='disabled-optgroup' disabled tabindex='0' label='disabled'>\
               <option id='optgroup-option' tabindex='0' style='display:block'>inherited</option>\
             </optgroup>\
             <select id='disabled-select' disabled tabindex='0'>\
               <optgroup id='select-optgroup' tabindex='0' label='select disabled'>\
                 <option id='select-option' tabindex='0' style='display:block'>inherited</option>\
               </optgroup>\
             </select>\
             <fieldset id='plain-fieldset'></fieldset>\
             <optgroup id='plain-optgroup' label='plain'>\
               <option id='plain-option'>plain</option>\
             </optgroup>\
             <fieldset id='enabled-fieldset' tabindex='0'></fieldset>\
             <fieldset disabled>\
               <fieldset id='nested-enabled-fieldset' tabindex='0'></fieldset>\
             </fieldset>\
             <optgroup id='enabled-optgroup' tabindex='0' label='enabled'>\
               <option id='enabled-option' tabindex='0' style='display:block'>enabled</option>\
             </optgroup>",
        );
        let owner = context.element("owner");
        assert!(context.document.set_focus_to(owner));

        for id in [
            "disabled-fieldset",
            "disabled-option",
            "disabled-optgroup",
            "optgroup-option",
            "disabled-select",
            "select-optgroup",
            "select-option",
        ] {
            let target = context.element(id);
            let rejected = context.begin_programmatic_focus(target);
            assert!(!complete(rejected).1);
            assert_eq!(
                actual_focus_node_id(&context.document),
                Some(owner),
                "#{id} must remain actually disabled despite tabindex",
            );
        }

        for id in ["plain-fieldset", "plain-optgroup", "plain-option"] {
            let target = context.element(id);
            let rejected = context.begin_programmatic_focus(target);
            assert!(!complete(rejected).1);
            assert_eq!(
                actual_focus_node_id(&context.document),
                Some(owner),
                "#{id} must not become implicitly focusable",
            );
        }

        for id in [
            "enabled-fieldset",
            "nested-enabled-fieldset",
            "enabled-optgroup",
            "enabled-option",
        ] {
            context.document.clear_focus();
            let target = context.element(id);
            let step = context.begin_programmatic_focus(target);
            let (types, _, redraw_requested) = drain(&mut context, step);
            assert_eq!(types, ["focus", "focusin"], "#{id} should accept tabindex");
            assert!(redraw_requested);
            assert_eq!(actual_focus_node_id(&context.document), Some(target));
        }
    }

    #[test]
    fn nested_loss_listener_focus_wins_over_the_outer_destination() {
        let mut context = TestContext::new(
            "<button id='old'>old</button><button id='outer'>outer</button><button id='inner'>inner</button>",
        );
        let old = context.element("old");
        let outer = context.element("outer");
        let inner = context.element("inner");
        assert!(context.document.set_focus_to(old));

        let outer_blur = event(context.begin_programmatic_focus(outer));
        assert_eq!(outer_blur.event_type, "blur");
        assert_eq!(actual_focus_node_id(&context.document), None);

        let nested = context.begin_programmatic_focus(inner);
        let (nested_types, _, _) = drain(&mut context, nested);
        assert_eq!(nested_types, ["focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(inner));

        let outer_remainder = context.resume(&outer_blur, false);
        let (outer_types, _, _) = drain(&mut context, outer_remainder);
        assert_eq!(outer_types, ["focusout"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(inner));
    }

    #[test]
    fn nested_focus_listener_redirect_suppresses_the_stale_outer_focusin() {
        let mut context =
            TestContext::new("<button id='outer'>outer</button><button id='inner'>inner</button>");
        let outer = context.element("outer");
        let inner = context.element("inner");

        let outer_focus = event(context.begin_programmatic_focus(outer));
        assert_eq!(outer_focus.event_type, "focus");
        assert_eq!(actual_focus_node_id(&context.document), Some(outer));

        let nested = context.begin_programmatic_focus(inner);
        let (nested_types, _, _) = drain(&mut context, nested);
        assert_eq!(nested_types, ["blur", "focusout", "focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(inner));

        let outer_remainder = context.resume(&outer_focus, false);
        complete(outer_remainder);
        assert_eq!(actual_focus_node_id(&context.document), Some(inner));
    }

    #[test]
    fn stale_or_newly_disabled_destination_is_not_focused_after_loss_listeners() {
        let mut stale =
            TestContext::new("<button id='old'>old</button><button id='new'>new</button>");
        let old = stale.element("old");
        let new = stale.element("new");
        assert!(stale.document.set_focus_to(old));
        let blur = event(stale.begin_programmatic_focus(new));
        let stale_handle = focus_related_target(&blur).expect("destination should be guarded");
        assert_eq!(stale.handles.invalidate_node(new), Some(stale_handle));
        let replacement_handle = stale.handles.expose(new).expect("fresh handle should fit");
        assert_ne!(replacement_handle, stale_handle);
        let remainder = stale.resume(&blur, false);
        let (types, _, _) = drain(&mut stale, remainder);
        assert_eq!(types, ["focusout"]);
        assert_eq!(actual_focus_node_id(&stale.document), None);

        let mut disabled =
            TestContext::new("<button id='old'>old</button><button id='new'>new</button>");
        let old = disabled.element("old");
        let new = disabled.element("new");
        assert!(disabled.document.set_focus_to(old));
        let blur = event(disabled.begin_programmatic_focus(new));
        disabled.document.mutate().set_attribute(
            new,
            QualName {
                prefix: None,
                ns: ns!(),
                local: LocalName::from("disabled"),
            },
            "",
        );
        let remainder = disabled.resume(&blur, false);
        let (types, _, _) = drain(&mut disabled, remainder);
        assert_eq!(types, ["focusout"]);
        assert_eq!(actual_focus_node_id(&disabled.document), None);
    }

    #[test]
    fn programmatic_focus_syncs_live_text_and_native_ime_edges() {
        let mut context = TestContext::new("<input id='old' value='seed'><input id='new'>");
        let old = context.element("old");
        let new = context.element("new");
        assert!(context.document.set_focus_to(old));
        context.document.with_text_input(old, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });

        let blur = event(context.begin_programmatic_focus(new));
        assert_eq!(context.live_value(old), "seed候補");

        let focusout = event(context.resume(&blur, false));
        let focus = event(context.resume(&focusout, false));
        assert_eq!(focus.event_type, "focus");
        let enabled = context
            .ime_requests
            .peek_snapshot()
            .expect("IME peek should succeed")
            .expect("focus should publish an IME edge");
        assert!(enabled[6] > 0.5);
        let remainder = context.resume(&focus, false);
        let _ = drain(&mut context, remainder);
        assert_eq!(actual_focus_node_id(&context.document), Some(new));
    }

    #[test]
    fn tab_uses_sequential_order_in_both_directions_and_ignores_keyup() {
        let mut context = TestContext::new(
            "<button id='ordinary'>ordinary</button>\
             <button id='positive-two' tabindex='2'>two</button>\
             <div id='positive-one' tabindex=' +1junk'>one</div>\
             <button id='disabled' disabled>disabled</button>\
             <button id='hidden' style='display:none'>hidden</button>\
             <button id='invisible' style='visibility:hidden'>invisible</button>\
             <div inert><button id='inert'>inert</button></div>\
             <button id='negative' tabindex='-1'>negative</button>\
             <div id='zero' tabindex='0'>zero</div>",
        );
        let positive_one = context.element("positive-one");
        let positive_two = context.element("positive-two");
        let ordinary = context.element("ordinary");

        let first = context.begin(tab_request(KeyState::Pressed, false, false, false));
        let (types, _, _) = drain(&mut context, first);
        assert_eq!(types, ["keydown", "focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(positive_one));

        let keyup = context.begin(tab_request(KeyState::Released, false, false, false));
        let (types, _, _) = drain(&mut context, keyup);
        assert_eq!(types, ["keyup"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(positive_one));

        let repeated = context.begin(tab_request(KeyState::Pressed, false, true, false));
        let (types, _, _) = drain(&mut context, repeated);
        assert_eq!(types, ["keydown", "blur", "focusout", "focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(positive_two));

        let forward = context.begin(tab_request(KeyState::Pressed, false, false, false));
        let _ = drain(&mut context, forward);
        assert_eq!(actual_focus_node_id(&context.document), Some(ordinary));

        let backward = context.begin(tab_request(KeyState::Pressed, true, false, false));
        let _ = drain(&mut context, backward);
        assert_eq!(actual_focus_node_id(&context.document), Some(positive_two));
    }

    #[test]
    fn tab_starts_at_each_edge_wraps_and_reenters_after_negative_tabindex() {
        let mut context = TestContext::new(
            "<button id='first'>first</button>\
             <button id='negative' tabindex='-1'>negative</button>\
             <button id='last'>last</button>",
        );
        let first = context.element("first");
        let negative = context.element("negative");
        let last = context.element("last");

        let backwards = context.begin(tab_request(KeyState::Pressed, true, false, false));
        let _ = drain(&mut context, backwards);
        assert_eq!(actual_focus_node_id(&context.document), Some(last));

        let wrapped = context.begin(tab_request(KeyState::Pressed, false, false, false));
        let _ = drain(&mut context, wrapped);
        assert_eq!(actual_focus_node_id(&context.document), Some(first));

        let focus_negative = context.begin_programmatic_focus(negative);
        let _ = drain(&mut context, focus_negative);
        assert_eq!(actual_focus_node_id(&context.document), Some(negative));
        let reenter = context.begin(tab_request(KeyState::Pressed, false, false, false));
        let _ = drain(&mut context, reenter);
        assert_eq!(actual_focus_node_id(&context.document), Some(last));

        let focus_negative = context.begin_programmatic_focus(negative);
        let _ = drain(&mut context, focus_negative);
        let reenter = context.begin(tab_request(KeyState::Pressed, true, false, false));
        let _ = drain(&mut context, reenter);
        assert_eq!(actual_focus_node_id(&context.document), Some(first));
    }

    #[test]
    fn canceled_or_host_suppressed_tab_does_not_move_focus() {
        let mut context = TestContext::new(
            "<button id='first'>first</button><button id='second'>second</button>",
        );
        let first = context.element("first");
        assert!(context.document.set_focus_to(first));

        let canceled = event(context.begin(tab_request(KeyState::Pressed, false, false, false)));
        assert_eq!(canceled.event_type, "keydown");
        complete(context.resume(&canceled, true));
        assert_eq!(actual_focus_node_id(&context.document), Some(first));

        let suppressed = context.begin(tab_request(KeyState::Pressed, false, false, true));
        let (types, _, _) = drain(&mut context, suppressed);
        assert_eq!(types, ["keydown"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(first));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "every staged focus record must retain the exact causal key timestamp"
    )]
    fn tab_recomputes_mutated_eligibility_and_stages_exact_focus_metadata() {
        let mut context = TestContext::new(
            "<button id='old'>old</button>\
             <input id='type-target'>\
             <button id='removed'>removed</button>\
             <button id='destination'>destination</button>",
        );
        let old = context.element("old");
        let type_target = context.element("type-target");
        let removed = context.element("removed");
        let destination = context.element("destination");
        assert!(context.document.set_focus_to(old));
        let old_handle = context.handles.expose(old).unwrap();
        let destination_handle = context.handles.expose(destination).unwrap();

        let keydown = event(context.begin(tab_request(KeyState::Pressed, false, false, false)));
        context.document.mutate().set_attribute(
            type_target,
            QualName {
                prefix: None,
                ns: ns!(),
                local: LocalName::from("type"),
            },
            "hidden",
        );
        context.document.mutate().remove_node(removed);
        let mut step = context.resume(&keydown, false);
        let mut focus_types = Vec::new();
        while let DispatchStep::Event(current) = step {
            assert_eq!(current.time_stamp, 500.0);
            focus_types.push(current.event_type.clone());
            if matches!(current.event_type.as_str(), "blur" | "focusout") {
                assert_eq!(current.target, old_handle);
                assert_eq!(focus_related_target(&current), Some(destination_handle));
            } else {
                assert!(matches!(current.event_type.as_str(), "focus" | "focusin"));
                assert_eq!(current.target, destination_handle);
                assert_eq!(focus_related_target(&current), Some(old_handle));
            }
            step = context.resume(&current, false);
        }
        assert_eq!(focus_types, ["blur", "focusout", "focus", "focusin"]);
        assert_eq!(actual_focus_node_id(&context.document), Some(destination));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "keyboard activation must retain the exact native key timestamp and zero coordinates"
    )]
    fn enter_activates_browser_controls_with_an_exact_ordinary_click() {
        for markup in [
            "<a id='target' href='/next'>link</a>",
            "<map name='map'><area id='target' href='/next' alt='area'></map>",
            "<button id='target'>button</button>",
            "<input id='target' type='button' value='button'>",
            "<input id='target' type='submit' value='submit'>",
            "<input id='target' type='reset' value='reset'>",
            "<input id='target' type='image' alt='image'>",
        ] {
            let mut context = TestContext::new(markup);
            let target = context.element("target");
            let target_handle = context.handles.expose(target).unwrap();
            assert!(context.document.set_focus_to(target), "{markup}");
            let modifier_bits = KEY_MOD_SHIFT
                | KEY_MOD_CONTROL
                | KEY_MOD_ALT
                | KEY_MOD_META
                | KEY_MOD_CAPS_LOCK
                | KEY_MOD_ALT_GRAPH
                | KEY_MOD_FN
                | KEY_MOD_NUM_LOCK
                | KEY_MOD_SCROLL_LOCK;

            let keydown = event(context.begin(enter_request(
                KeyState::Pressed,
                false,
                false,
                false,
                modifier_bits,
            )));
            assert_eq!(keydown.event_type, "keydown");
            let click = event(context.resume(&keydown, false));
            assert_eq!(click.event_type, "click", "{markup}");
            assert_eq!(click.target, target_handle, "{markup}");
            assert!(
                click.bubbles && click.cancelable && click.composed,
                "{markup}"
            );
            assert_eq!(click.time_stamp, 700.25);
            let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
                panic!("keyboard click should carry a pointer payload: {markup}");
            };
            assert_eq!(
                (
                    payload.mouse.client_x,
                    payload.mouse.client_y,
                    payload.mouse.screen_x,
                    payload.mouse.screen_y,
                    payload.mouse.page_x,
                    payload.mouse.page_y,
                    payload.mouse.offset_x,
                    payload.mouse.offset_y,
                    payload.mouse.movement_x,
                    payload.mouse.movement_y,
                ),
                (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
                "{markup}",
            );
            assert_eq!(
                (
                    payload.mouse.button,
                    payload.mouse.buttons,
                    payload.mouse.detail,
                ),
                (0, 0, 0),
            );
            assert!(payload.mouse.shift_key);
            assert!(payload.mouse.ctrl_key);
            assert!(payload.mouse.alt_key);
            assert!(payload.mouse.meta_key);
            assert!(payload.mouse.caps_lock);
            assert!(payload.mouse.alt_graph_key);
            assert!(payload.mouse.fn_key);
            assert!(payload.mouse.num_lock);
            assert!(payload.mouse.scroll_lock);
            assert!(!payload.is_primary);
            assert_eq!(payload.pressure, 0.0);

            // Cancel the ordinary click so link and form-control defaults do not obscure the
            // activation event contract under test.
            complete(context.resume(&click, true));
        }
    }

    #[test]
    fn enter_activation_honors_key_policy_and_repeat_but_not_keyup_or_composition() {
        let mut context = TestContext::new("<button id='target'>button</button>");
        let target = context.element("target");
        assert!(context.document.set_focus_to(target));

        let canceled =
            event(context.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        complete(context.resume(&canceled, true));

        for request in [
            enter_request(KeyState::Pressed, false, false, true, 0),
            enter_request(KeyState::Released, false, false, false, 0),
            enter_request(KeyState::Pressed, false, true, false, 0),
        ] {
            let first = context.begin(request);
            let (types, _, _) = drain(&mut context, first);
            assert!(!types.iter().any(|kind| kind == "click"), "{types:?}");
        }

        let repeated =
            event(context.begin(enter_request(KeyState::Pressed, true, false, false, 0)));
        let click = event(context.resume(&repeated, false));
        assert_eq!(click.event_type, "click");
        complete(context.resume(&click, true));
    }

    #[test]
    fn enter_revalidates_activation_eligibility_after_the_key_listener() {
        let href = QualName {
            prefix: None,
            ns: ns!(),
            local: LocalName::from("href"),
        };
        let kind = QualName {
            prefix: None,
            ns: ns!(),
            local: LocalName::from("type"),
        };

        let mut removed_href = TestContext::new("<a id='target' href='/next'>link</a>");
        let target = removed_href.element("target");
        assert!(removed_href.document.set_focus_to(target));
        let keydown =
            event(removed_href.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        removed_href.document.mutate().clear_attribute(target, href);
        complete(removed_href.resume(&keydown, false));

        let mut added_type = TestContext::new("<input id='target'>");
        let target = added_type.element("target");
        assert!(added_type.document.set_focus_to(target));
        let keydown =
            event(added_type.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        added_type
            .document
            .mutate()
            .set_attribute(target, kind.clone(), "button");
        complete(added_type.resume(&keydown, false));

        let mut changed_type = TestContext::new("<input id='target' type='button'>");
        let target = changed_type.element("target");
        assert!(changed_type.document.set_focus_to(target));
        let keydown =
            event(changed_type.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        changed_type
            .document
            .mutate()
            .set_attribute(target, kind, "text");
        complete(changed_type.resume(&keydown, false));

        let mut disabled = TestContext::new("<button id='target'>button</button>");
        let target = disabled.element("target");
        assert!(disabled.document.set_focus_to(target));
        let keydown =
            event(disabled.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        set_disabled(&mut disabled, target, true);
        complete(disabled.resume(&keydown, false));

        let mut detached = TestContext::new("<button id='target'>button</button>");
        let target = detached.element("target");
        assert!(detached.document.set_focus_to(target));
        let keydown =
            event(detached.begin(enter_request(KeyState::Pressed, false, false, false, 0)));
        detached.document.mutate().remove_node(target);
        complete(detached.resume(&keydown, false));
    }

    #[test]
    fn enter_does_not_add_implicit_submit_or_activate_ineligible_inputs() {
        for markup in [
            "<input id='target'>",
            "<input id='target' type='checkbox'>",
            "<input id='target' type='radio'>",
            "<input id='target' type='file'>",
            "<a id='target' tabindex='0'>link</a>",
            "<form><input id='target'><button id='default'>submit</button></form>",
        ] {
            let mut context = TestContext::new(markup);
            let target = context.element("target");
            assert!(context.document.set_focus_to(target), "{markup}");
            let first = context.begin(enter_request(KeyState::Pressed, false, false, false, 0));
            let (types, _, _) = drain(&mut context, first);
            assert!(
                !types.iter().any(|kind| kind == "click"),
                "{markup}: {types:?}"
            );
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "Space activation must retain the exact keyup timestamp and zero click coordinates"
    )]
    fn space_arms_browser_controls_and_clicks_once_on_keyup() {
        for markup in [
            "<button id='target'>button</button>",
            "<input id='target' type='button' value='button'>",
            "<input id='target' type='submit' value='submit'>",
            "<input id='target' type='reset' value='reset'>",
            "<input id='target' type='image' alt='image'>",
            "<input id='target' type='checkbox'>",
            "<input id='target' type='radio'>",
        ] {
            let mut context = TestContext::new(markup);
            let target = context.element("target");
            let target_handle = context.handles.expose(target).unwrap();
            assert!(context.document.set_focus_to(target), "{markup}");
            let modifier_bits = KEY_MOD_SHIFT
                | KEY_MOD_CONTROL
                | KEY_MOD_ALT
                | KEY_MOD_META
                | KEY_MOD_CAPS_LOCK
                | KEY_MOD_ALT_GRAPH
                | KEY_MOD_FN
                | KEY_MOD_NUM_LOCK
                | KEY_MOD_SCROLL_LOCK;

            let keydown = event(context.begin(space_request(
                KeyState::Pressed,
                false,
                false,
                false,
                modifier_bits,
                800.5,
            )));
            complete(context.resume(&keydown, false));
            assert!(context.stack.space_activation_press.is_some(), "{markup}");

            let keyup = event(context.begin(space_request(
                KeyState::Released,
                false,
                false,
                false,
                modifier_bits,
                900.75,
            )));
            assert!(context.stack.space_activation_press.is_none(), "{markup}");
            let click = event(context.resume(&keyup, false));
            assert_eq!(click.event_type, "click", "{markup}");
            assert_eq!(click.target, target_handle, "{markup}");
            assert!(click.bubbles && click.cancelable && click.composed);
            assert_eq!(click.time_stamp, 900.75);
            let Some(DispatchEventPayload::Pointer(payload)) = click.payload.as_deref() else {
                panic!("Space click should carry a pointer payload: {markup}");
            };
            assert_eq!(
                (
                    payload.mouse.client_x,
                    payload.mouse.client_y,
                    payload.mouse.screen_x,
                    payload.mouse.screen_y,
                    payload.mouse.page_x,
                    payload.mouse.page_y,
                    payload.mouse.offset_x,
                    payload.mouse.offset_y,
                ),
                (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
            );
            assert_eq!(
                (
                    payload.mouse.button,
                    payload.mouse.buttons,
                    payload.mouse.detail,
                ),
                (0, 0, 0),
            );
            assert!(
                payload.mouse.shift_key
                    && payload.mouse.ctrl_key
                    && payload.mouse.alt_key
                    && payload.mouse.meta_key
                    && payload.mouse.caps_lock
                    && payload.mouse.alt_graph_key
                    && payload.mouse.fn_key
                    && payload.mouse.num_lock
                    && payload.mouse.scroll_lock
            );
            complete(context.resume(&click, true));
            if markup.contains("checkbox") || markup.contains("radio") {
                assert!(
                    !context
                        .checked_controls
                        .checked(&mut context.document, target)
                        .unwrap(),
                    "a canceled ordinary click must roll checkable preactivation back: {markup}",
                );
            }
        }
    }

    #[test]
    fn space_checkable_click_uses_existing_input_change_and_cancellation_pipeline() {
        let mut context = TestContext::new("<input id='target' type='checkbox'>");
        let target = context.element("target");
        assert!(context.document.set_focus_to(target));
        let down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            1.0,
        ));
        let _ = drain(&mut context, down);
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );

        let keyup = event(context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            2.0,
        )));
        let click = event(context.resume(&keyup, false));
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
        let remainder = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, remainder);
        assert_eq!(types, ["input", "change"]);
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one state-machine test keeps cancellation, suppression, repeat, composition, and abort ownership in sequence"
    )]
    fn space_cancellation_repeat_suppression_and_abort_own_only_their_press() {
        let mut context = TestContext::new("<button id='target'>button</button>");
        let target = context.element("target");
        assert!(context.document.set_focus_to(target));

        for suppressed in [false, true] {
            let keydown = event(context.begin(space_request(
                KeyState::Pressed,
                false,
                false,
                suppressed,
                0,
                1.0,
            )));
            complete(context.resume(&keydown, !suppressed));
            assert!(context.stack.space_activation_press.is_none());
            let keyup = context.begin(space_request(
                KeyState::Released,
                false,
                false,
                false,
                0,
                2.0,
            ));
            let (types, _, _) = drain(&mut context, keyup);
            assert_eq!(types, ["keyup"]);
        }

        let repeated = context.begin(space_request(KeyState::Pressed, true, false, false, 0, 3.0));
        let (types, _, _) = drain(&mut context, repeated);
        assert_eq!(types, ["keydown"]);
        assert!(context.stack.space_activation_press.is_none());

        let down = event(context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            4.0,
        )));
        complete(context.resume(&down, false));
        let generation = context.stack.space_activation_press.unwrap().generation;

        let repeated =
            event(context.begin(space_request(KeyState::Pressed, true, false, false, 0, 5.0)));
        complete(context.resume(&repeated, false));
        assert_eq!(
            context.stack.space_activation_press.unwrap().generation,
            generation
        );

        let canceled_repeat =
            event(context.begin(space_request(KeyState::Pressed, true, false, false, 0, 5.5)));
        complete(context.resume(&canceled_repeat, true));
        assert_eq!(
            context.stack.space_activation_press.unwrap().generation,
            generation
        );

        let aborted_repeat =
            event(context.begin(space_request(KeyState::Pressed, true, false, false, 0, 6.0)));
        assert!(!context.abort(aborted_repeat.frame_id));
        assert_eq!(
            context.stack.space_activation_press.unwrap().generation,
            generation
        );

        let canceled_up = event(context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            7.0,
        )));
        assert!(context.stack.space_activation_press.is_none());
        complete(context.resume(&canceled_up, true));

        let down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            8.0,
        ));
        let _ = drain(&mut context, down);
        let suppressed_up = context.begin(space_request(
            KeyState::Released,
            false,
            false,
            true,
            0,
            8.5,
        ));
        let (types, _, _) = drain(&mut context, suppressed_up);
        assert_eq!(types, ["keyup"]);
        assert!(context.stack.space_activation_press.is_none());

        let down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            8.75,
        ));
        let _ = drain(&mut context, down);
        let aborted_up = event(context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            9.0,
        )));
        assert!(context.stack.space_activation_press.is_none());
        assert!(!context.abort(aborted_up.frame_id));

        for state in [KeyState::Pressed, KeyState::Released] {
            let composing = context.begin(space_request(state, false, true, false, 0, 10.0));
            let (types, _, _) = drain(&mut context, composing);
            assert!(!types.iter().any(|event| event == "click"));
            assert!(context.stack.space_activation_press.is_none());
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the outer frame-owned keyup must retain its exact timestamp through nested dispatch"
    )]
    fn nested_space_dispatch_during_keyup_cannot_consume_the_outer_press() {
        let mut context = TestContext::new("<button id='target'>button</button>");
        let target = context.element("target");
        assert!(context.document.set_focus_to(target));
        let down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            1.0,
        ));
        let _ = drain(&mut context, down);

        let outer_up = event(context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            2.0,
        )));
        assert!(context.stack.space_activation_press.is_none());

        let nested_down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            3.0,
        ));
        let _ = drain(&mut context, nested_down);
        let nested_up = event(context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            4.0,
        )));
        let nested_click = event(context.resume(&nested_up, false));
        assert_eq!(nested_click.event_type, "click");
        complete(context.resume(&nested_click, true));

        let outer_click = event(context.resume(&outer_up, false));
        assert_eq!(outer_click.event_type, "click");
        assert_eq!(outer_click.time_stamp, 2.0);
        complete(context.resume(&outer_click, true));
    }

    #[test]
    fn space_keyup_revalidates_focus_type_disabledness_and_connectivity() {
        let kind = QualName {
            prefix: None,
            ns: ns!(),
            local: LocalName::from("type"),
        };
        for mutation in ["type", "disabled", "detached"] {
            let mut context = TestContext::new("<input id='target' type='checkbox'>");
            let target = context.element("target");
            assert!(context.document.set_focus_to(target));
            let down = context.begin(space_request(
                KeyState::Pressed,
                false,
                false,
                false,
                0,
                1.0,
            ));
            let _ = drain(&mut context, down);
            match mutation {
                "type" => context
                    .document
                    .mutate()
                    .set_attribute(target, kind.clone(), "radio"),
                "disabled" => set_disabled(&mut context, target, true),
                "detached" => context.document.mutate().remove_node(target),
                _ => unreachable!(),
            }
            let up = context.begin(space_request(
                KeyState::Released,
                false,
                false,
                false,
                0,
                2.0,
            ));
            let (types, _, _) = drain(&mut context, up);
            assert!(
                !types.iter().any(|event| event == "click"),
                "{mutation}: {types:?}"
            );
            assert!(context.stack.space_activation_press.is_none());
        }

        let mut context = TestContext::new(
            "<button id='target'>target</button><button id='other'>other</button>",
        );
        let target = context.element("target");
        let other = context.element("other");
        assert!(context.document.set_focus_to(target));
        let down = context.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            1.0,
        ));
        let _ = drain(&mut context, down);
        let focus_other = context.begin_programmatic_focus(other);
        let _ = drain(&mut context, focus_other);
        assert!(context.stack.space_activation_press.is_none());
        let focus_target = context.begin_programmatic_focus(target);
        let _ = drain(&mut context, focus_target);
        let up = context.begin(space_request(
            KeyState::Released,
            false,
            false,
            false,
            0,
            2.0,
        ));
        let (types, _, _) = drain(&mut context, up);
        assert_eq!(types, ["keyup"]);
    }

    #[test]
    fn unfocused_native_keys_target_the_html_body() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let body = context.body();
        let root = context.document.root_element().id;
        assert_eq!(actual_focus_node_id(&context.document), None);

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Character("a".into()), Code::KeyA, KeyState::Pressed),
            metadata: host_key_metadata("a"),
            suppress_default: false,
        }));
        assert_eq!(keydown.event_type, "keydown");
        assert_eq!(context.handles.resolve(keydown.target), Some(body));
        let raw_path = keydown
            .path
            .iter()
            .map(|handle| context.handles.resolve(*handle).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(raw_path.first(), Some(&body));
        assert_eq!(raw_path.last(), Some(&root));
        complete(context.resume(&keydown, false));
    }

    #[test]
    fn unfocused_native_keys_fall_back_to_the_document_element_without_a_body() {
        let mut context = TestContext::new("");
        let body = context.body();
        let root = context.document.root_element().id;
        context.document.mutate().remove_node(body);
        assert_eq!(actual_focus_node_id(&context.document), None);

        let keyup = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            metadata: host_key_metadata("Escape"),
            suppress_default: false,
        }));
        assert_eq!(keyup.event_type, "keyup");
        assert_eq!(context.handles.resolve(keyup.target), Some(root));
        complete(context.resume(&keyup, false));
    }

    #[test]
    fn native_keys_prefer_the_actually_focused_element_over_body() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Pressed),
            metadata: host_key_metadata("Escape"),
            suppress_default: false,
        }));
        assert_eq!(keydown.event_type, "keydown");
        assert_eq!(context.handles.resolve(keydown.target), Some(button));
        complete(context.resume(&keydown, false));
    }

    #[test]
    fn key_cancellation_and_native_policy_both_prevent_editor_defaults() {
        for (javascript_cancels, native_suppresses) in [(true, false), (false, true)] {
            let mut context = TestContext::new("<input id='editor' value='ab'>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            let initial = context.raw_text(input);

            let key_step = event(context.begin(DispatchRequest::Key {
                event: key(Key::Delete, Code::Delete, KeyState::Pressed),
                metadata: host_key_metadata("Delete"),
                suppress_default: native_suppresses,
            }));
            assert_eq!(key_step.event_type, "keydown");
            let resumed = context.resume(&key_step, javascript_cancels);
            assert!(
                matches!(resumed, DispatchStep::Complete { .. }),
                "a canceled or host-suppressed keydown must not stage beforeinput"
            );
            complete(resumed);
            assert_eq!(context.raw_text(input), initial);
        }

        let mut context = TestContext::new("<input id='editor' value='ab'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let key_step = event(context.begin(DispatchRequest::Key {
            event: key(Key::Delete, Code::Delete, KeyState::Pressed),
            metadata: host_key_metadata("Delete"),
            suppress_default: false,
        }));
        let before_input = event(context.resume(&key_step, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert_eq!(context.raw_text(input), "ab");
        let input_step = event(context.resume(&before_input, false));
        assert_eq!(input_step.event_type, "input");
        assert_eq!(context.raw_text(input), "b");
    }

    #[test]
    fn beforeinput_cancellation_detachment_replacement_and_abort_suppress_the_edit() {
        let mut canceled = TestContext::new("<input id='editor' value='ab'>");
        let input = canceled.element("editor");
        assert!(canceled.document.set_focus_to(input));
        canceled
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let keydown = event(canceled.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        let before_input = event(canceled.resume(&keydown, false));
        complete(canceled.resume(&before_input, true));
        assert_eq!(canceled.raw_text(input), "ab");

        let mut detached = TestContext::new("<input id='editor' value='ab'>");
        let input = detached.element("editor");
        assert!(detached.document.set_focus_to(input));
        detached
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let keydown = event(detached.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        let before_input = event(detached.resume(&keydown, false));
        detached.document.mutate().remove_node(input);
        complete(detached.resume(&before_input, false));
        assert_eq!(detached.raw_text(input), "ab");

        let mut replaced = TestContext::new("<input id='editor' value='ab'>");
        let input = replaced.element("editor");
        assert!(replaced.document.set_focus_to(input));
        replaced
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let keydown = event(replaced.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        let before_input = event(replaced.resume(&keydown, false));
        assert_eq!(
            replaced.handles.invalidate_node(input),
            Some(before_input.target)
        );
        let replacement = replaced.handles.expose(input).unwrap();
        assert_ne!(replacement, before_input.target);
        complete(replaced.resume(&before_input, false));
        assert_eq!(replaced.raw_text(input), "ab");

        let mut nested = TestContext::new("<input id='editor' value='ab'>");
        let input = nested.element("editor");
        assert!(nested.document.set_focus_to(input));
        nested
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let keydown = event(nested.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        let before_input = event(nested.resume(&keydown, false));
        let nested_before_input = event(nested.begin(DispatchRequest::ImeCommit("y".to_owned())));
        assert_eq!(nested_before_input.event_type, "beforeinput");
        let nested_input = event(nested.resume(&nested_before_input, false));
        assert_eq!(nested_input.event_type, "input");
        complete(nested.resume(&nested_input, false));
        assert_eq!(nested.raw_text(input), "aby");
        let input_event = event(nested.resume(&before_input, false));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(nested.raw_text(input), "abyx");
        complete(nested.resume(&input_event, false));

        let mut aborted = TestContext::new("<input id='editor' value='ab'>");
        let input = aborted.element("editor");
        assert!(aborted.document.set_focus_to(input));
        aborted
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let keydown = event(aborted.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        let before_input = event(aborted.resume(&keydown, false));
        assert!(!aborted.abort(before_input.frame_id));
        assert_eq!(aborted.raw_text(input), "ab");
        assert!(
            aborted
                .stack
                .resume(
                    &mut aborted.document,
                    &mut aborted.text_controls,
                    &mut aborted.checked_controls,
                    &mut aborted.handles,
                    aborted.redraw.as_ref(),
                    before_input.frame_id,
                    before_input.event_id,
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn keydown_listener_mutations_cannot_reinterpret_edit_and_activation_defaults() {
        let type_name = QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("type"),
        };

        let mut editor_to_button = TestContext::new("<input id='target' value='ab'>");
        let target = editor_to_button.element("target");
        assert!(editor_to_button.document.set_focus_to(target));
        let keydown = event(editor_to_button.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        editor_to_button
            .document
            .mutate()
            .set_attribute(target, type_name.clone(), "button");
        complete(editor_to_button.resume(&keydown, false));
        assert_eq!(editor_to_button.raw_text(target), "ab");

        let mut checkbox_to_editor = TestContext::new("<input id='target' type='checkbox'>");
        let target = checkbox_to_editor.element("target");
        assert!(checkbox_to_editor.document.set_focus_to(target));
        let keydown = event(checkbox_to_editor.begin(space_request(
            KeyState::Pressed,
            false,
            false,
            false,
            0,
            1.0,
        )));
        checkbox_to_editor
            .document
            .mutate()
            .set_attribute(target, type_name, "text");
        complete(checkbox_to_editor.resume(&keydown, false));
        assert!(checkbox_to_editor.stack.space_activation_press.is_none());

        for attribute in ["readonly", "disabled"] {
            let mut context = TestContext::new("<input id='editor' value='ab'>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            context.document.mutate().set_attribute(
                input,
                QualName {
                    prefix: None,
                    ns: ns!(),
                    local: LocalName::from(attribute),
                },
                "",
            );
            let keydown = event(context.begin(DispatchRequest::Key {
                event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
                metadata: host_key_metadata("x"),
                suppress_default: false,
            }));
            complete(context.resume(&keydown, false));
            assert_eq!(context.raw_text(input), "ab", "{attribute}");
        }
    }

    #[test]
    fn nested_frames_resume_independently_and_abort_removes_descendants() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));

        let outer = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            metadata: host_key_metadata("Escape"),
            suppress_default: false,
        }));
        assert_ne!(outer.frame_id, inner.frame_id);
        assert_ne!(outer.event_id, inner.event_id);
        assert_eq!(complete(context.resume(&inner, false)).0, inner.frame_id);
        assert_eq!(complete(context.resume(&outer, false)).0, outer.frame_id);

        let outer = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            metadata: host_key_metadata("Escape"),
            suppress_default: false,
        }));
        context.abort(outer.frame_id);
        context.abort(outer.frame_id);
        assert!(
            context
                .stack
                .resume(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                    inner.frame_id,
                    inner.event_id,
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn stale_handle_generation_skips_compatibility_and_default_actions() {
        let mut context = TestContext::new("<input id='editor' value='ab'>");
        let input = context.element("editor");
        let (x, y) = context.center(input);
        assert!(context.document.set_hover_to(x, y));

        let pointer_step = event(context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::native(),
        }));
        let stale_handle = pointer_step.target;
        assert_eq!(context.handles.invalidate_node(input), Some(stale_handle));
        let replacement_handle = context
            .handles
            .expose(input)
            .expect("the live raw node can receive a fresh generation");
        assert_ne!(replacement_handle, stale_handle);

        complete(context.resume(&pointer_step, false));
        assert_ne!(context.document.get_focussed_node_id(), Some(input));
    }

    #[test]
    fn non_bubbling_steps_still_freeze_the_full_target_first_path() {
        let mut context =
            TestContext::new("<section id='outer'><button id='button'>go</button></section>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));
        let target = guard_node(&context.document, &mut context.handles, button)
            .expect("path handles should fit")
            .expect("focus target should be live");
        let guarded = guard_event_with_target(
            &context.document,
            &mut context.handles,
            target,
            DomEventData::Focus(BlitzFocusEvent),
            EventMetadata::native(),
        )
        .expect("path handles should fit")
        .expect("focus target should be live");
        let frame_id = context
            .stack
            .allocate_frame_id()
            .expect("frame id should fit");
        context.stack.frames.push(DispatchFrame {
            id: frame_id,
            planned: VecDeque::new(),
            generated: VecDeque::from([guarded]),
            pending: None,
            redraw_requested: false,
        });
        let focus = event(
            context
                .stack
                .advance(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                )
                .expect("focus should stage"),
        );
        assert_eq!(focus.event_type, "focus");
        assert!(!focus.bubbles);
        assert_eq!(focus.target, focus.path[0]);
        let raw_path: Vec<_> = focus
            .path
            .iter()
            .map(|handle| {
                context
                    .handles
                    .resolve(*handle)
                    .expect("path node stays live")
            })
            .collect();
        assert_eq!(raw_path[0], button);
        assert_eq!(raw_path.last(), Some(&context.document.root_element().id));
        assert!(raw_path.len() >= 4);
    }

    #[test]
    fn ime_and_apple_engine_records_stay_internal_but_generated_input_is_staged() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));

        let before_commit = event(context.begin(DispatchRequest::ImeCommit("é\n".to_owned())));
        assert_eq!(before_commit.event_type, "beforeinput");
        assert!(before_commit.bubbles && before_commit.cancelable && before_commit.composed);
        assert_eq!(
            before_commit.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("é\n".to_owned()),
                input_type: "insertText",
                is_composing: false,
            }))
        );
        assert_eq!(context.raw_text(input), "");
        let commit = event(context.resume(&before_commit, false));
        assert_eq!(commit.event_type, "input");
        assert_eq!(
            commit.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("é\n".to_owned()),
                input_type: "insertText",
                is_composing: false,
            }))
        );
        assert_eq!(context.raw_text(input), "é");
        assert_eq!(context.live_value(input), "é");
        complete(context.resume(&commit, false));

        let before_apple = event(context.begin(DispatchRequest::AppleStandardKeybinding(
            "deleteBackward:".to_owned(),
        )));
        assert_eq!(before_apple.event_type, "beforeinput");
        assert_eq!(
            before_apple.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: None,
                input_type: "deleteContentBackward",
                is_composing: false,
            }))
        );
        assert_eq!(context.raw_text(input), "é");
        let apple = event(context.resume(&before_apple, false));
        assert_eq!(apple.event_type, "input");
        assert_eq!(
            apple.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: None,
                input_type: "deleteContentBackward",
                is_composing: false,
            }))
        );
        assert_eq!(context.raw_text(input), "");
        assert_eq!(context.live_value(input), "");
        complete(context.resume(&apple, false));
    }

    #[test]
    fn active_ime_commit_reconciles_final_text_through_composition_events() {
        let mut context = TestContext::new("<input id='editor' value='base'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let first_preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "候補".to_owned(),
            None,
        )));
        assert_eq!(
            drain_steps(&mut context, first_preedit)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionstart",
                "compositionupdate",
                "beforeinput",
                "input"
            ]
        );
        assert_eq!(context.raw_text(input), "base候補");

        let update = event(context.begin(DispatchRequest::ImeCommit("確定".to_owned())));
        assert_eq!(update.event_type, "compositionupdate");
        assert_eq!(
            update.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: "確定".to_owned(),
            })
        );
        let before_input = event(context.resume(&update, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert!(!before_input.cancelable);
        assert_eq!(
            before_input.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("確定".to_owned()),
                input_type: "insertCompositionText",
                is_composing: true,
            }))
        );
        assert_eq!(context.raw_text(input), "base候補");
        let input_event = event(context.resume(&before_input, true));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(context.raw_text(input), "base確定");
        let end = event(context.resume(&input_event, false));
        assert_eq!(end.event_type, "compositionend");
        assert_eq!(
            end.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: "確定".to_owned(),
            })
        );
        let (_, redraw_requested) = complete(context.resume(&end, false));
        assert!(redraw_requested);
        assert_eq!(context.live_value(input), "base確定");
    }

    #[test]
    fn empty_ime_commit_cancels_an_active_composition_but_is_otherwise_silent() {
        let mut context = TestContext::new("<input id='editor' value='base'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());
        let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "candidate".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, preedit);

        let cancel = context.begin(DispatchRequest::ImeCommit(String::new()));
        assert_eq!(
            drain_steps(&mut context, cancel)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionupdate",
                "beforeinput",
                "input",
                "compositionend"
            ]
        );
        assert_eq!(context.raw_text(input), "base");
        complete(context.begin(DispatchRequest::ImeCommit(String::new())));
    }

    #[test]
    fn nonediting_native_commands_do_not_dispatch_beforeinput() {
        let mut context = TestContext::new("<input id='editor' value='ab'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));

        let mut copy = key(Key::Character("c".into()), Code::KeyC, KeyState::Pressed);
        copy.modifiers = Modifiers::CONTROL;
        let keydown = event(context.begin(DispatchRequest::Key {
            event: copy,
            metadata: host_key_metadata("c"),
            suppress_default: false,
        }));
        complete(context.resume(&keydown, false));

        complete(context.begin(DispatchRequest::AppleStandardKeybinding(
            "moveLeft:".to_owned(),
        )));
        complete(context.begin(DispatchRequest::AppleStandardKeybinding(
            "futureUnsupportedCommand:".to_owned(),
        )));

        let enter = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Pressed),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        complete(context.resume(&enter, false));
    }

    #[test]
    fn ime_preedit_dispatches_browser_lifecycle_before_mutating_text() {
        let mut context = TestContext::new("<input id='editor' value='before'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context.document.with_text_input(input, |mut driver| {
            driver.move_to_text_end();
        });

        let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "候補".to_owned(),
            None,
        ))));
        assert_eq!(start.event_type, "compositionstart");
        assert!(start.bubbles && start.cancelable && start.composed);
        assert_eq!(
            start.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: String::new(),
            })
        );
        assert_eq!(context.raw_text(input), "before");

        let update = event(context.resume(&start, false));
        assert_eq!(update.event_type, "compositionupdate");
        assert!(update.bubbles && !update.cancelable && update.composed);
        assert_eq!(update.time_stamp.to_bits(), start.time_stamp.to_bits());
        assert_eq!(update.target, start.target);
        assert_eq!(update.path, start.path);
        assert_eq!(
            update.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: "候補".to_owned(),
            })
        );
        assert_eq!(context.raw_text(input), "before");

        let before_input = event(context.resume(&update, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert!(before_input.bubbles && !before_input.cancelable && before_input.composed);
        assert_eq!(
            before_input.time_stamp.to_bits(),
            start.time_stamp.to_bits()
        );
        assert_eq!(before_input.target, start.target);
        assert_eq!(
            before_input.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("候補".to_owned()),
                input_type: "insertCompositionText",
                is_composing: true,
            }))
        );
        assert_eq!(context.raw_text(input), "before");

        let input_event = event(context.resume(&before_input, true));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(input_event.time_stamp.to_bits(), start.time_stamp.to_bits());
        assert_eq!(input_event.target, start.target);
        assert_eq!(context.raw_text(input), "before候補");
        complete(context.resume(&input_event, false));
        assert_eq!(context.live_value(input), "before候補");
        context
            .text_controls
            .reconcile_document(&mut context.document);
        assert_eq!(context.raw_text(input), "before候補");
    }

    #[test]
    fn cursor_only_preedit_keeps_the_composition_edit_event_triple_atomic() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let first = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "same".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, first);

        let update = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "same".to_owned(),
            Some((2, 2)),
        )));
        let events = drain_steps(&mut context, update);
        assert_eq!(
            events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["compositionupdate", "beforeinput", "input"]
        );
        assert_eq!(
            events[2].payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("same".to_owned()),
                input_type: "insertCompositionText",
                is_composing: true,
            }))
        );
        assert_eq!(context.raw_text(input), "same");
    }

    #[test]
    fn canceled_compositionstart_ends_without_updates_or_mutation() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));

        let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "first".to_owned(),
            None,
        ))));
        assert_eq!(start.event_type, "compositionstart");
        // A native callback re-entering from compositionstart cannot outrun the listener's
        // cancellation decision.
        complete(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "nested".to_owned(),
            None,
        ))));
        assert_eq!(context.raw_text(input), "");

        let end = event(context.resume(&start, true));
        assert_eq!(end.event_type, "compositionend");
        assert_eq!(
            end.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: String::new(),
            })
        );
        complete(context.resume(&end, false));
        assert_eq!(context.raw_text(input), "");

        complete(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "ignored".to_owned(),
            None,
        ))));
        assert!(context.stack.active_composition.is_none());
        assert!(context.stack.canceled_composition.is_some());
        assert_eq!(context.raw_text(input), "");
        complete(context.begin(DispatchRequest::ImeCommit("ignored".to_owned())));
        assert!(context.stack.canceled_composition.is_none());

        let later = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "later".to_owned(),
            None,
        )));
        assert_eq!(
            drain_steps(&mut context, later)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionstart",
                "compositionupdate",
                "beforeinput",
                "input"
            ]
        );
        assert_eq!(context.raw_text(input), "later");

        let end = event(context.begin(DispatchRequest::ImeCommit("later".to_owned())));
        assert_eq!(end.event_type, "compositionend");
        complete(context.resume(&end, false));
    }

    #[test]
    fn terminal_record_deferred_during_canceled_start_avoids_a_stale_tombstone() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "first".to_owned(),
            None,
        ))));
        complete(context.begin(DispatchRequest::ImeCommit("terminal".to_owned())));
        let end = event(context.resume(&start, true));
        assert_eq!(end.event_type, "compositionend");
        complete(context.resume(&end, false));
        assert!(context.stack.canceled_composition.is_none());

        let next = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "next".to_owned(),
            None,
        ))));
        assert_eq!(next.event_type, "compositionstart");
        assert!(context.abort(next.frame_id));
    }

    #[test]
    fn terminal_ime_records_reentering_compositionstart_are_replayed_after_acceptance() {
        for (nested, expected_value) in [
            (DispatchRequest::ImeCommit("done".to_owned()), "basedone"),
            (DispatchRequest::ImeCommit(String::new()), "base"),
            (
                DispatchRequest::Ime(BlitzImeEvent::Preedit(String::new(), None)),
                "base",
            ),
        ] {
            let mut context = TestContext::new("<input id='editor' value='base'>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            context
                .document
                .with_text_input(input, |mut driver| driver.move_to_text_end());
            let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "first".to_owned(),
                None,
            ))));
            complete(context.begin(nested));

            let after_start = context.resume(&start, false);
            assert_eq!(
                drain_steps(&mut context, after_start)
                    .iter()
                    .map(|event| event.event_type.as_str())
                    .collect::<Vec<_>>(),
                [
                    "compositionupdate",
                    "beforeinput",
                    "input",
                    "compositionupdate",
                    "beforeinput",
                    "input",
                    "compositionend",
                ]
            );
            assert_eq!(context.raw_text(input), expected_value);
        }
    }

    #[test]
    fn start_deferred_terminal_preserves_the_following_session_boundary() {
        for cancel_start in [false, true] {
            let mut context = TestContext::new("<input id='editor' value=''>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "initial".to_owned(),
                None,
            ))));
            complete(context.begin(DispatchRequest::ImeCommit("terminal".to_owned())));
            complete(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "next".to_owned(),
                None,
            ))));

            let after_start = context.resume(&start, cancel_start);
            let events = drain_steps(&mut context, after_start);
            let types = events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>();
            let end = types
                .iter()
                .position(|event_type| *event_type == "compositionend")
                .expect("the terminal record must end the old session");
            let next_start = types
                .iter()
                .position(|event_type| *event_type == "compositionstart")
                .expect("the post-terminal preedit must begin a new session");
            assert!(end < next_start, "{types:?}");
            assert_eq!(
                context
                    .stack
                    .active_composition
                    .as_ref()
                    .map(|active| active.data.as_str()),
                Some("next")
            );
            assert!(context.stack.canceled_composition.is_none());
        }
    }

    #[test]
    fn newer_nested_update_supersedes_a_start_deferred_record() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "initial".to_owned(),
            None,
        ))));
        complete(context.begin(DispatchRequest::ImeCommit("deferred".to_owned())));

        let outer_update = event(context.resume(&start, false));
        assert_eq!(outer_update.event_type, "compositionupdate");
        let newer = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "newer".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, newer);
        complete(context.resume(&outer_update, false));

        assert_eq!(context.raw_text(input), "newer");
        assert_eq!(
            context
                .stack
                .active_composition
                .as_ref()
                .map(|active| active.data.as_str()),
            Some("newer")
        );
    }

    #[test]
    fn nested_preedit_supersedes_each_stale_outer_continuation_without_ending_session() {
        for stale_event_index in 0..3 {
            let mut context = TestContext::new("<input id='editor' value=''>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            let initial = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "initial".to_owned(),
                None,
            )));
            let _ = drain_steps(&mut context, initial);

            let mut stale = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "outer".to_owned(),
                None,
            ))));
            for _ in 0..stale_event_index {
                stale = event(context.resume(&stale, false));
            }
            assert_eq!(
                stale.event_type,
                ["compositionupdate", "beforeinput", "input"][stale_event_index]
            );

            let nested = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "nested".to_owned(),
                None,
            )));
            assert_eq!(
                drain_steps(&mut context, nested)
                    .iter()
                    .map(|event| event.event_type.as_str())
                    .collect::<Vec<_>>(),
                ["compositionupdate", "beforeinput", "input"]
            );
            complete(context.resume(&stale, false));
            assert_eq!(context.raw_text(input), "nested");

            let end = event(context.begin(DispatchRequest::ImeCommit("nested".to_owned())));
            assert_eq!(end.event_type, "compositionend");
            complete(context.resume(&end, false));
        }
    }

    #[test]
    fn aborting_any_pending_composition_phase_discards_only_its_owned_session() {
        for pending_event_index in 0..4 {
            let mut context = TestContext::new("<input id='editor' value=''>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            let mut pending = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "aborted".to_owned(),
                None,
            ))));
            for _ in 0..pending_event_index {
                pending = event(context.resume(&pending, false));
            }
            assert_eq!(
                pending.event_type,
                [
                    "compositionstart",
                    "compositionupdate",
                    "beforeinput",
                    "input"
                ][pending_event_index]
            );
            assert!(context.abort(pending.frame_id));

            let restarted = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "restarted".to_owned(),
                None,
            ))));
            assert_eq!(restarted.event_type, "compositionstart");
            assert!(context.abort(restarted.frame_id));
        }

        let mut deferred = TestContext::new("<input id='editor' value=''>");
        let input = deferred.element("editor");
        assert!(deferred.document.set_focus_to(input));
        let start = event(deferred.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "outer".to_owned(),
            None,
        ))));
        complete(deferred.begin(DispatchRequest::ImeCommit("nested".to_owned())));
        assert!(!deferred.stack.pending_start_ime.is_empty());
        assert!(deferred.abort(start.frame_id));
        assert!(deferred.stack.pending_start_ime.is_empty());
        let restarted = event(deferred.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "restarted".to_owned(),
            None,
        ))));
        assert_eq!(restarted.event_type, "compositionstart");
        assert!(deferred.abort(restarted.frame_id));
    }

    #[test]
    fn disabled_closes_only_the_composition_it_observed() {
        let mut disabled = TestContext::new("<input id='editor' value=''>");
        let input = disabled.element("editor");
        assert!(disabled.document.set_focus_to(input));
        let preedit = disabled.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "active".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut disabled, preedit);
        let end = event(disabled.begin(DispatchRequest::Ime(BlitzImeEvent::Disabled)));
        assert_eq!(end.event_type, "compositionend");
        assert_eq!(
            end.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: "active".to_owned(),
            })
        );
        let nested = disabled.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "new".to_owned(),
            None,
        )));
        assert_eq!(
            drain_steps(&mut disabled, nested)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionstart",
                "compositionupdate",
                "beforeinput",
                "input"
            ]
        );
        let (_, redraw_requested) = complete(disabled.resume(&end, false));
        assert!(redraw_requested);
        assert_eq!(disabled.raw_text(input), "newactive");
        assert_eq!(
            disabled
                .stack
                .active_composition
                .as_ref()
                .map(|active| active.data.as_str()),
            Some("new")
        );
        let nested_end = event(disabled.begin(DispatchRequest::ImeCommit("new".to_owned())));
        assert_eq!(nested_end.event_type, "compositionend");
        complete(disabled.resume(&nested_end, false));
    }

    #[test]
    fn focus_loss_closes_composition_before_followup_work() {
        let mut blurred = TestContext::new("<input id='editor' value=''>");
        let input = blurred.element("editor");
        assert!(blurred.document.set_focus_to(input));
        let preedit = blurred.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "active".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut blurred, preedit);
        let blur = blurred.begin_programmatic_blur(input);
        let events = drain_steps(&mut blurred, blur);
        assert_eq!(
            events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["compositionend", "blur", "focusout"]
        );
        assert_eq!(events[0].target, events[1].target);

        let mut reentrant =
            TestContext::new("<input id='first' value=''><input id='second' value=''>");
        let first = reentrant.element("first");
        let second = reentrant.element("second");
        assert!(reentrant.document.set_focus_to(first));
        let preedit = reentrant.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "active".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut reentrant, preedit);
        let first_guard = guard_node(&reentrant.document, &mut reentrant.handles, first)
            .expect("focus target handle should fit")
            .expect("focus target should remain live");
        let second_guard = guard_node(&reentrant.document, &mut reentrant.handles, second)
            .expect("related target handle should fit")
            .expect("related target should remain live");
        reentrant.document.clear_focus();
        assert!(reentrant.document.set_focus_to(second));
        let frame_id = reentrant
            .stack
            .allocate_frame_id()
            .expect("frame id should fit");
        reentrant.stack.frames.push(DispatchFrame {
            id: frame_id,
            planned: VecDeque::new(),
            generated: VecDeque::new(),
            pending: None,
            redraw_requested: false,
        });
        reentrant
            .stack
            .run_action(
                &mut reentrant.document,
                &mut reentrant.text_controls,
                &mut reentrant.handles,
                DispatchAction::LoseFocus {
                    target: first_guard,
                    related_target: Some(second_guard),
                    metadata: EventMetadata::native(),
                },
            )
            .expect("stale focus action should still close composition");
        let end = event(
            reentrant
                .stack
                .advance(
                    &mut reentrant.document,
                    &mut reentrant.text_controls,
                    &mut reentrant.checked_controls,
                    &mut reentrant.handles,
                    reentrant.redraw.as_ref(),
                )
                .expect("composition end should stage"),
        );
        assert_eq!(end.event_type, "compositionend");
        assert_eq!(end.target, first_guard.handle);
        complete(reentrant.resume(&end, false));
        assert_eq!(actual_focus_node_id(&reentrant.document), Some(second));
    }

    #[test]
    fn new_target_preedit_replay_cannot_overwrite_a_session_started_from_old_end() {
        let mut context =
            TestContext::new("<input id='first' value=''><input id='second' value=''>");
        let first = context.element("first");
        let second = context.element("second");
        assert!(context.document.set_focus_to(first));
        let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "old".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, preedit);
        context.document.clear_focus();
        assert!(context.document.set_focus_to(second));

        let old_end = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "outer".to_owned(),
            None,
        ))));
        assert_eq!(old_end.event_type, "compositionend");
        let nested = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "nested".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, nested);
        complete(context.resume(&old_end, false));

        assert_eq!(context.raw_text(first), "old");
        assert_eq!(context.raw_text(second), "nested");
        assert_eq!(
            context
                .stack
                .active_composition
                .as_ref()
                .map(|active| (active.target.raw, active.data.as_str())),
            Some((second, "nested"))
        );
    }

    #[test]
    fn gaining_focus_clears_a_detached_composition_before_new_target_input() {
        let mut context =
            TestContext::new("<input id='first' value=''><input id='second' value=''>");
        let first = context.element("first");
        let second = context.element("second");
        assert!(context.document.set_focus_to(first));
        let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "old".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, preedit);
        context.document.mutate().remove_node(first);

        let focus = context.begin_programmatic_focus(second);
        assert_eq!(
            drain_steps(&mut context, focus)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["compositionend", "focus", "focusin"]
        );
        assert!(context.stack.active_composition.is_none());

        let new_preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "new".to_owned(),
            None,
        )));
        assert_eq!(
            drain_steps(&mut context, new_preedit)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionstart",
                "compositionupdate",
                "beforeinput",
                "input"
            ]
        );
        assert_eq!(context.raw_text(second), "new");
    }

    #[test]
    fn composition_end_uses_locked_live_target_after_editability_changes() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "active".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, preedit);

        let update = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "blocked".to_owned(),
            None,
        ))));
        context.document.mutate().set_attribute(
            input,
            QualName {
                prefix: None,
                ns: ns!(),
                local: local_name!("readonly"),
            },
            "",
        );
        let end = event(context.resume(&update, false));
        assert_eq!(end.event_type, "compositionend");
        assert_eq!(end.target, update.target);
        assert_eq!(
            end.payload.as_deref(),
            Some(&DispatchEventPayload::Composition {
                data: "active".to_owned(),
            })
        );
        complete(context.resume(&end, false));
        assert_eq!(context.raw_text(input), "active");
    }

    #[test]
    fn matching_commit_ends_without_duplicate_input_and_end_reentrancy_survives() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "same".to_owned(),
            None,
        )));
        let _ = drain_steps(&mut context, preedit);

        let end = event(context.begin(DispatchRequest::ImeCommit("same".to_owned())));
        assert_eq!(end.event_type, "compositionend");
        let nested_start = event(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
            "new".to_owned(),
            None,
        ))));
        assert_eq!(nested_start.event_type, "compositionstart");
        let nested_events = drain_steps(&mut context, DispatchStep::Event(nested_start));
        assert_eq!(
            nested_events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "compositionstart",
                "compositionupdate",
                "beforeinput",
                "input"
            ]
        );
        complete(context.resume(&end, false));

        let nested_end = event(context.begin(DispatchRequest::ImeCommit("new".to_owned())));
        assert_eq!(nested_end.event_type, "compositionend");
        let (_, redraw_requested) = complete(context.resume(&nested_end, false));
        assert!(redraw_requested);
    }

    #[test]
    fn terminal_commit_defers_nested_preedit_until_after_compositionend() {
        for pending_event_index in 0..3 {
            let mut context = TestContext::new("<input id='editor' value=''>");
            let input = context.element("editor");
            assert!(context.document.set_focus_to(input));
            let preedit = context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "old".to_owned(),
                None,
            )));
            let _ = drain_steps(&mut context, preedit);

            let mut pending =
                event(context.begin(DispatchRequest::ImeCommit("terminal".to_owned())));
            for _ in 0..pending_event_index {
                pending = event(context.resume(&pending, false));
            }
            assert_eq!(
                pending.event_type,
                ["compositionupdate", "beforeinput", "input"][pending_event_index]
            );
            complete(context.begin(DispatchRequest::Ime(BlitzImeEvent::Preedit(
                "next".to_owned(),
                None,
            ))));

            let after_pending = context.resume(&pending, false);
            let events = drain_steps(&mut context, after_pending);
            let types = events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>();
            let end = types
                .iter()
                .position(|event_type| *event_type == "compositionend")
                .expect("the native terminal commit must dispatch compositionend");
            let next_start = types
                .iter()
                .position(|event_type| *event_type == "compositionstart")
                .expect("the nested preedit must begin the following session");
            assert!(end < next_start, "{types:?}");
            assert_eq!(
                context
                    .stack
                    .active_composition
                    .as_ref()
                    .map(|active| active.data.as_str()),
                Some("next")
            );
        }
    }

    #[test]
    fn keyboard_default_updates_live_value_before_staging_generated_input() {
        let mut context = TestContext::new("<input id='editor' value='before'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context.document.with_text_input(input, |mut driver| {
            driver.move_to_text_end();
        });

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed),
            metadata: host_key_metadata("x"),
            suppress_default: false,
        }));
        assert_eq!(keydown.event_type, "keydown");
        let before_input = event(context.resume(&keydown, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert!(before_input.bubbles);
        assert!(before_input.cancelable);
        assert!(before_input.composed);
        assert_eq!(before_input.target, keydown.target);
        assert_eq!(before_input.path, keydown.path);
        assert_eq!(
            before_input.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("x".to_owned()),
                input_type: "insertText",
                is_composing: false,
            }))
        );
        assert_eq!(context.live_value(input), "before");
        let input_event = event(context.resume(&before_input, false));

        assert_eq!(input_event.event_type, "input");
        assert_eq!(
            input_event.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("x".to_owned()),
                input_type: "insertText",
                is_composing: false,
            }))
        );
        assert_eq!(context.live_value(input), "beforex");
        complete(context.resume(&input_event, false));
    }

    #[test]
    fn unchanged_text_defaults_do_not_dispatch_input() {
        let mut context = TestContext::new("<input id='editor' value='abc'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_start());

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Backspace, Code::Backspace, KeyState::Pressed),
            metadata: host_key_metadata("Backspace"),
            suppress_default: false,
        }));
        assert_eq!(keydown.event_type, "keydown");
        let before_input = event(context.resume(&keydown, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert!(before_input.bubbles && before_input.cancelable && before_input.composed);
        assert_eq!(
            before_input.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: None,
                input_type: "deleteContentBackward",
                is_composing: false,
            }))
        );
        complete(context.resume(&before_input, false));
        assert_eq!(context.raw_text(input), "abc");

        let before_input = event(context.begin(DispatchRequest::AppleStandardKeybinding(
            "deleteBackward:".to_owned(),
        )));
        assert_eq!(before_input.event_type, "beforeinput");
        complete(context.resume(&before_input, false));
        assert_eq!(context.raw_text(input), "abc");

        for (character, code) in [("c", Code::KeyC), ("v", Code::KeyV)] {
            let mut key_event = key(Key::Character(character.into()), code, KeyState::Pressed);
            key_event.modifiers = Modifiers::CONTROL;
            let keydown = event(context.begin(DispatchRequest::Key {
                event: key_event,
                metadata: host_key_metadata(character),
                suppress_default: false,
            }));
            let resumed = context.resume(&keydown, false);
            if character == "v" {
                let before_input = event(resumed);
                assert_eq!(before_input.event_type, "beforeinput");
                complete(context.resume(&before_input, false));
            } else {
                complete(resumed);
            }
            assert_eq!(context.raw_text(input), "abc");
        }
    }

    #[test]
    fn identical_selected_text_replacement_still_dispatches_input() {
        let mut context = TestContext::new("<input id='editor' value='a'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.select_all());

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Character("a".into()), Code::KeyA, KeyState::Pressed),
            metadata: host_key_metadata("a"),
            suppress_default: false,
        }));
        let before_input = event(context.resume(&keydown, false));
        let input_event = event(context.resume(&before_input, false));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(input_event.target, before_input.target);
        assert_eq!(
            input_event.time_stamp.to_bits(),
            before_input.time_stamp.to_bits()
        );
        assert_eq!(context.raw_text(input), "a");
        assert_eq!(
            input_event.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("a".to_owned()),
                input_type: "insertText",
                is_composing: false,
            }))
        );
        complete(context.resume(&input_event, false));
    }

    #[test]
    fn line_break_and_composing_character_inputs_expose_their_edit_details() {
        let mut context = TestContext::new("<textarea id='editor'>a</textarea>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.move_to_text_end());

        let enter = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Pressed),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        let before_line_break = event(context.resume(&enter, false));
        let line_break = event(context.resume(&before_line_break, false));
        assert_eq!(
            line_break.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: None,
                input_type: "insertLineBreak",
                is_composing: false,
            }))
        );
        complete(context.resume(&line_break, false));

        let mut composing = key(Key::Character("候".into()), Code::KeyA, KeyState::Pressed);
        composing.is_composing = true;
        let keydown = event(context.begin(DispatchRequest::Key {
            event: composing,
            metadata: host_key_metadata("候"),
            suppress_default: false,
        }));
        let before_input = event(context.resume(&keydown, false));
        assert_eq!(before_input.event_type, "beforeinput");
        assert!(!before_input.cancelable);
        assert_eq!(
            before_input.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("候".to_owned()),
                input_type: "insertCompositionText",
                is_composing: true,
            }))
        );
        let input_event = event(context.resume(&before_input, true));
        assert_eq!(
            input_event.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: Some("候".to_owned()),
                input_type: "insertCompositionText",
                is_composing: true,
            }))
        );
        complete(context.resume(&input_event, false));
    }

    #[test]
    fn supported_native_edit_commands_map_to_browser_input_types() {
        let mut cut = key(Key::Character("x".into()), Code::KeyX, KeyState::Pressed);
        cut.modifiers = Modifiers::CONTROL;
        let mut paste = key(Key::Character("v".into()), Code::KeyV, KeyState::Pressed);
        paste.modifiers = Modifiers::CONTROL;
        let mut word_delete = key(Key::Delete, Code::Delete, KeyState::Pressed);
        word_delete.modifiers = Modifiers::CONTROL;

        assert_eq!(keyboard_edit_intent(&cut), Some(EditIntent::DeleteByCut));
        assert_eq!(
            keyboard_edit_intent(&paste),
            Some(EditIntent::InsertFromPaste)
        );
        assert_eq!(
            keyboard_edit_intent(&word_delete),
            Some(EditIntent::DeleteWordForward)
        );
        assert_eq!(
            apple_standard_keybinding_edit_intent("deleteToBeginningOfParagraph:"),
            Some(EditIntent::DeleteHardLineBackward)
        );
        assert_eq!(
            apple_standard_keybinding_edit_intent("yank:"),
            Some(EditIntent::DeleteByCut)
        );
        assert_eq!(apple_standard_keybinding_edit_intent("moveLeft:"), None);
    }

    #[test]
    fn enter_activation_clears_line_break_intent_before_click_listeners() {
        let mut context = TestContext::new("<input id='control' type='submit'>");
        let control = context.element("control");
        assert!(context.document.set_focus_to(control));

        let keydown = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Pressed),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        let click = event(context.resume(&keydown, false));
        assert_eq!(click.event_type, "click");
        assert!(
            context
                .stack
                .frames
                .last()
                .and_then(|frame| frame.pending.as_ref())
                .is_some_and(|pending| pending.guarded.metadata.edit_intent.is_none()),
            "the keyboard click must discard Enter's line-break intent before listeners run",
        );
        context.set_input_type(control, "checkbox");
        let resumed = context.resume(&click, false);
        let generated = drain_steps(&mut context, resumed);
        assert!(
            generated
                .iter()
                .all(|step| { step.event_type != "input" || step.payload.is_none() })
        );
    }

    #[test]
    fn redraws_are_accumulated_until_completion_and_propagate_on_nested_abort() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));
        let outer = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            metadata: host_key_metadata("Escape"),
            suppress_default: false,
        }));
        context.redraw.store(true, Ordering::Relaxed);
        context.abort(inner.frame_id);
        let (_, redraw_requested) = complete(context.resume(&outer, false));
        assert!(redraw_requested);
    }

    #[test]
    fn aborted_top_level_frame_reports_redraw_and_is_idempotent() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));
        let pending = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        context.redraw.store(true, Ordering::Relaxed);
        assert!(context.abort(pending.frame_id));
        assert!(!context.abort(pending.frame_id));
        assert!(!context.redraw.load(Ordering::Relaxed));
    }

    #[test]
    fn stale_resume_and_abort_do_not_consume_unattached_redraws() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        context.redraw.store(true, Ordering::Relaxed);
        assert!(
            context
                .stack
                .resume(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                    1,
                    1,
                    false,
                )
                .is_err()
        );
        assert!(context.redraw.load(Ordering::Relaxed));
        assert!(!context.abort(1));
        assert!(context.redraw.load(Ordering::Relaxed));

        let _ = context.redraw.swap(false, Ordering::Relaxed);
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));
        let pending = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));
        context.redraw.store(true, Ordering::Relaxed);
        assert!(
            context
                .stack
                .resume(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                    pending.frame_id + 1,
                    pending.event_id,
                    false,
                )
                .is_err()
        );
        assert!(context.redraw.load(Ordering::Relaxed));
        assert!(
            context
                .stack
                .resume(
                    &mut context.document,
                    &mut context.text_controls,
                    &mut context.checked_controls,
                    &mut context.handles,
                    context.redraw.as_ref(),
                    pending.frame_id,
                    pending.event_id + 1,
                    false,
                )
                .is_err()
        );
        assert!(context.redraw.load(Ordering::Relaxed));
        assert!(!context.abort(pending.frame_id + 1));
        assert!(context.redraw.load(Ordering::Relaxed));

        let (_, redraw_requested) = complete(context.resume(&pending, false));
        assert!(redraw_requested);
        assert!(!context.redraw.load(Ordering::Relaxed));
    }

    #[test]
    fn failed_nested_begin_preserves_the_outer_listener_redraw() {
        let mut context = TestContext::new(
            "<button id='button'>go</button>\
             <div id='fresh' style='display:block;width:80px;height:40px'></div>",
        );
        let button = context.element("button");
        let fresh = context.element("fresh");
        assert!(context.document.set_focus_to(button));
        let outer = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            metadata: host_key_metadata("Enter"),
            suppress_default: false,
        }));

        let (x, y) = context.center(fresh);
        context.redraw.store(true, Ordering::Relaxed);
        context.handles.exhaust_for_test();
        let nested = context.stack.begin(
            &mut context.document,
            &mut context.text_controls,
            &mut context.checked_controls,
            &mut context.handles,
            context.redraw.as_ref(),
            DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
                flavor: PointerFlavor::Move,
                metadata: EventMetadata::native(),
            },
        );
        assert!(nested.is_err());

        let (_, redraw_requested) = complete(context.resume(&outer, false));
        assert!(redraw_requested);
    }

    #[test]
    fn failed_initial_advance_removes_the_unobservable_frame_and_restores_redraw() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:80px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        context.stack.next_event_id = None;

        let result = context.stack.begin(
            &mut context.document,
            &mut context.text_controls,
            &mut context.checked_controls,
            &mut context.handles,
            context.redraw.as_ref(),
            DispatchRequest::Pointer {
                event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
                flavor: PointerFlavor::Move,
                metadata: EventMetadata::native(),
            },
        );
        assert!(result.is_err());
        assert!(context.stack.frames.is_empty());
        assert!(context.redraw.load(Ordering::Relaxed));
    }

    #[test]
    fn preserves_the_exact_host_key_and_uses_time_origin_relative_timestamps() {
        let mut context = TestContext::new("<button id='button'>go</button>");
        let button = context.element("button");
        assert!(context.document.set_focus_to(button));
        let metadata = EventMetadata::key(
            event_time_stamp(),
            NativeKeyMetadata {
                code: "FuturePhysicalCode".to_owned(),
                key: "FutureNamedKey".to_owned(),
                keycode: 0x1234,
                modifier_bits: KEY_MOD_SHIFT
                    | KEY_MOD_CONTROL
                    | KEY_MOD_META
                    | KEY_MOD_CAPS_LOCK
                    | KEY_MOD_ALT_GRAPH
                    | KEY_MOD_FN
                    | KEY_MOD_NUM_LOCK
                    | KEY_MOD_SCROLL_LOCK,
                location: 2,
            },
        );
        let pending = event(context.begin(DispatchRequest::Key {
            event: BlitzKeyEvent {
                is_auto_repeating: true,
                is_composing: true,
                ..key(Key::Unidentified, Code::Unidentified, KeyState::Pressed)
            },
            metadata,
            suppress_default: false,
        }));
        assert!(pending.time_stamp >= 0.0);
        assert!(pending.time_stamp < 1_000_000_000.0);
        let Some(DispatchEventPayload::Keyboard(payload)) = pending.payload.as_deref() else {
            panic!("keydown should carry a keyboard payload");
        };
        assert_eq!(payload.key, "FutureNamedKey");
        assert_eq!(payload.code, "FuturePhysicalCode");
        assert_eq!(payload.key_code, 0x1234);
        assert_eq!(payload.location, 2);
        assert!(payload.repeat);
        assert!(payload.is_composing);
        assert!(payload.shift_key);
        assert!(payload.ctrl_key);
        assert!(payload.meta_key);
        assert!(payload.caps_lock);
        assert!(payload.alt_graph_key);
        assert!(payload.fn_key);
        assert!(payload.num_lock);
        assert!(payload.scroll_lock);
        assert!(!payload.alt_key);
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::float_cmp,
        reason = "the test proves that f64 host metadata remains exact beside Blitz's f32 copy"
    )]
    fn pointer_payload_keeps_native_precision_and_padding_edge_offsets() {
        let mut context = TestContext::new(
            "<button id='button' style='display:block;width:120px;height:40px;\
             border:7px solid black;padding:3px'>go</button>",
        );
        let button = context.element("button");
        let rect = context.document.get_client_bounding_rect(button).unwrap();
        let node = context.document.get_node(button).unwrap();
        let border_left = f64::from(node.final_layout.border.left);
        let border_top = f64::from(node.final_layout.border.top);
        assert_eq!((border_left, border_top), (7.0, 7.0));
        let client_x = rect.x + 10.123_456_789;
        let client_y = rect.y + 5.987_654_321;
        let metadata = EventMetadata::pointer_with_modifiers(
            321.25,
            NativePointerCoordinates {
                client_x,
                client_y,
                screen: Some((1_201.123_456_789, 902.987_654_321)),
                page_x: client_x + 2.75,
                page_y: client_y + 4.5,
                offset_x: 0.0,
                offset_y: 0.0,
            },
            3,
            POINTER_MOD_SHIFT
                | POINTER_MOD_CAPS_LOCK
                | POINTER_MOD_ALT_GRAPH
                | POINTER_MOD_FN
                | POINTER_MOD_NUM_LOCK
                | POINTER_MOD_SCROLL_LOCK,
        );
        let mut pointer = pointer(
            client_x as f32,
            client_y as f32,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
        );
        pointer.mods = Modifiers::SHIFT | Modifiers::CONTROL | Modifiers::ALT | Modifiers::META;
        let staged = stage_generated_with_metadata(
            &mut context,
            button,
            DomEventData::PointerDown(pointer),
            metadata,
        );

        assert_eq!(staged.time_stamp, 321.25);
        let Some(DispatchEventPayload::Pointer(payload)) = staged.payload.as_deref() else {
            panic!("pointerdown should carry a pointer payload");
        };
        assert_eq!(payload.mouse.client_x, client_x);
        assert_eq!(payload.mouse.client_y, client_y);
        assert_eq!(payload.mouse.screen_x, 1_201.123_456_789);
        assert_eq!(payload.mouse.screen_y, 902.987_654_321);
        assert_eq!(payload.mouse.page_x, client_x + 2.75);
        assert_eq!(payload.mouse.page_y, client_y + 4.5);
        assert_eq!(payload.mouse.offset_x, client_x - rect.x - border_left);
        assert_eq!(payload.mouse.offset_y, client_y - rect.y - border_top);
        assert_eq!(payload.mouse.button, 0);
        assert_eq!(payload.mouse.buttons, 1);
        assert_eq!(payload.mouse.detail, 0);
        assert!(payload.mouse.shift_key);
        assert!(!payload.mouse.ctrl_key);
        assert!(!payload.mouse.alt_key);
        assert!(!payload.mouse.meta_key);
        assert!(payload.mouse.caps_lock);
        assert!(payload.mouse.alt_graph_key);
        assert!(payload.mouse.fn_key);
        assert!(payload.mouse.num_lock);
        assert!(payload.mouse.scroll_lock);
        assert_eq!(payload.pointer_id, 1.0);
        assert_eq!(payload.pointer_type, "mouse");
        assert_eq!(payload.width, 1.0);
        assert_eq!(payload.height, 1.0);
        assert_eq!(payload.pressure, 0.5);
        assert_eq!(payload.altitude_angle, std::f64::consts::FRAC_PI_2);
    }

    #[test]
    fn pointer_payload_falls_back_only_without_an_exact_modifier_snapshot() {
        let coords = NativePointerCoordinates {
            client_x: 1.0,
            client_y: 2.0,
            screen: None,
            page_x: 1.0,
            page_y: 2.0,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let blitz = Modifiers::SHIFT | Modifiers::CAPS_LOCK | Modifiers::FN;
        let fallback = mouse_payload_from_parts(coords, (0.0, 0.0), 0, 0, 0, blitz, None, None);
        assert!(fallback.shift_key);
        assert!(fallback.caps_lock);
        assert!(fallback.fn_key);

        let exact_zero =
            mouse_payload_from_parts(coords, (0.0, 0.0), 0, 0, 0, blitz, Some(0), None);
        assert!(!exact_zero.shift_key);
        assert!(!exact_zero.caps_lock);
        assert!(!exact_zero.fn_key);

        let wheel = BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(0.0, 0.0),
            coords: PointerCoords {
                page_x: 1.0,
                page_y: 2.0,
                screen_x: 0.0,
                screen_y: 0.0,
                client_x: 1.0,
                client_y: 2.0,
            },
            buttons: MouseEventButtons::None,
            mods: blitz,
        };
        let wheel_fallback =
            wheel_mouse_payload(&wheel, &EventMetadata::wheel(0.0, coords, 0.0, 0.0, 0));
        assert!(wheel_fallback.shift_key);
        assert!(wheel_fallback.caps_lock);
        assert!(wheel_fallback.fn_key);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the native f64 screen coordinates must survive every generated event exactly"
    )]
    fn pointer_screen_coordinates_flow_through_boundaries_mouse_events_and_clicks() {
        let mut context = TestContext::new(
            "<button id='target' style='display:block;width:120px;height:40px'>go</button>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        let payload_screen = |step: &DispatchEventStep| match step.payload.as_deref() {
            Some(DispatchEventPayload::Pointer(payload)) => {
                Some((payload.mouse.screen_x, payload.mouse.screen_y))
            }
            Some(DispatchEventPayload::Mouse(payload)) => {
                Some((payload.screen_x, payload.screen_y))
            }
            _ => None,
        };

        let entered = context.begin(pointer_request_with_screen_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
            1.0,
            0,
            Some((1001.125, 702.875)),
        ));
        let entered = drain_steps(&mut context, entered);
        assert!(entered.iter().any(|step| step.event_type == "pointerover"));
        assert!(entered.iter().any(|step| step.event_type == "mouseenter"));
        for step in &entered {
            if let Some(screen) = payload_screen(step) {
                assert_eq!(screen, (1001.125, 702.875));
            }
        }

        let down = context.begin(pointer_request_with_screen_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            2.0,
            1,
            Some((1002.25, 704.5)),
        ));
        let _ = drain(&mut context, down);
        let up = context.begin(pointer_request_with_screen_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
            3.0,
            1,
            Some((1003.5, 706.75)),
        ));
        let released = drain_steps(&mut context, up);
        assert!(released.iter().any(|step| step.event_type == "click"));
        for step in &released {
            if let Some(screen) = payload_screen(step) {
                assert_eq!(screen, (1003.5, 706.75));
            }
        }

        let unavailable = context.begin(pointer_request_with_screen_at(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
            4.0,
            0,
            None,
        ));
        for step in drain_steps(&mut context, unavailable) {
            if let Some(screen) = payload_screen(&step) {
                assert_eq!(screen, (0.0, 0.0));
            }
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the test proves that native f64 movement deltas are shared without narrowing"
    )]
    fn mouse_moves_share_screen_deltas_while_other_mouse_events_stay_zero() {
        let mut context = TestContext::new(
            "<div id='a' style='display:inline-block;width:100px;height:40px'></div>\
             <div id='b' style='display:inline-block;width:100px;height:40px'></div>",
        );
        let a = context.element("a");
        let b = context.element("b");
        let (ax, ay) = context.center(a);
        let (bx, by) = context.center(b);
        let movement = |step: &DispatchEventStep| match step.payload.as_deref() {
            Some(DispatchEventPayload::Pointer(payload)) => {
                Some((payload.mouse.movement_x, payload.mouse.movement_y))
            }
            Some(DispatchEventPayload::Mouse(payload)) => {
                Some((payload.movement_x, payload.movement_y))
            }
            _ => None,
        };

        let first = context.begin(pointer_request_with_screen_at(
            ax,
            ay,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
            1.0,
            0,
            Some((1_000.125, 700.875)),
        ));
        let first = drain_steps(&mut context, first);
        assert!(first.iter().any(|step| step.event_type == "pointermove"));
        assert!(first.iter().any(|step| step.event_type == "mousemove"));
        assert!(
            first
                .iter()
                .filter_map(&movement)
                .all(|delta| delta == (0.0, 0.0))
        );

        let second = context.begin(pointer_request_with_screen_at(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Move,
            2.0,
            0,
            Some((1_002.375, 697.125)),
        ));
        let second = drain_steps(&mut context, second);
        for step in &second {
            let Some(delta) = movement(step) else {
                continue;
            };
            if matches!(step.event_type.as_str(), "pointermove" | "mousemove") {
                assert_eq!(delta, (2.25, -3.75));
            } else {
                assert_eq!(delta, (0.0, 0.0));
            }
        }

        // Button and click-family occurrences do not update the last mouse-move position.
        let down = context.begin(pointer_request_with_screen_at(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
            3.0,
            1,
            Some((9_000.0, 8_000.0)),
        ));
        for step in drain_steps(&mut context, down) {
            assert_eq!(movement(&step), Some((0.0, 0.0)));
        }
        let third = context.begin(pointer_request_with_screen_at(
            bx,
            by,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Move,
            4.0,
            0,
            Some((1_003.625, 699.5)),
        ));
        for step in drain_steps(&mut context, third) {
            if matches!(step.event_type.as_str(), "pointermove" | "mousemove") {
                assert_eq!(movement(&step), Some((1.25, 2.375)));
            }
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the client-coordinate fallback must retain exact host f64 values"
    )]
    fn mouse_movement_falls_back_to_client_coordinates_without_screen_coordinates() {
        let coords = |client_x, client_y| NativePointerCoordinates {
            client_x,
            client_y,
            screen: None,
            page_x: client_x,
            page_y: client_y,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let mut last = None;
        assert_eq!(
            mouse_movement(&mut last, coords(11.123_456_789, 12.987_654_321)),
            (0.0, 0.0)
        );
        assert_eq!(
            mouse_movement(&mut last, coords(13.373_456_789, 9.237_654_321)),
            (2.25, -3.75)
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the Pointer Events click-family defaults and retained pointer id are exact constants"
    )]
    fn click_family_pointer_specific_fields_use_defaults() {
        let mut pointer = pointer(
            1.0,
            2.0,
            MouseEventButton::Auxiliary,
            MouseEventButtons::Primary,
        );
        pointer.id = BlitzPointerId::Pen;
        pointer.is_primary = true;
        pointer.details = PointerDetails {
            pressure: 0.75,
            tangential_pressure: 0.25,
            tilt_x: 30,
            tilt_y: -20,
            twist: 123,
            altitude: 0.75,
            azimuth: 1.25,
        };
        let metadata =
            EventMetadata::pointer(1.0, native_pointer_coordinates(1.0, 2.0, None, 0.0, 0.0), 2);

        for data in [
            DomEventData::Click(pointer.clone()),
            DomEventData::ContextMenu(pointer.clone()),
        ] {
            let Some(DispatchEventPayload::Pointer(payload)) = event_payload(&data, &metadata)
            else {
                panic!("click-family events should carry pointer payloads");
            };
            assert_eq!(payload.pointer_id, 2.0);
            assert_eq!(payload.pointer_type, "pen");
            assert!(!payload.is_primary);
            assert_eq!(payload.width, 1.0);
            assert_eq!(payload.height, 1.0);
            assert_eq!(payload.pressure, 0.0);
            assert_eq!(payload.tangential_pressure, 0.0);
            assert_eq!(payload.tilt_x, 0);
            assert_eq!(payload.tilt_y, 0);
            assert_eq!(payload.twist, 0);
            assert_eq!(payload.altitude_angle, std::f64::consts::FRAC_PI_2);
            assert_eq!(payload.azimuth_angle, 0.0);
            assert_eq!(payload.persistent_device_id, 0);
            assert_eq!(payload.mouse.buttons, 1);
        }
    }

    #[test]
    fn pointer_transitions_zero_detail_but_mouse_and_click_events_keep_the_count() {
        let pointer = pointer(1.0, 2.0, MouseEventButton::Main, MouseEventButtons::Primary);
        let metadata =
            EventMetadata::pointer(1.0, native_pointer_coordinates(1.0, 2.0, None, 0.0, 0.0), 4);
        let detail = |data| match event_payload(&data, &metadata).unwrap() {
            DispatchEventPayload::Pointer(payload) => payload.mouse.detail,
            DispatchEventPayload::Mouse(payload) => payload.detail,
            _ => panic!("test event should carry mouse fields"),
        };

        assert_eq!(detail(DomEventData::PointerDown(pointer.clone())), 0);
        assert_eq!(detail(DomEventData::PointerUp(pointer.clone())), 0);
        assert_eq!(detail(DomEventData::MouseDown(pointer.clone())), 4);
        assert_eq!(detail(DomEventData::MouseUp(pointer.clone())), 4);
        assert_eq!(detail(DomEventData::Click(pointer.clone())), 4);
        assert_eq!(detail(DomEventData::DoubleClick(pointer.clone())), 4);
        assert_eq!(detail(DomEventData::ContextMenu(pointer)), 0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the raw wheel values are copied exactly rather than recalculated"
    )]
    fn wheel_payload_keeps_raw_units_separate_from_blitz_defaults() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:120px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        let metadata = EventMetadata::wheel_with_modifiers(
            91.5,
            NativePointerCoordinates {
                client_x: f64::from(x),
                client_y: f64::from(y),
                screen: Some((401.25, 302.5)),
                page_x: f64::from(x) + 10.0,
                page_y: f64::from(y) + 20.0,
                offset_x: 0.0,
                offset_y: 0.0,
            },
            1.25,
            -2.5,
            1,
            POINTER_MOD_CAPS_LOCK
                | POINTER_MOD_ALT_GRAPH
                | POINTER_MOD_FN
                | POINTER_MOD_NUM_LOCK
                | POINTER_MOD_SCROLL_LOCK,
        );
        let staged = stage_generated_with_metadata(
            &mut context,
            target,
            DomEventData::Wheel(BlitzWheelEvent {
                delta: BlitzWheelDelta::Lines(-1.25, 2.5),
                coords: PointerCoords {
                    page_x: x + 10.0,
                    page_y: y + 20.0,
                    screen_x: 0.0,
                    screen_y: 0.0,
                    client_x: x,
                    client_y: y,
                },
                buttons: MouseEventButtons::None,
                mods: Modifiers::META,
            }),
            metadata,
        );

        let Some(DispatchEventPayload::Wheel(payload)) = staged.payload.as_deref() else {
            panic!("wheel should carry a wheel payload");
        };
        assert_eq!((payload.delta_x, payload.delta_y), (1.25, -2.5));
        assert_eq!(payload.delta_mode, 1);
        assert_eq!(payload.delta_z, 0.0);
        assert_eq!(
            (payload.mouse.screen_x, payload.mouse.screen_y),
            (401.25, 302.5)
        );
        assert!(!payload.mouse.meta_key);
        assert!(payload.mouse.caps_lock);
        assert!(payload.mouse.alt_graph_key);
        assert!(payload.mouse.fn_key);
        assert!(payload.mouse.num_lock);
        assert!(payload.mouse.scroll_lock);
        let pending = context
            .stack
            .frames
            .last()
            .unwrap()
            .pending
            .as_ref()
            .unwrap();
        assert!(matches!(
            pending.guarded.event.data,
            DomEventData::Wheel(BlitzWheelEvent {
                delta: BlitzWheelDelta::Lines(-1.25, 2.5),
                ..
            })
        ));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "every generated record must retain the exact causal native timestamp"
    )]
    fn generated_events_keep_causal_time_detail_and_focus_relationships() {
        let mut context = TestContext::new(
            "<input id='old'><input id='box' type='checkbox' style='width:24px;height:24px'>",
        );
        let old = context.element("old");
        let checkbox = context.element("box");
        assert!(context.document.set_focus_to(old));
        let old_handle = context.handles.expose(old).unwrap();
        let checkbox_handle = context.handles.expose(checkbox).unwrap();
        let (x, y) = context.center(checkbox);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::pointer(
                776.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                2,
            ),
        });
        assert_focus_transition_metadata(&mut context, down, 776.0, old_handle, checkbox_handle);
        let metadata = EventMetadata::pointer(
            777.0,
            native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
            2,
        );
        let mut step = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata,
        });
        let mut saw_click = false;
        let mut saw_pointer_up = false;
        let mut saw_mouse_up = false;
        let mut saw_input = false;
        let mut activation_events = Vec::new();
        while let DispatchStep::Event(current) = step {
            assert_eq!(current.time_stamp, 777.0);
            match current.event_type.as_str() {
                "pointerup" => {
                    saw_pointer_up = true;
                    let Some(DispatchEventPayload::Pointer(payload)) = current.payload.as_deref()
                    else {
                        panic!("pointerup should carry a pointer payload");
                    };
                    assert_eq!(payload.mouse.detail, 0);
                }
                "mouseup" => {
                    saw_mouse_up = true;
                    let Some(DispatchEventPayload::Mouse(payload)) = current.payload.as_deref()
                    else {
                        panic!("mouseup should carry a mouse payload");
                    };
                    assert_eq!(payload.detail, 2);
                }
                "click" => {
                    saw_click = true;
                    let Some(DispatchEventPayload::Pointer(payload)) = current.payload.as_deref()
                    else {
                        panic!("click should carry the causal pointer payload");
                    };
                    assert_eq!(payload.mouse.detail, 1);
                }
                "input" => {
                    saw_input = true;
                    activation_events.push("input");
                    assert!(
                        context
                            .checked_controls
                            .checked(&mut context.document, checkbox)
                            .unwrap(),
                        "live checkedness must be synchronized before input is staged",
                    );
                    assert_eq!(current.payload, None);
                    assert!(current.bubbles);
                    assert!(!current.cancelable);
                    assert!(current.composed);
                }
                "change" => {
                    activation_events.push("change");
                    assert!(current.bubbles);
                    assert!(!current.cancelable);
                    assert!(!current.composed);
                    assert_eq!(current.payload, None);
                }
                _ => {}
            }
            step = context.resume(&current, false);
        }
        assert!(saw_pointer_up && saw_mouse_up && saw_click && saw_input);
        assert_eq!(activation_events, ["input", "change"]);
    }

    #[test]
    fn already_focused_checkable_activation_reports_redraw_on_completion() {
        for (input_type, extra_attribute) in [("checkbox", ""), ("radio", " name='group'")] {
            let mut context = TestContext::new(&format!(
                "<input id='control' type='{input_type}'{extra_attribute} \
                 style='display:block;width:24px;height:24px'>"
            ));
            let control = context.element("control");
            assert!(context.document.set_focus_to(control));
            let _ = context.redraw.swap(false, Ordering::Relaxed);
            let (x, y) = context.center(control);
            let click = stage_generated_with_metadata(
                &mut context,
                control,
                DomEventData::Click(pointer(
                    x,
                    y,
                    MouseEventButton::Main,
                    MouseEventButtons::None,
                )),
                EventMetadata::pointer(
                    12.0,
                    native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                    1,
                ),
            );

            let step = context.resume(&click, false);
            let (types, _, redraw_requested) = drain(&mut context, step);
            assert!(types.iter().any(|event_type| event_type == "input"));
            assert!(
                redraw_requested,
                "{input_type} checkedness changed without a focus edge must still repaint",
            );
        }
    }

    #[test]
    fn already_checked_radio_emits_no_input_or_change() {
        let mut context = TestContext::new("<input id='target' type='radio' name='group' checked>");
        let target = context.element("target");
        let click = stage_generated_with_metadata(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                91.0,
                native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                1,
            ),
        );

        let step = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, step);
        assert!(
            !types
                .iter()
                .any(|event_type| matches!(event_type.as_str(), "input" | "change"))
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn canceled_checkable_click_emits_no_input_or_change() {
        let mut context = TestContext::new("<input id='target' type='checkbox'>");
        let target = context.element("target");
        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );

        let step = context.resume(&click, true);
        let (types, _, _) = drain(&mut context, step);
        assert!(
            !types
                .iter()
                .any(|event_type| matches!(event_type.as_str(), "input" | "change"))
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn checkbox_listener_restoring_checkedness_suppresses_activation_events() {
        let mut context = TestContext::new("<input id='box' type='checkbox'>");
        let checkbox = context.element("box");
        context
            .checked_controls
            .set_indeterminate(&mut context.document, checkbox, true)
            .unwrap();

        let click = stage_generated(
            &mut context,
            checkbox,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap(),
            "click listeners must observe legacy pre-click checkedness",
        );
        assert!(
            !context
                .checked_controls
                .indeterminate(&mut context.document, checkbox)
                .unwrap(),
            "checkbox pre-click activation clears indeterminate",
        );

        // Model writes made by the click listener. Pinned Blitz will toggle its render facade
        // again while running the default, but that must not overwrite these script-owned values.
        context
            .checked_controls
            .set_checked(&mut context.document, checkbox, false)
            .unwrap();
        context
            .checked_controls
            .set_indeterminate(&mut context.document, checkbox, true)
            .unwrap();
        let step = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, step);
        assert!(
            !types
                .iter()
                .any(|event_type| matches!(event_type.as_str(), "input" | "change"))
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );
        assert!(
            context
                .checked_controls
                .indeterminate(&mut context.document, checkbox)
                .unwrap()
        );
    }

    #[test]
    fn canceled_checkbox_click_restores_pre_activation_values_but_stays_dirty() {
        let mut context = TestContext::new("<input id='box' type='checkbox'>");
        let checkbox = context.element("box");
        context
            .checked_controls
            .set_indeterminate(&mut context.document, checkbox, true)
            .unwrap();
        let click = stage_generated(
            &mut context,
            checkbox,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );

        let (_, redraw_requested) = complete(context.resume(&click, true));
        assert!(redraw_requested);
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );
        assert!(
            context
                .checked_controls
                .indeterminate(&mut context.document, checkbox)
                .unwrap()
        );

        context.document.mutate().set_attribute(
            checkbox,
            QualName {
                prefix: None,
                ns: ns!(),
                local: LocalName::from("checked"),
            },
            "",
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap(),
            "rollback restores checkedness without resetting its dirty flag",
        );
    }

    #[test]
    fn canceled_radio_click_restores_only_a_live_prior_member_in_the_current_group() {
        let mut context = TestContext::new(
            "<input id='before' type='radio' name='group' checked>\
             <input id='target' type='radio' name='group'>",
        );
        let before = context.element("before");
        let target = context.element("target");
        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, before)
                .unwrap()
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
        complete(context.resume(&click, true));
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, before)
                .unwrap()
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );

        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        context.document.mutate().set_attribute(
            target,
            QualName {
                prefix: None,
                ns: ns!(),
                local: LocalName::from("name"),
            },
            "other-group",
        );
        complete(context.resume(&click, true));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, before)
                .unwrap(),
            "a prior member from the old group must not be restored",
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn canceled_radio_click_does_not_restore_a_stale_prior_handle() {
        let mut context = TestContext::new(
            "<input id='before' type='radio' name='group' checked>\
             <input id='target' type='radio' name='group'>",
        );
        let before = context.element("before");
        let target = context.element("target");
        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        let stale = context
            .handles
            .invalidate_node(before)
            .expect("the previous radio was guarded before pre-activation");
        let replacement = context.handles.expose(before).unwrap();
        assert_ne!(replacement, stale);

        complete(context.resume(&click, true));
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, before)
                .unwrap()
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn canceled_checkable_click_uses_the_targets_current_type() {
        let mut checkbox_to_radio = TestContext::new("<input id='target' type='checkbox'>");
        let target = checkbox_to_radio.element("target");
        checkbox_to_radio
            .checked_controls
            .set_indeterminate(&mut checkbox_to_radio.document, target, true)
            .unwrap();
        let click = stage_generated(
            &mut checkbox_to_radio,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        checkbox_to_radio.set_input_type(target, "radio");
        complete(checkbox_to_radio.resume(&click, true));
        assert!(
            !checkbox_to_radio
                .checked_controls
                .checked(&mut checkbox_to_radio.document, target)
                .unwrap()
        );
        assert!(
            !checkbox_to_radio
                .checked_controls
                .indeterminate(&mut checkbox_to_radio.document, target)
                .unwrap(),
            "the current radio branch must not restore the checkbox's indeterminate flag",
        );

        let mut radio_to_checkbox = TestContext::new(
            "<input id='before' type='radio' name='group' checked>\
             <input id='target' type='radio' name='group'>",
        );
        let before = radio_to_checkbox.element("before");
        let target = radio_to_checkbox.element("target");
        radio_to_checkbox
            .checked_controls
            .set_indeterminate(&mut radio_to_checkbox.document, target, true)
            .unwrap();
        let click = stage_generated(
            &mut radio_to_checkbox,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        radio_to_checkbox.set_input_type(target, "checkbox");
        radio_to_checkbox
            .checked_controls
            .set_indeterminate(&mut radio_to_checkbox.document, target, false)
            .unwrap();
        complete(radio_to_checkbox.resume(&click, true));
        assert!(
            !radio_to_checkbox
                .checked_controls
                .checked(&mut radio_to_checkbox.document, target)
                .unwrap()
        );
        assert!(
            radio_to_checkbox
                .checked_controls
                .indeterminate(&mut radio_to_checkbox.document, target)
                .unwrap(),
            "the current checkbox branch restores values captured before radio activation",
        );
        assert!(
            !radio_to_checkbox
                .checked_controls
                .checked(&mut radio_to_checkbox.document, before)
                .unwrap(),
            "switching to checkbox does not run radio-group rollback",
        );
    }

    #[test]
    fn abort_rolls_back_nested_checkable_pre_activation_in_lifo_order() {
        let mut context = TestContext::new("<input id='box' type='checkbox'>");
        let checkbox = context.element("box");
        let outer = stage_generated(
            &mut context,
            checkbox,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );
        let _inner = stage_generated(
            &mut context,
            checkbox,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap()
        );

        assert!(context.abort(outer.frame_id));
        assert!(context.stack.frames.is_empty());
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, checkbox)
                .unwrap(),
            "inner rollback must run before outer rollback",
        );
    }

    #[test]
    fn canceled_click_uses_a_noncheckable_inputs_snapshot_after_type_changes() {
        let mut checkbox = TestContext::new("<input id='target' type='text' checked>");
        let target = checkbox.element("target");
        checkbox
            .checked_controls
            .set_indeterminate(&mut checkbox.document, target, true)
            .unwrap();
        let click = stage_generated(
            &mut checkbox,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        checkbox.set_input_type(target, "checkbox");
        checkbox
            .checked_controls
            .set_checked(&mut checkbox.document, target, false)
            .unwrap();
        checkbox
            .checked_controls
            .set_indeterminate(&mut checkbox.document, target, false)
            .unwrap();
        complete(checkbox.resume(&click, true));
        assert!(
            checkbox
                .checked_controls
                .checked(&mut checkbox.document, target)
                .unwrap(),
            "the current checkbox branch restores the latent pre-click checkedness",
        );
        assert!(
            checkbox
                .checked_controls
                .indeterminate(&mut checkbox.document, target)
                .unwrap(),
        );

        let mut radio = TestContext::new("<input id='target' type='text' checked>");
        let target = radio.element("target");
        let click = stage_generated(
            &mut radio,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        radio.set_input_type(target, "radio");
        complete(radio.resume(&click, true));
        assert!(
            !radio
                .checked_controls
                .checked(&mut radio.document, target)
                .unwrap(),
            "an input which was not initially a radio has no prior group member to restore",
        );
    }

    #[test]
    fn uncanceled_noncheckable_to_checkable_listener_writes_survive_without_activation_events() {
        for input_type in ["checkbox", "radio"] {
            let mut context = TestContext::new("<input id='target' type='text'>");
            let target = context.element("target");
            let click = stage_generated(
                &mut context,
                target,
                DomEventData::Click(pointer(
                    1.0,
                    1.0,
                    MouseEventButton::Main,
                    MouseEventButtons::None,
                )),
            );
            context.set_input_type(target, input_type);
            context
                .checked_controls
                .set_checked(&mut context.document, target, false)
                .unwrap();
            context
                .checked_controls
                .set_indeterminate(&mut context.document, target, true)
                .unwrap();

            let step = context.resume(&click, false);
            let (types, _, _) = drain(&mut context, step);
            assert!(
                !types
                    .iter()
                    .any(|event_type| matches!(event_type.as_str(), "input" | "change"))
            );
            assert!(
                !context
                    .checked_controls
                    .checked(&mut context.document, target)
                    .unwrap(),
                "pinned Blitz must not import a second {input_type} activation",
            );
            assert!(
                context
                    .checked_controls
                    .indeterminate(&mut context.document, target)
                    .unwrap(),
            );
            assert_eq!(
                context
                    .document
                    .get_node(target)
                    .and_then(blitz_dom::Node::element_data)
                    .and_then(|element| element.attr(local_name!("name"))),
                None,
            );
        }
    }

    #[test]
    fn uncanceled_unnamed_radio_uses_and_removes_a_private_blitz_group() {
        let mut context = TestContext::new("<input id='target' type='radio'>");
        let target = context.element("target");
        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );

        let step = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, step);
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
        assert_eq!(
            context
                .document
                .get_node(target)
                .and_then(blitz_dom::Node::element_data)
                .and_then(|element| element.attr(local_name!("name"))),
            None,
            "the private Blitz group must not become an author-visible name attribute",
        );
    }

    #[test]
    fn trusted_pointer_click_is_not_dispatched_to_an_actually_disabled_checkbox() {
        for body in [
            "<input id='target' type='checkbox' disabled style='width:24px;height:24px'>",
            "<fieldset disabled><input id='target' type='checkbox' \
             style='width:24px;height:24px'></fieldset>",
        ] {
            let mut context = TestContext::new(body);
            let target = context.element("target");
            context
                .checked_controls
                .set_indeterminate(&mut context.document, target, true)
                .unwrap();
            let (x, y) = context.center(target);
            assert!(context.document.set_hover_to(x, y));

            let down = context.begin_trusted_pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::Primary,
                PointerFlavor::Down,
            );
            let (down_types, _, _) = drain(&mut context, down);
            assert!(
                down_types
                    .iter()
                    .any(|event_type| event_type == "pointerdown")
            );
            assert!(
                down_types
                    .iter()
                    .any(|event_type| event_type == "mousedown")
            );
            let up = context.begin_trusted_pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::None,
                PointerFlavor::Up,
            );
            let (types, _, _) = drain(&mut context, up);
            assert!(types.iter().any(|event_type| event_type == "pointerup"));
            assert!(types.iter().any(|event_type| event_type == "mouseup"));
            assert!(!types.iter().any(|event_type| event_type == "click"));
            assert!(!types.iter().any(|event_type| event_type == "input"));
            assert!(context.stack.click_sequence.is_none());
            assert!(
                !context
                    .checked_controls
                    .checked(&mut context.document, target)
                    .unwrap()
            );
            assert!(
                context
                    .checked_controls
                    .indeterminate(&mut context.document, target)
                    .unwrap()
            );
        }
    }

    #[test]
    fn mouseup_listener_disabling_the_target_suppresses_its_pending_trusted_click() {
        let mut context =
            TestContext::new("<input id='target' type='checkbox' style='width:24px;height:24px'>");
        let target = context.element("target");
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, down);
        let up = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
        );
        let mouse_up = next_event_of_type(&mut context, up, "mouseup");

        set_disabled(&mut context, target, true);
        let remainder = context.resume(&mouse_up, false);
        let (types, _, _) = drain(&mut context, remainder);
        assert!(!types.iter().any(|event_type| event_type == "click"));
        assert!(!types.iter().any(|event_type| event_type == "input"));
        assert!(context.stack.click_sequence.is_none());
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn mouseup_listener_enabling_the_target_allows_its_pending_trusted_click() {
        let mut context = TestContext::new(
            "<input id='target' type='checkbox' disabled style='width:24px;height:24px'>",
        );
        let target = context.element("target");
        let target_handle = context.handles.expose(target).unwrap();
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let down = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
            PointerFlavor::Down,
        );
        let _ = drain(&mut context, down);
        let up = context.begin_trusted_pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
            PointerFlavor::Up,
        );
        let mouse_up = next_event_of_type(&mut context, up, "mouseup");

        set_disabled(&mut context, target, false);
        let after_mouse_up = context.resume(&mouse_up, false);
        let click = next_event_of_type(&mut context, after_mouse_up, "click");
        assert_eq!(click.target, target_handle);
        let after_click = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, after_click);
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert!(
            context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
    }

    #[test]
    fn nonpointer_disabled_click_does_not_run_checkable_activation() {
        let mut context = TestContext::new("<input id='target' type='checkbox' disabled>");
        let target = context.element("target");
        let click = stage_generated(
            &mut context,
            target,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
        );
        assert!(
            !context
                .checked_controls
                .checked(&mut context.document, target)
                .unwrap()
        );
        let step = context.resume(&click, false);
        let (types, _, _) = drain(&mut context, step);
        assert!(
            !types
                .iter()
                .any(|event_type| matches!(event_type.as_str(), "input" | "change"))
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "generated file events must retain the causal click's exact timestamp"
    )]
    fn file_activation_preserves_author_value_attributes_and_hides_host_paths() {
        struct SelectingShell;

        impl ShellProvider for SelectingShell {
            fn open_file_dialog(
                &self,
                _multiple: bool,
                _filter: Option<blitz_traits::shell::FileDialogFilter>,
            ) -> Vec<std::path::PathBuf> {
                vec![std::path::PathBuf::from(r"C:\Users\Alice\selected.txt")]
            }
        }

        for authored_value in [None, Some("author default")] {
            let value_attribute = authored_value
                .map(|value| format!(" value='{value}'"))
                .unwrap_or_default();
            let mut context = TestContext::with_shell(
                &format!(
                    "<input id='file' type='file'{value_attribute} \
                     style='display:block;width:160px;height:24px'>"
                ),
                Arc::new(SelectingShell),
            );
            let file = context.element("file");
            let (x, y) = context.center(file);
            let click = stage_generated_with_metadata(
                &mut context,
                file,
                DomEventData::Click(pointer(
                    x,
                    y,
                    MouseEventButton::Main,
                    MouseEventButtons::None,
                )),
                EventMetadata::pointer(
                    10.0,
                    native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                    1,
                ),
            );

            let after_click = context.resume(&click, false);
            let input = event(after_click);
            assert_eq!(input.event_type, "input");
            assert_eq!(input.time_stamp, 10.0);
            assert_eq!(context.handles.resolve(input.target), Some(file));
            assert!(input.bubbles);
            assert!(!input.cancelable);
            assert!(input.composed);
            assert_eq!(input.payload, None);
            assert_eq!(
                context
                    .text_controls
                    .value(&mut context.document, file)
                    .as_deref(),
                Some(r"C:\fakepath\selected.txt"),
                "the live value must update before input listeners run",
            );
            let change = event(context.resume(&input, true));
            assert_eq!(change.event_type, "change");
            assert_eq!(change.time_stamp, 10.0);
            assert_eq!(context.handles.resolve(change.target), Some(file));
            assert!(change.bubbles);
            assert!(!change.cancelable);
            assert!(!change.composed);
            assert_eq!(change.payload, None);
            complete(context.resume(&change, true));
            assert_eq!(
                context
                    .document
                    .get_node(file)
                    .and_then(blitz_dom::Node::element_data)
                    .and_then(|element| element.attr(LocalName::from("value"))),
                authored_value,
                "native selection must not replace the author content attribute",
            );
            assert_eq!(
                context
                    .text_controls
                    .value(&mut context.document, file)
                    .as_deref(),
                Some(r"C:\fakepath\selected.txt"),
            );
            let rendered_text = context.document.get_node(file).unwrap().text_content();
            assert!(rendered_text.contains("selected.txt"));
            assert!(!rendered_text.contains("Users"));
            assert!(!rendered_text.contains("Alice"));
            assert!(!rendered_text.contains(r"C:\"));
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "each generated pair must retain its causal click's exact timestamp"
    )]
    fn file_reselection_compares_raw_ordered_paths_and_empty_results_cancel() {
        use std::collections::VecDeque;
        use std::sync::Mutex;

        struct SequencedFileShell {
            selections: Mutex<VecDeque<Vec<std::path::PathBuf>>>,
        }

        impl ShellProvider for SequencedFileShell {
            fn open_file_dialog(
                &self,
                _multiple: bool,
                _filter: Option<blitz_traits::shell::FileDialogFilter>,
            ) -> Vec<std::path::PathBuf> {
                self.selections
                    .lock()
                    .expect("test file selection lock should not be poisoned")
                    .pop_front()
                    .expect("every test click should have a dialog result")
            }
        }

        let first = vec![
            std::path::PathBuf::from("/first/shared.txt"),
            std::path::PathBuf::from("/first/other.txt"),
        ];
        let reordered = vec![first[1].clone(), first[0].clone()];
        let same_names_different_directory = vec![
            std::path::PathBuf::from("/second/other.txt"),
            std::path::PathBuf::from("/first/shared.txt"),
        ];
        let shell = Arc::new(SequencedFileShell {
            selections: Mutex::new(VecDeque::from([
                first.clone(),
                first.clone(),
                reordered.clone(),
                same_names_different_directory.clone(),
                Vec::new(),
            ])),
        });
        let mut context = TestContext::with_shell(
            "<input id='file' type='file' multiple style='display:block;width:160px;height:24px'>",
            shell,
        );
        let file = context.element("file");

        for (time_stamp, expected, emits) in [
            (10.0, &first, true),
            (20.0, &first, false),
            (30.0, &reordered, true),
            (40.0, &same_names_different_directory, true),
            // The empty shell result is cancellation, so the previous raw selection survives.
            (50.0, &same_names_different_directory, false),
        ] {
            let click = stage_generated_with_metadata(
                &mut context,
                file,
                DomEventData::Click(pointer(
                    1.0,
                    1.0,
                    MouseEventButton::Main,
                    MouseEventButtons::None,
                )),
                EventMetadata::pointer(
                    time_stamp,
                    native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                    1,
                ),
            );
            let after_click = context.resume(&click, false);
            let events = drain_steps(&mut context, after_click);
            assert_eq!(
                events
                    .iter()
                    .map(|event| event.event_type.as_str())
                    .collect::<Vec<_>>(),
                if emits {
                    vec!["input", "change"]
                } else {
                    Vec::new()
                },
            );
            assert!(events.iter().all(|event| event.time_stamp == time_stamp));
            let selection = context
                .document
                .get_node(file)
                .and_then(blitz_dom::Node::element_data)
                .and_then(blitz_dom::ElementData::file_data)
                .map_or_else(Vec::new, |files| files.iter().cloned().collect::<Vec<_>>());
            assert_eq!(&selection, expected);
        }

        assert_eq!(
            context
                .text_controls
                .value(&mut context.document, file)
                .as_deref(),
            Some(r"C:\fakepath\other.txt"),
        );
        let rendered_text = context.document.get_node(file).unwrap().text_content();
        assert!(rendered_text.contains("2 Files Selected"));
        assert!(!rendered_text.contains("second"));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "label-generated file events must retain the label click's exact timestamp"
    )]
    fn file_picker_respects_click_cancellation_disabled_labels_and_label_activation() {
        use std::sync::atomic::AtomicUsize;

        struct CountingFileShell {
            calls: AtomicUsize,
        }

        impl ShellProvider for CountingFileShell {
            fn open_file_dialog(
                &self,
                _multiple: bool,
                _filter: Option<blitz_traits::shell::FileDialogFilter>,
            ) -> Vec<std::path::PathBuf> {
                self.calls.fetch_add(1, Ordering::Relaxed);
                vec![std::path::PathBuf::from("/selected/from-label.txt")]
            }
        }

        let shell = Arc::new(CountingFileShell {
            calls: AtomicUsize::new(0),
        });
        let mut context = TestContext::with_shell(
            "<input id='file' type='file'><label id='label' for='file'>Choose</label>",
            shell.clone(),
        );
        let file = context.element("file");
        let label = context.element("label");

        let canceled = stage_generated_with_metadata(
            &mut context,
            file,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                1,
            ),
        );
        complete(context.resume(&canceled, true));
        assert_eq!(shell.calls.load(Ordering::Relaxed), 0);

        set_disabled(&mut context, file, true);
        let disabled_label = stage_generated_with_metadata(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                20.0,
                native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                1,
            ),
        );
        complete(context.resume(&disabled_label, false));
        assert_eq!(shell.calls.load(Ordering::Relaxed), 0);

        set_disabled(&mut context, file, false);
        let label_click = stage_generated_with_metadata(
            &mut context,
            label,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                30.0,
                native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                1,
            ),
        );
        let after_label = context.resume(&label_click, false);
        let events = drain_steps(&mut context, after_label);
        assert_eq!(
            events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["click", "input", "change", "focus", "focusin"],
        );
        assert!(events.iter().all(|event| event.time_stamp == 30.0));
        assert!(
            events
                .iter()
                .all(|event| context.handles.resolve(event.target) == Some(file))
        );
        assert_eq!(shell.calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            context
                .text_controls
                .value(&mut context.document, file)
                .as_deref(),
            Some(r"C:\fakepath\from-label.txt"),
        );
    }

    #[test]
    fn connected_file_type_transitions_rebuild_only_the_private_click_structure() {
        struct SelectingShell;

        impl ShellProvider for SelectingShell {
            fn open_file_dialog(
                &self,
                _multiple: bool,
                _filter: Option<blitz_traits::shell::FileDialogFilter>,
            ) -> Vec<std::path::PathBuf> {
                vec![std::path::PathBuf::from(r"C:\private\transition.txt")]
            }
        }

        let mut context = TestContext::with_shell(
            "<input id='file' type='text' style='display:block;width:160px;height:24px'>",
            Arc::new(SelectingShell),
        );
        let file = context.element("file");
        let authored_text = {
            let mut mutator = context.document.mutate();
            let text = mutator.create_text_node("author child");
            mutator.append_children(file, &[text]);
            text
        };

        context.set_input_type(file, "file");

        let file_children = &context.document.get_node(file).unwrap().children;
        assert_eq!(file_children.len(), 3);
        assert_eq!(file_children[2], authored_text);
        assert_eq!(
            context
                .document
                .get_node(file_children[0])
                .and_then(blitz_dom::Node::element_data)
                .map(|element| element.name.local.as_ref()),
            Some("button"),
        );
        assert_eq!(
            context
                .document
                .get_node(file_children[1])
                .and_then(blitz_dom::Node::element_data)
                .map(|element| element.name.local.as_ref()),
            Some("label"),
        );

        let click = stage_generated_with_metadata(
            &mut context,
            file,
            DomEventData::Click(pointer(
                1.0,
                1.0,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(1.0, 1.0, None, 0.0, 0.0),
                1,
            ),
        );
        let step = context.resume(&click, false);
        let _ = drain(&mut context, step);
        assert_eq!(
            context
                .text_controls
                .value(&mut context.document, file)
                .as_deref(),
            Some(r"C:\fakepath\transition.txt"),
        );
        assert!(
            !context
                .document
                .get_node(file)
                .unwrap()
                .text_content()
                .contains("private")
        );

        context.set_input_type(file, "text");
        assert_eq!(
            context.document.get_node(file).unwrap().children,
            vec![authored_text],
        );
        assert_eq!(
            context.document.get_node(file).unwrap().text_content(),
            "author child",
        );
    }

    #[test]
    fn initial_focus_related_target_ignores_blitz_root_fallback() {
        let mut context = TestContext::new(
            "<input id='box' type='checkbox'>\
             <label id='label' for='box' style='display:block;width:80px;height:24px'>box</label>",
        );
        let checkbox = context.element("box");
        let label = context.element("label");
        assert!(actual_focus_node_id(&context.document).is_none());
        assert_eq!(
            context.document.get_focussed_node_id(),
            Some(context.document.root_element().id),
            "pinned Blitz exposes the root as a keyboard target when nothing is focused"
        );
        let (x, y) = context.center(label);
        let click = stage_generated_with_metadata(
            &mut context,
            label,
            DomEventData::Click(pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                1,
            ),
        );

        let mut step = context.resume(&click, false);
        let mut saw_focus = false;
        while let DispatchStep::Event(current) = step {
            if current.event_type == "focus"
                && context.handles.resolve(current.target) == Some(checkbox)
            {
                saw_focus = true;
                assert_eq!(
                    current.payload.as_deref(),
                    Some(&DispatchEventPayload::Focus {
                        related_target: None,
                    })
                );
            }
            step = context.resume(&current, false);
        }
        assert!(saw_focus);
    }

    #[test]
    fn cleared_focus_related_target_ignores_blitz_root_fallback() {
        let mut context = TestContext::new(
            "<input id='old'><div id='target' style='width:40px;height:40px'></div>",
        );
        let old = context.element("old");
        let target = context.element("target");
        assert!(context.document.set_focus_to(old));
        let (x, y) = context.center(target);
        assert!(context.document.set_hover_to(x, y));
        let mut step = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::Primary),
            flavor: PointerFlavor::Down,
            metadata: EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), None, 0.0, 0.0),
                1,
            ),
        });

        let mut saw_blur = false;
        while let DispatchStep::Event(current) = step {
            if current.event_type == "blur" && context.handles.resolve(current.target) == Some(old)
            {
                saw_blur = true;
                assert_eq!(
                    current.payload.as_deref(),
                    Some(&DispatchEventPayload::Focus {
                        related_target: None,
                    })
                );
            }
            step = context.resume(&current, false);
        }
        assert!(saw_blur);
        assert!(actual_focus_node_id(&context.document).is_none());
    }

    #[test]
    fn direct_ime_surrounding_deletion_retains_its_manual_redraw() {
        let mut context = TestContext::new("<input id='editor' value='abc'>");
        let input = context.element("editor");
        assert!(context.document.set_focus_to(input));
        context
            .document
            .with_text_input(input, |mut driver| driver.move_to_byte(1));
        let before_input = event(context.begin(DispatchRequest::ImeDeleteSurrounding {
            before_bytes: 1,
            after_bytes: 0,
        }));
        assert_eq!(before_input.event_type, "beforeinput");
        assert_eq!(context.raw_text(input), "abc");
        let input_event = event(context.resume(&before_input, false));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(input_event.target, before_input.target);
        assert_eq!(
            input_event.time_stamp.to_bits(),
            before_input.time_stamp.to_bits()
        );
        assert_eq!(
            input_event.payload.as_deref(),
            Some(&DispatchEventPayload::Input(InputPayload {
                data: None,
                input_type: "deleteByComposition",
                is_composing: false,
            }))
        );
        assert_eq!(context.raw_text(input), "bc");
        let (_, redraw_requested) = complete(context.resume(&input_event, false));
        assert!(redraw_requested);

        let mut retargeted =
            TestContext::new("<input id='first' value='abc'><input id='second' value='xyz'>");
        let first = retargeted.element("first");
        let second = retargeted.element("second");
        assert!(retargeted.document.set_focus_to(first));
        retargeted
            .document
            .with_text_input(first, |mut driver| driver.move_to_byte(1));
        retargeted
            .document
            .with_text_input(second, |mut driver| driver.move_to_byte(1));
        let before_input = event(retargeted.begin(DispatchRequest::ImeDeleteSurrounding {
            before_bytes: 1,
            after_bytes: 0,
        }));
        retargeted.document.clear_focus();
        assert!(retargeted.document.set_focus_to(second));
        complete(retargeted.resume(&before_input, false));
        assert_eq!(retargeted.raw_text(first), "abc");
        assert_eq!(retargeted.raw_text(second), "xyz");
    }

    #[test]
    fn duplicate_queued_events_are_not_collapsed() {
        let mut context = TestContext::new("<input id='editor' value=''>");
        let input = context.element("editor");
        let target = guard_node(&context.document, &mut context.handles, input)
            .expect("handle should fit")
            .expect("input should be live");
        let frame_id = context
            .stack
            .allocate_frame_id()
            .expect("frame id should fit");
        let planned = ["first", "second"]
            .into_iter()
            .map(|value| PlannedWork::Enqueue {
                target: PlannedTarget::Guarded(target),
                data: DomEventData::Input(BlitzInputEvent {
                    value: value.to_owned(),
                }),
                metadata: EventMetadata::native(),
                suppress_default: false,
                space_key: None,
            })
            .collect();
        context.stack.frames.push(DispatchFrame {
            id: frame_id,
            planned,
            generated: VecDeque::new(),
            pending: None,
            redraw_requested: false,
        });
        let step = context
            .stack
            .advance(
                &mut context.document,
                &mut context.text_controls,
                &mut context.checked_controls,
                &mut context.handles,
                context.redraw.as_ref(),
            )
            .expect("first input should stage");
        let (types, _, _) = drain(&mut context, step);
        assert_eq!(types, ["input", "input"]);
    }
}
