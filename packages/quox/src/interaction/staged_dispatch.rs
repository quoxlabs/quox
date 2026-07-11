use super::{
    apply_ime_delete_surrounding, is_insertable_text, key_event, mouse_button, pointer_buttons,
    preedit_cursor, validate_key_abi,
};
use crate::dom::public_dom_node_id;
use crate::ffi_numbers::{
    NumericArgumentError, finite_f32, finite_f64, integer_range, known_mask, nonnegative_f64,
    uint32, wasm_usize,
};
use crate::node_handles::NodeHandles;
use crate::{QuoxRenderer, QuoxRendererState, sync_document_layout};
use blitz_dom::BaseDocument;
use blitz_traits::events::{
    BlitzImeEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent, DomEvent,
    DomEventData, MouseEventButton, Point as ElementPoint, PointerDetails,
};
use js_sys::{Array, Object, Reflect};
use std::collections::VecDeque;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_bindgen::prelude::*;

const KEY_EVENT_PRESSED: u32 = super::KEY_EVENT_PRESSED;
const KEY_EVENT_PREVENT_DEFAULT: u32 = super::KEY_EVENT_PREVENT_DEFAULT;
const KEY_MOD_ALT: u32 = super::KEY_MOD_ALT;
const KEY_MOD_ALT_GRAPH: u32 = super::KEY_MOD_ALT_GRAPH;
const KEY_MOD_CAPS_LOCK: u32 = super::KEY_MOD_CAPS_LOCK;
const KEY_MOD_CONTROL: u32 = super::KEY_MOD_CONTROL;
const KEY_MOD_META: u32 = super::KEY_MOD_META;
const KEY_MOD_SHIFT: u32 = super::KEY_MOD_SHIFT;
const POINTER_MOD_KNOWN: u32 = super::POINTER_MOD_KNOWN;

/// One paused host dispatch. Frames form a stack because an event listener may synchronously
/// start another trusted event before it resumes the event which invoked it.
pub(crate) struct DispatchStack {
    frames: Vec<DispatchFrame>,
    next_frame_id: Option<u32>,
    next_event_id: Option<u32>,
}

struct DispatchFrame {
    id: u32,
    planned: VecDeque<PlannedWork>,
    generated: VecDeque<GuardedDomEvent>,
    pending: Option<PendingEvent>,
    redraw_requested: bool,
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
    page_x: f64,
    page_y: f64,
    offset_x: f64,
    offset_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NativePointerMetadata {
    coords: NativePointerCoordinates,
    detail: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NativeWheelMetadata {
    coords: NativePointerCoordinates,
    delta_x: f64,
    delta_y: f64,
    delta_mode: u32,
}

#[derive(Clone, Debug, PartialEq)]
struct NativeKeyMetadata {
    code: String,
    key: String,
    keycode: u32,
    modifier_bits: u32,
    location: u32,
}

#[derive(Clone, Debug, PartialEq)]
struct EventMetadata {
    time_stamp: f64,
    pointer: Option<NativePointerMetadata>,
    wheel: Option<NativeWheelMetadata>,
    key: Option<NativeKeyMetadata>,
    related_target: Option<GuardedNode>,
}

impl EventMetadata {
    fn native() -> Self {
        Self {
            time_stamp: event_time_stamp(),
            pointer: None,
            wheel: None,
            key: None,
            related_target: None,
        }
    }

    fn pointer(time_stamp: f64, coords: NativePointerCoordinates, detail: u32) -> Self {
        Self {
            time_stamp,
            pointer: Some(NativePointerMetadata { coords, detail }),
            wheel: None,
            key: None,
            related_target: None,
        }
    }

    fn wheel(
        time_stamp: f64,
        coords: NativePointerCoordinates,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u32,
    ) -> Self {
        Self {
            time_stamp,
            pointer: None,
            wheel: Some(NativeWheelMetadata {
                coords,
                delta_x,
                delta_y,
                delta_mode,
            }),
            key: None,
            related_target: None,
        }
    }

    fn key(time_stamp: f64, key: NativeKeyMetadata) -> Self {
        Self {
            time_stamp,
            pointer: None,
            wheel: None,
            key: Some(key),
            related_target: None,
        }
    }

    fn with_related_target(mut self, related_target: Option<GuardedNode>) -> Self {
        self.related_target = related_target;
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
    },
    Pointer {
        default_target: GuardedRawNode,
        author_target: GuardedNode,
        data: BlitzPointerEvent,
        flavor: PointerFlavor,
        metadata: EventMetadata,
    },
    DefaultOnly {
        target: PlannedTarget,
        data: DomEventData,
        metadata: EventMetadata,
    },
    Action(DispatchAction),
}

#[derive(Clone, Copy)]
enum DispatchAction {
    PointerDownState(PlannedHover),
    PointerUpState,
    ClearHover,
    ImeDeleteSurrounding {
        before_bytes: usize,
        after_bytes: usize,
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

enum ResumeAction {
    Normal {
        suppress_default: bool,
    },
    PointerLead {
        pointer_default: GuardedDomEvent,
        mouse_data: Option<DomEventData>,
    },
    PointerMouse {
        pointer_default: GuardedDomEvent,
    },
}

struct PendingEvent {
    id: u32,
    guarded: GuardedDomEvent,
    resume: ResumeAction,
}

enum DispatchRequest {
    Empty,
    Pointer {
        event: BlitzPointerEvent,
        flavor: PointerFlavor,
        metadata: EventMetadata,
    },
    Wheel {
        event: BlitzWheelEvent,
        metadata: EventMetadata,
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
}

#[derive(Clone, Copy)]
struct PointerInput {
    native_x: f64,
    native_y: f64,
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
struct WheelInput {
    native_x: f64,
    native_y: f64,
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
    fn new(
        document: &'a mut BaseDocument,
        width: u32,
        height: u32,
        framebuffer_width: u32,
        framebuffer_height: u32,
        device_pixel_ratio: f32,
    ) -> Self {
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

    fn pointer_request(self, input: PointerInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::pointer(
            input.time_stamp,
            native_pointer_coordinates(input.native_x, input.native_y, scroll.x, scroll.y),
            input.detail,
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
            DispatchRequest::Pointer {
                event: BlitzPointerEvent {
                    id: BlitzPointerId::Mouse,
                    is_primary: true,
                    coords: super::pointer_coords(input.x, input.y, page_x, page_y),
                    button: input.button,
                    buttons: input.buttons,
                    mods: super::build_pointer_modifiers(input.modifier_bits),
                    details: PointerDetails::default(),
                    // Blitz overwrites this relative to the hit target before reading it.
                    element: ElementPoint::default(),
                },
                flavor: input.flavor,
                metadata,
            }
        })
    }

    fn wheel_request(self, input: WheelInput) -> DispatchRequest {
        let scroll = self.document.viewport_scroll();
        let metadata = EventMetadata::wheel(
            input.time_stamp,
            native_pointer_coordinates(input.native_x, input.native_y, scroll.x, scroll.y),
            input.delta_x,
            input.delta_y,
            input.delta_mode,
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
            DispatchRequest::Wheel {
                event: BlitzWheelEvent {
                    delta: BlitzWheelDelta::Pixels(input.blitz_delta_x, input.blitz_delta_y),
                    coords: super::pointer_coords(input.x, input.y, page_x, page_y),
                    buttons: input.buttons,
                    mods: super::build_pointer_modifiers(input.modifier_bits),
                },
                metadata,
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
    page_x: f64,
    page_y: f64,
    offset_x: f64,
    offset_y: f64,
    button: i16,
    buttons: u8,
    detail: u32,
    shift_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    meta_key: bool,
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
}

#[derive(Clone, Debug, PartialEq)]
enum DispatchEventPayload {
    Mouse(MousePayload),
    Pointer(PointerPayload),
    Wheel(WheelPayload),
    Keyboard(KeyboardPayload),
    Input,
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

    fn begin(
        &mut self,
        document: &mut BaseDocument,
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
            self.discard_failed_frame(frame_id, redraw);
            return Err(error);
        }

        let result = self.advance(document, handles, redraw);
        if result.is_err() {
            self.discard_failed_frame(frame_id, redraw);
        }
        result
    }

    fn resume(
        &mut self,
        document: &mut BaseDocument,
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
            ResumeAction::Normal { suppress_default } => {
                if !cancelled && !suppress_default {
                    self.run_default(document, handles, pending.guarded)?;
                }
            }
            ResumeAction::PointerLead {
                pointer_default,
                mouse_data,
            } => {
                if !cancelled {
                    if let Some(mouse_data) = mouse_data
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
                            ResumeAction::PointerMouse { pointer_default },
                        );
                    }
                    self.run_default(document, handles, pointer_default)?;
                }
            }
            ResumeAction::PointerMouse { pointer_default } => {
                if !cancelled {
                    self.run_default(document, handles, pointer_default)?;
                }
            }
        }

        self.advance(document, handles, redraw)
    }

    fn abort(&mut self, redraw: &AtomicBool, frame_id: u32) -> bool {
        let Some(index) = self.frames.iter().position(|frame| frame.id == frame_id) else {
            return false;
        };
        // As with resume, only a matching frame can claim an unattached redraw.
        self.capture_redraw(redraw);

        let redraw_requested = self.frames[index..]
            .iter()
            .any(|frame| frame.redraw_requested);
        self.frames.truncate(index);
        if redraw_requested && let Some(parent) = self.frames.last_mut() {
            parent.redraw_requested = true;
        }
        redraw_requested
    }

    fn plan_request(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        request: DispatchRequest,
    ) -> Result<(), DispatchError> {
        let planned = &mut self
            .frames
            .last_mut()
            .expect("begin pushed a frame before planning")
            .planned;

        match request {
            DispatchRequest::Empty => {}
            DispatchRequest::Pointer {
                event,
                flavor,
                metadata,
            } => {
                plan_pointer(document, handles, planned, &event, flavor, metadata)?;
            }
            DispatchRequest::Wheel { event, metadata } => {
                let target =
                    guarded_target_or_root(document, handles, document.get_hover_node_id())?;
                planned.push_back(PlannedWork::Enqueue {
                    target: PlannedTarget::Guarded(target),
                    data: DomEventData::Wheel(event),
                    metadata,
                    suppress_default: false,
                });
            }
            DispatchRequest::Key {
                event,
                metadata,
                suppress_default,
            } => {
                let target =
                    guarded_target_or_root(document, handles, document.get_focussed_node_id())?;
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
                });
            }
            DispatchRequest::Ime(event) => {
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Focused,
                    data: DomEventData::Ime(event),
                    metadata: EventMetadata::native(),
                });
            }
            DispatchRequest::ImeCommit(text) => {
                let time_stamp = event_time_stamp();
                let metadata = EventMetadata {
                    time_stamp,
                    pointer: None,
                    wheel: None,
                    key: None,
                    related_target: None,
                };
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Focused,
                    data: DomEventData::Ime(BlitzImeEvent::Preedit(String::new(), None)),
                    metadata: metadata.clone(),
                });
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Focused,
                    data: DomEventData::Ime(BlitzImeEvent::Commit(text)),
                    metadata,
                });
            }
            DispatchRequest::AppleStandardKeybinding(command) => {
                let target =
                    guarded_target_or_root(document, handles, document.get_focussed_node_id())?;
                planned.push_back(PlannedWork::DefaultOnly {
                    target: PlannedTarget::Guarded(target),
                    data: DomEventData::AppleStandardKeybinding(command.into()),
                    metadata: EventMetadata::native(),
                });
            }
            DispatchRequest::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            } => planned.push_back(PlannedWork::Action(DispatchAction::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            })),
        }

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
        handles: &mut NodeHandles,
        redraw: &AtomicBool,
    ) -> Result<DispatchStep, DispatchError> {
        loop {
            self.capture_redraw(redraw);
            let Some(frame) = self.frames.last_mut() else {
                return Err(DispatchError::new("quox: no DOM dispatch is active"));
            };
            debug_assert!(frame.pending.is_none());

            if let Some(event) = frame.generated.pop_front() {
                if let Some(event) = freeze_event_path(document, handles, event)? {
                    return self.stage(
                        redraw,
                        event,
                        ResumeAction::Normal {
                            suppress_default: false,
                        },
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
                } => {
                    if let Some(event) =
                        guard_planned_event(document, handles, target, data, metadata)?
                    {
                        return self.stage(
                            redraw,
                            event,
                            ResumeAction::Normal { suppress_default },
                        );
                    }
                }
                PlannedWork::Pointer {
                    default_target,
                    author_target,
                    mut data,
                    flavor,
                    metadata,
                } => {
                    if !raw_node_is_live(default_target, document, handles)
                        || !node_is_live(author_target, document, handles)
                    {
                        continue;
                    }
                    if let Some(rect) = document.get_client_bounding_rect(default_target.raw) {
                        data.element.x = data.coords.client_x - rect.x as f32;
                        data.element.y = data.coords.client_y - rect.y as f32;
                    }
                    let pointer_data = pointer_dom_data(flavor, data.clone(), false);
                    let Some(pointer_default) = guard_event_with_targets(
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
                    let mouse_data = data
                        .is_mouse()
                        .then(|| pointer_dom_data(flavor, data, true));
                    return self.stage(
                        redraw,
                        pointer_default.clone(),
                        ResumeAction::PointerLead {
                            pointer_default,
                            mouse_data,
                        },
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
                        self.run_default(document, handles, event)?;
                    }
                }
                PlannedWork::Action(action) => {
                    self.run_action(document, handles, action)?;
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
        let frame = self
            .frames
            .last_mut()
            .expect("events are staged only for an active frame");
        let step = DispatchEventStep {
            frame_id: frame.id,
            event_id,
            event_type: event.event.name().to_owned(),
            target: event.target.handle,
            path: event.path.iter().map(|node| node.handle).collect(),
            bubbles: event.event.bubbles,
            cancelable: event.event.cancelable,
            composed: event_is_composed(&event.event.data),
            time_stamp: event.metadata.time_stamp,
            payload: event_payload(&event.event.data, &event.metadata).map(Box::new),
        };
        frame.pending = Some(PendingEvent {
            id: event_id,
            guarded: event,
            resume,
        });
        self.capture_redraw(redraw);
        Ok(DispatchStep::Event(step))
    }

    fn run_default(
        &mut self,
        document: &mut BaseDocument,
        handles: &mut NodeHandles,
        mut guarded: GuardedDomEvent,
    ) -> Result<(), DispatchError> {
        if !node_is_live(guarded.target, document, handles) {
            return Ok(());
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
        let source_metadata = guarded.metadata.clone();
        let mut generated = Vec::new();
        document.handle_dom_event(&mut guarded.event, |event| generated.push(event));
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
        let mut guarded_generated = VecDeque::with_capacity(generated.len());
        for event in generated {
            let metadata =
                generated_event_metadata(&source_metadata, &event.data, old_focus, new_focus);
            if let Some(event) = guard_queued_event(document, handles, event, metadata)? {
                guarded_generated.push_back(event);
            }
        }
        self.frames
            .last_mut()
            .expect("defaults run only for an active frame")
            .generated
            .extend(guarded_generated);
        Ok(())
    }

    fn run_action(
        &mut self,
        document: &mut BaseDocument,
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
                document.clear_hover();
            }
            DispatchAction::ImeDeleteSurrounding {
                before_bytes,
                after_bytes,
            } => {
                if let Some(event) =
                    apply_ime_delete_surrounding(document, before_bytes, after_bytes)
                {
                    self.frames
                        .last_mut()
                        .expect("actions run only for an active frame")
                        .redraw_requested = true;
                    if let Some(event) =
                        guard_queued_event(document, handles, event, EventMetadata::native())?
                    {
                        self.frames
                            .last_mut()
                            .expect("actions run only for an active frame")
                            .generated
                            .push_back(event);
                    }
                }
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

    fn discard_failed_frame(&mut self, frame_id: u32, redraw: &AtomicBool) {
        let Some(index) = self.frames.iter().position(|frame| frame.id == frame_id) else {
            return;
        };
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

fn is_focus_event(data: &DomEventData) -> bool {
    matches!(
        data,
        DomEventData::Blur(_)
            | DomEventData::FocusOut(_)
            | DomEventData::Focus(_)
            | DomEventData::FocusIn(_)
    )
}

fn actual_focus_node_id(document: &BaseDocument) -> Option<usize> {
    document.get_focussed_node_id().filter(|target| {
        document
            .get_node(*target)
            .is_some_and(blitz_dom::Node::is_focussed)
    })
}

fn plan_pointer(
    document: &mut BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    event: &BlitzPointerEvent,
    flavor: PointerFlavor,
    metadata: EventMetadata,
) -> Result<(), DispatchError> {
    let hover = plan_hover_transitions(document, handles, planned, event, &metadata)?;

    match flavor {
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
    planned.push_back(PlannedWork::Pointer {
        default_target,
        author_target,
        data: event.clone(),
        flavor,
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

#[allow(
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
    let changed = document.set_hover_to(event.page_x(), event.page_y());
    let current = document.get_hover_node_id();
    let default_target = current
        .map(|raw| guard_raw_node(document, handles, raw))
        .transpose()?
        .flatten();
    let new_chain = pointer_author_chain(document, handles, current)?;
    let author_target = new_chain.first().copied();
    if !changed {
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
        if event.is_mouse() {
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
            if event.is_mouse() {
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
        if event.is_mouse() {
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
            if event.is_mouse() {
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
    default_target: GuardedRawNode,
    author_target: GuardedNode,
    data: DomEventData,
    metadata: EventMetadata,
) -> Result<Option<GuardedDomEvent>, DispatchError> {
    let metadata = metadata.with_target_offset(document, author_target.raw);
    freeze_event_path(
        document,
        handles,
        GuardedDomEvent {
            event: DomEvent::new(default_target.raw, data),
            default_target,
            target: author_target,
            path: Vec::new(),
            metadata,
        },
    )
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
        DomEventData::PointerMove(event)
        | DomEventData::PointerEnter(event)
        | DomEventData::PointerLeave(event)
        | DomEventData::PointerOver(event)
        | DomEventData::PointerOut(event) => Some(DispatchEventPayload::Pointer(pointer_payload(
            event, metadata, -1, 0,
        ))),
        DomEventData::PointerDown(event) | DomEventData::PointerUp(event) => {
            Some(DispatchEventPayload::Pointer(pointer_payload(
                event,
                metadata,
                mouse_button_number(event.button),
                0,
            )))
        }
        DomEventData::Click(event) => Some(DispatchEventPayload::Pointer(pointer_payload(
            event,
            metadata,
            mouse_button_number(event.button),
            pointer_detail(metadata),
        ))),
        DomEventData::ContextMenu(event) => Some(DispatchEventPayload::Pointer(pointer_payload(
            event,
            metadata,
            mouse_button_number(event.button),
            0,
        ))),
        DomEventData::MouseMove(event)
        | DomEventData::MouseEnter(event)
        | DomEventData::MouseLeave(event)
        | DomEventData::MouseOver(event)
        | DomEventData::MouseOut(event) => Some(DispatchEventPayload::Mouse(mouse_payload(
            event, metadata, 0, 0,
        ))),
        DomEventData::MouseDown(event)
        | DomEventData::MouseUp(event)
        | DomEventData::DoubleClick(event) => Some(DispatchEventPayload::Mouse(mouse_payload(
            event,
            metadata,
            mouse_button_number(event.button),
            pointer_detail(metadata),
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
        DomEventData::Input(_) => Some(DispatchEventPayload::Input),
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
    let mouse = mouse_payload(event, metadata, button, detail);
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

fn mouse_payload(
    event: &BlitzPointerEvent,
    metadata: &EventMetadata,
    button: i16,
    detail: u32,
) -> MousePayload {
    let coords = metadata.pointer.map_or(
        NativePointerCoordinates {
            client_x: f64::from(event.coords.client_x),
            client_y: f64::from(event.coords.client_y),
            page_x: f64::from(event.coords.page_x),
            page_y: f64::from(event.coords.page_y),
            offset_x: f64::from(event.element.x),
            offset_y: f64::from(event.element.y),
        },
        |native| native.coords,
    );
    mouse_payload_from_parts(
        coords,
        button,
        event.buttons.bits(),
        detail,
        event.mods,
        metadata.related_target,
    )
}

fn pointer_detail(metadata: &EventMetadata) -> u32 {
    metadata.pointer.map_or(0, |native| native.detail)
}

fn wheel_mouse_payload(event: &BlitzWheelEvent, metadata: &EventMetadata) -> MousePayload {
    let coords = metadata.wheel.map_or(
        NativePointerCoordinates {
            client_x: f64::from(event.coords.client_x),
            client_y: f64::from(event.coords.client_y),
            page_x: f64::from(event.coords.page_x),
            page_y: f64::from(event.coords.page_y),
            offset_x: 0.0,
            offset_y: 0.0,
        },
        |native| native.coords,
    );
    mouse_payload_from_parts(
        coords,
        0,
        event.buttons.bits(),
        0,
        event.mods,
        metadata.related_target,
    )
}

fn mouse_payload_from_parts(
    coords: NativePointerCoordinates,
    button: i16,
    buttons: u8,
    detail: u32,
    mods: keyboard_types::Modifiers,
    related_target: Option<GuardedNode>,
) -> MousePayload {
    MousePayload {
        client_x: coords.client_x,
        client_y: coords.client_y,
        page_x: coords.page_x,
        page_y: coords.page_y,
        offset_x: coords.offset_x,
        offset_y: coords.offset_y,
        button,
        buttons,
        detail,
        shift_key: mods.contains(keyboard_types::Modifiers::SHIFT),
        ctrl_key: mods.contains(keyboard_types::Modifiers::CONTROL),
        alt_key: mods.contains(keyboard_types::Modifiers::ALT),
        meta_key: mods.contains(keyboard_types::Modifiers::META),
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

const fn key_location_number(location: keyboard_types::Location) -> u32 {
    match location {
        keyboard_types::Location::Standard => 0,
        keyboard_types::Location::Left => 1,
        keyboard_types::Location::Right => 2,
        keyboard_types::Location::Numpad => 3,
    }
}

fn native_pointer_coordinates(
    client_x: f64,
    client_y: f64,
    scroll_x: f64,
    scroll_y: f64,
) -> NativePointerCoordinates {
    NativePointerCoordinates {
        client_x,
        client_y,
        page_x: client_x + scroll_x,
        page_y: client_y + scroll_y,
        offset_x: 0.0,
        offset_y: 0.0,
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
            }
            Self::Input => {
                set(&object, "data", JsValue::NULL)?;
                set(&object, "inputType", JsValue::from_str(""))?;
                set(&object, "isComposing", false.into())?;
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
    set(object, "screenX", 0.0.into())?;
    set(object, "screenY", 0.0.into())?;
    set(object, "offsetX", mouse.offset_x.into())?;
    set(object, "offsetY", mouse.offset_y.into())?;
    set(object, "button", f64::from(mouse.button).into())?;
    set(object, "buttons", f64::from(mouse.buttons).into())?;
    set(object, "detail", f64::from(mouse.detail).into())?;
    set(object, "shiftKey", mouse.shift_key.into())?;
    set(object, "ctrlKey", mouse.ctrl_key.into())?;
    set(object, "altKey", mouse.alt_key.into())?;
    set(object, "metaKey", mouse.meta_key.into())?;
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
    ResolvedInputLayout::new(
        &mut state.document,
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
        redraw_requested,
        node_handles,
        dispatch_stack,
        ..
    } = state;
    dispatch_stack.begin(document, node_handles, redraw_requested.as_ref(), request)
}

fn resume_request(
    state: &mut QuoxRendererState,
    frame_id: u32,
    event_id: u32,
    default_prevented: bool,
) -> Result<DispatchStep, DispatchError> {
    let QuoxRendererState {
        document,
        redraw_requested,
        node_handles,
        dispatch_stack,
        ..
    } = state;
    dispatch_stack.resume(
        document,
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

#[wasm_bindgen]
impl QuoxRenderer {
    pub fn begin_pointer_move(
        &self,
        x: f64,
        y: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
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
    pub fn begin_pointer_down(
        &self,
        x: f64,
        y: f64,
        button: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
        detail: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
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
        button: f64,
        buttons: f64,
        modifier_bits: f64,
        time_stamp: f64,
        detail: f64,
    ) -> Result<JsValue, JsValue> {
        let native_x = finite_f64(x, "x").map_err(NumericArgumentError::into_js)?;
        let native_y = finite_f64(y, "y").map_err(NumericArgumentError::into_js)?;
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
        let request = if is_insertable_text(text) {
            DispatchRequest::ImeCommit(text.to_owned())
        } else {
            DispatchRequest::Empty
        };
        let mut state = self.state.borrow_mut();
        let step = begin_request(&mut state, request);
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
            redraw_requested,
            dispatch_stack,
            ..
        } = &mut *state;
        let redraw_requested = dispatch_stack.abort(redraw_requested.as_ref(), frame_id);
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
    use blitz_traits::shell::{ColorScheme, Viewport};
    use keyboard_types::{Code, Key, Location, Modifiers};
    use std::sync::Arc;

    struct TestContext {
        document: BaseDocument,
        handles: NodeHandles,
        stack: DispatchStack,
        redraw: Arc<AtomicBool>,
    }

    impl TestContext {
        fn new(body: &str) -> Self {
            let redraw = Arc::new(AtomicBool::new(false));
            let document = HtmlDocument::from_html(
                &format!("<!doctype html><html><body>{body}</body></html>"),
                DocumentConfig {
                    viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
                    shell_provider: Some(Arc::new(QuoxShellProvider {
                        redraw_requested: Arc::clone(&redraw),
                        ime_requests: Arc::new(ImeRequestMailbox::default()),
                    })),
                    ..Default::default()
                },
            )
            .into_inner();
            let mut context = Self {
                document,
                handles: NodeHandles::default(),
                stack: DispatchStack::default(),
                redraw,
            };
            context.document.resolve(0.0);
            let _ = context.redraw.swap(false, Ordering::Relaxed);
            context
        }

        fn begin(&mut self, request: DispatchRequest) -> DispatchStep {
            self.stack
                .begin(
                    &mut self.document,
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
                    &mut self.handles,
                    self.redraw.as_ref(),
                    event.frame_id,
                    event.event_id,
                    default_prevented,
                )
                .expect("dispatch should resume")
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
            let request = ResolvedInputLayout::new(&mut self.document, 800, 600, 800, 600, 1.0)
                .pointer_request(PointerInput {
                    native_x: f64::from(x),
                    native_y: f64::from(y),
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

        fn begin_trusted_wheel(&mut self, x: f32, y: f32) -> DispatchStep {
            let request = ResolvedInputLayout::new(&mut self.document, 800, 600, 800, 600, 1.0)
                .wheel_request(WheelInput {
                    native_x: f64::from(x),
                    native_y: f64::from(y),
                    x,
                    y,
                    blitz_delta_x: 0.0,
                    blitz_delta_y: -40.0,
                    delta_x: 0.0,
                    delta_y: 1.0,
                    delta_mode: 1,
                    buttons: MouseEventButtons::None,
                    modifier_bits: 0,
                    time_stamp: event_time_stamp(),
                });
            self.begin(request)
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
                - 40.0)
                .abs()
                < f64::EPSILON
        );
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
            native_pointer_coordinates(f64::from(bx), f64::from(by), 0.0, 0.0),
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
        while let DispatchStep::Event(current) = step {
            types.push(current.event_type.clone());
            if matches!(
                current.event_type.as_str(),
                "pointerup" | "mouseup" | "click"
            ) {
                assert_eq!(context.handles.resolve(current.target), Some(label));
                assert_eq!(context.handles.resolve(current.path[0]), Some(label));
            }
            if current.event_type == "click" {
                assert_eq!(
                    context
                        .stack
                        .frames
                        .last()
                        .and_then(|frame| frame.pending.as_ref())
                        .map(|pending| pending.guarded.default_target.raw),
                    Some(hit.node_id)
                );
            }
            step = context.resume(&current, false);
        }

        assert!(types.iter().any(|event_type| event_type == "click"));
        assert!(types.iter().any(|event_type| event_type == "input"));
        assert_eq!(context.document.get_focussed_node_id(), Some(checkbox));
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
        let _ = drain(&mut context, down);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
            metadata: EventMetadata::native(),
        });
        let (types, _, _) = drain(&mut context, up);
        assert_eq!(
            types,
            [
                "pointerup",
                "mouseup",
                "click",
                "input",
                "blur",
                "focusout",
                "focus",
                "focusin",
            ]
        );
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
            complete(context.resume(&key_step, javascript_cancels));
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
        let input_step = event(context.resume(&key_step, false));
        assert_eq!(input_step.event_type, "input");
        assert_eq!(context.raw_text(input), "b");
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
        context.stack.abort(context.redraw.as_ref(), outer.frame_id);
        context.stack.abort(context.redraw.as_ref(), outer.frame_id);
        assert!(
            context
                .stack
                .resume(
                    &mut context.document,
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

        let commit = event(context.begin(DispatchRequest::ImeCommit("é".to_owned())));
        assert_eq!(commit.event_type, "input");
        assert_eq!(context.raw_text(input), "é");
        complete(context.resume(&commit, false));

        let apple = event(context.begin(DispatchRequest::AppleStandardKeybinding(
            "deleteBackward:".to_owned(),
        )));
        assert_eq!(apple.event_type, "input");
        assert_eq!(context.raw_text(input), "");
        complete(context.resume(&apple, false));
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
        context.stack.abort(context.redraw.as_ref(), inner.frame_id);
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
        assert!(
            context
                .stack
                .abort(context.redraw.as_ref(), pending.frame_id)
        );
        assert!(
            !context
                .stack
                .abort(context.redraw.as_ref(), pending.frame_id)
        );
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
                    &mut context.handles,
                    context.redraw.as_ref(),
                    1,
                    1,
                    false,
                )
                .is_err()
        );
        assert!(context.redraw.load(Ordering::Relaxed));
        assert!(!context.stack.abort(context.redraw.as_ref(), 1));
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
                    &mut context.handles,
                    context.redraw.as_ref(),
                    pending.frame_id,
                    pending.event_id + 1,
                    false,
                )
                .is_err()
        );
        assert!(context.redraw.load(Ordering::Relaxed));
        assert!(
            !context
                .stack
                .abort(context.redraw.as_ref(), pending.frame_id + 1)
        );
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
                    | KEY_MOD_ALT_GRAPH,
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
        let metadata = EventMetadata::pointer(
            321.25,
            NativePointerCoordinates {
                client_x,
                client_y,
                page_x: client_x + 2.75,
                page_y: client_y + 4.5,
                offset_x: 0.0,
                offset_y: 0.0,
            },
            3,
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
        assert_eq!(payload.mouse.page_x, client_x + 2.75);
        assert_eq!(payload.mouse.page_y, client_y + 4.5);
        assert_eq!(payload.mouse.offset_x, client_x - rect.x - border_left);
        assert_eq!(payload.mouse.offset_y, client_y - rect.y - border_top);
        assert_eq!(payload.mouse.button, 0);
        assert_eq!(payload.mouse.buttons, 1);
        assert_eq!(payload.mouse.detail, 0);
        assert!(payload.mouse.shift_key);
        assert!(payload.mouse.ctrl_key);
        assert!(payload.mouse.alt_key);
        assert!(payload.mouse.meta_key);
        assert_eq!(payload.pointer_id, 1.0);
        assert_eq!(payload.pointer_type, "mouse");
        assert_eq!(payload.width, 1.0);
        assert_eq!(payload.height, 1.0);
        assert_eq!(payload.pressure, 0.5);
        assert_eq!(payload.altitude_angle, std::f64::consts::FRAC_PI_2);
    }

    #[test]
    fn pointer_transitions_zero_detail_but_mouse_and_click_events_keep_the_count() {
        let pointer = pointer(1.0, 2.0, MouseEventButton::Main, MouseEventButtons::Primary);
        let metadata =
            EventMetadata::pointer(1.0, native_pointer_coordinates(1.0, 2.0, 0.0, 0.0), 4);
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
    fn wheel_payload_keeps_raw_units_separate_from_blitz_pixels() {
        let mut context = TestContext::new(
            "<div id='target' style='display:block;width:120px;height:40px'></div>",
        );
        let target = context.element("target");
        let (x, y) = context.center(target);
        let metadata = EventMetadata::wheel(
            91.5,
            NativePointerCoordinates {
                client_x: f64::from(x),
                client_y: f64::from(y),
                page_x: f64::from(x) + 10.0,
                page_y: f64::from(y) + 20.0,
                offset_x: 0.0,
                offset_y: 0.0,
            },
            1.25,
            -2.5,
            1,
        );
        let staged = stage_generated_with_metadata(
            &mut context,
            target,
            DomEventData::Wheel(BlitzWheelEvent {
                delta: BlitzWheelDelta::Pixels(-50.0, 100.0),
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
        assert!(payload.mouse.meta_key);
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
                delta: BlitzWheelDelta::Pixels(-50.0, 100.0),
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
        let metadata = EventMetadata::pointer(
            777.0,
            native_pointer_coordinates(f64::from(x), f64::from(y), 0.0, 0.0),
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
        let mut saw_blur = false;
        let mut saw_focus = false;
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
                    assert_eq!(payload.mouse.detail, 2);
                }
                "input" => {
                    saw_input = true;
                    assert_eq!(
                        current.payload.as_deref(),
                        Some(&DispatchEventPayload::Input)
                    );
                }
                "blur" => {
                    saw_blur = true;
                    assert_eq!(
                        current.payload.as_deref(),
                        Some(&DispatchEventPayload::Focus {
                            related_target: Some(checkbox_handle),
                        })
                    );
                }
                "focus" => {
                    saw_focus = true;
                    assert_eq!(
                        current.payload.as_deref(),
                        Some(&DispatchEventPayload::Focus {
                            related_target: Some(old_handle),
                        })
                    );
                }
                _ => {}
            }
            step = context.resume(&current, false);
        }
        assert!(saw_pointer_up && saw_mouse_up && saw_click && saw_input && saw_blur && saw_focus);
    }

    #[test]
    fn initial_focus_related_target_ignores_blitz_root_fallback() {
        let mut context =
            TestContext::new("<input id='box' type='checkbox' style='width:24px;height:24px'>");
        let checkbox = context.element("box");
        assert!(actual_focus_node_id(&context.document).is_none());
        assert_eq!(
            context.document.get_focussed_node_id(),
            Some(context.document.root_element().id),
            "pinned Blitz exposes the root as a keyboard target when nothing is focused"
        );
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
            EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), 0.0, 0.0),
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
        let click = stage_generated_with_metadata(
            &mut context,
            target,
            DomEventData::Click(pointer(
                x,
                y,
                MouseEventButton::Main,
                MouseEventButtons::None,
            )),
            EventMetadata::pointer(
                10.0,
                native_pointer_coordinates(f64::from(x), f64::from(y), 0.0, 0.0),
                1,
            ),
        );

        let mut step = context.resume(&click, false);
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
        let input_event = event(context.begin(DispatchRequest::ImeDeleteSurrounding {
            before_bytes: 1,
            after_bytes: 0,
        }));
        assert_eq!(input_event.event_type, "input");
        assert_eq!(context.raw_text(input), "bc");
        let (_, redraw_requested) = complete(context.resume(&input_event, false));
        assert!(redraw_requested);
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
                &mut context.handles,
                context.redraw.as_ref(),
            )
            .expect("first input should stage");
        let (types, _, _) = drain(&mut context, step);
        assert_eq!(types, ["input", "input"]);
    }
}
