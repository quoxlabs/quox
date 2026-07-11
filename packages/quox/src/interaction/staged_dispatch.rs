use super::{
    apply_ime_delete_surrounding, is_insertable_text, key_event, mouse_button, pointer_buttons,
    pointer_event, preedit_cursor, validate_key_abi,
};
use crate::dom::public_dom_node_id;
use crate::ffi_numbers::{
    NumericArgumentError, finite_f32, finite_f64, known_mask, uint32, wasm_usize,
};
use crate::node_handles::NodeHandles;
use crate::{QuoxRenderer, QuoxRendererState};
use blitz_dom::BaseDocument;
use blitz_traits::events::{
    BlitzImeEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent, DomEvent,
    DomEventData, MouseEventButton,
};
use js_sys::{Array, Object, Reflect};
use std::collections::VecDeque;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_bindgen::prelude::*;

const KEY_EVENT_PRESSED: u32 = super::KEY_EVENT_PRESSED;
const KEY_EVENT_PREVENT_DEFAULT: u32 = super::KEY_EVENT_PREVENT_DEFAULT;
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

#[derive(Clone, Debug)]
struct EventMetadata {
    time_stamp: f64,
    /// The host's exact `KeyboardEvent.key` spelling is intentionally retained even when the
    /// pinned `keyboard-types` crate cannot parse it. A later payload serializer can expose it
    /// without using Blitz's lossy editor-only `Key` projection.
    #[allow(
        dead_code,
        reason = "preserved for the staged keyboard payload follow-up"
    )]
    host_key: Option<String>,
}

impl EventMetadata {
    fn native() -> Self {
        Self {
            time_stamp: event_time_stamp(),
            host_key: None,
        }
    }

    fn key(time_stamp: f64, host_key: String) -> Self {
        Self {
            time_stamp,
            host_key: Some(host_key),
        }
    }
}

#[derive(Clone, Debug)]
struct GuardedDomEvent {
    event: DomEvent,
    target: GuardedNode,
    path: Vec<GuardedNode>,
    metadata: EventMetadata,
}

impl GuardedDomEvent {
    fn is_target_live(&self, document: &BaseDocument, handles: &NodeHandles) -> bool {
        node_is_live(self.target, document, handles)
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
        target: GuardedNode,
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
    target: Option<GuardedNode>,
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
    },
    Wheel(BlitzWheelEvent),
    Key {
        event: blitz_traits::events::BlitzKeyEvent,
        host_key: String,
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
            DispatchRequest::Pointer { event, flavor } => {
                plan_pointer(document, handles, planned, &event, flavor)?;
            }
            DispatchRequest::Wheel(event) => {
                let target =
                    guarded_target_or_root(document, handles, document.get_hover_node_id())?;
                planned.push_back(PlannedWork::Enqueue {
                    target: PlannedTarget::Guarded(target),
                    data: DomEventData::Wheel(event),
                    metadata: EventMetadata::native(),
                    suppress_default: false,
                });
            }
            DispatchRequest::Key {
                event,
                host_key,
                suppress_default,
            } => {
                let target =
                    guarded_target_or_root(document, handles, document.get_focussed_node_id())?;
                let time_stamp = event_time_stamp();
                let data = if event.state.is_pressed() {
                    DomEventData::KeyDown(event)
                } else {
                    DomEventData::KeyUp(event)
                };
                planned.push_back(PlannedWork::Enqueue {
                    target: PlannedTarget::Guarded(target),
                    data,
                    metadata: EventMetadata::key(time_stamp, host_key),
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
                    host_key: None,
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
                    target,
                    mut data,
                    flavor,
                    metadata,
                } => {
                    if !node_is_live(target, document, handles) {
                        continue;
                    }
                    if let Some(rect) = document.get_client_bounding_rect(target.raw) {
                        data.element.x = data.coords.client_x - rect.x as f32;
                        data.element.y = data.coords.client_y - rect.y as f32;
                    }
                    let pointer_data = pointer_dom_data(flavor, data.clone(), false);
                    let Some(pointer_default) = guard_event_with_target(
                        document,
                        handles,
                        target,
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
        if !guarded.is_target_live(document, handles) {
            return Ok(());
        }

        let mut generated = Vec::new();
        document.handle_dom_event(&mut guarded.event, |event| generated.push(event));
        let mut guarded_generated = VecDeque::with_capacity(generated.len());
        for event in generated {
            if let Some(event) =
                guard_queued_event(document, handles, event, EventMetadata::native())?
            {
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
                let target_is_live = hover.target.is_some_and(|target| {
                    node_is_live(target, document, handles)
                        && hover.raw.is_some_and(|raw| {
                            document.get_node(raw).is_some()
                                && public_dom_node_id(document, raw) == Some(target.raw)
                        })
                });
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

fn plan_pointer(
    document: &mut BaseDocument,
    handles: &mut NodeHandles,
    planned: &mut VecDeque<PlannedWork>,
    event: &BlitzPointerEvent,
    flavor: PointerFlavor,
) -> Result<(), DispatchError> {
    let metadata = EventMetadata::native();
    let hover = plan_hover_transitions(document, handles, planned, event, &metadata)?;

    match flavor {
        PointerFlavor::Down => {
            planned.push_back(PlannedWork::Action(DispatchAction::PointerDownState(hover)));
        }
        PointerFlavor::Up => planned.push_back(PlannedWork::Action(DispatchAction::PointerUpState)),
        PointerFlavor::Move => {}
    }

    let target = hover
        .target
        .unwrap_or(guarded_target_or_root(document, handles, None)?);
    planned.push_back(PlannedWork::Pointer {
        target,
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
    let new_chain = public_hover_chain(document, handles, current)?;
    let guarded_current = new_chain.first().copied();
    if !changed {
        return Ok(PlannedHover {
            raw: current,
            target: guarded_current,
        });
    }

    let mut old_chain = public_hover_chain(document, handles, previous)?;
    let mut new_chain = new_chain;
    if old_chain == new_chain {
        // Blitz may move between an anonymous layout wrapper and its real DOM parent even though
        // the author-visible target/path did not change. Keep its raw hover state, but do not
        // manufacture duplicate boundary events for that internal transition.
        return Ok(PlannedHover {
            raw: current,
            target: guarded_current,
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
            metadata.clone(),
        );
        if event.is_mouse() {
            push_guarded_work(
                planned,
                target,
                DomEventData::MouseOut(event.clone()),
                metadata.clone(),
            );
        }
        for target in old_chain.get(first_difference..).unwrap_or(&[]) {
            push_guarded_work(
                planned,
                *target,
                DomEventData::PointerLeave(event.clone()),
                metadata.clone(),
            );
            if event.is_mouse() {
                push_guarded_work(
                    planned,
                    *target,
                    DomEventData::MouseLeave(event.clone()),
                    metadata.clone(),
                );
            }
        }
    }

    if let Some(target) = new_target {
        push_guarded_work(
            planned,
            target,
            DomEventData::PointerOver(event.clone()),
            metadata.clone(),
        );
        if event.is_mouse() {
            push_guarded_work(
                planned,
                target,
                DomEventData::MouseOver(event.clone()),
                metadata.clone(),
            );
        }
        for target in new_chain.get(first_difference..).unwrap_or(&[]) {
            push_guarded_work(
                planned,
                *target,
                DomEventData::PointerEnter(event.clone()),
                metadata.clone(),
            );
            if event.is_mouse() {
                push_guarded_work(
                    planned,
                    *target,
                    DomEventData::MouseEnter(event.clone()),
                    metadata.clone(),
                );
            }
        }
    }

    Ok(PlannedHover {
        raw: current,
        target: guarded_current,
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

/// Convert Blitz's target-first raw chain to an author-visible target-first DOM chain. Multiple
/// anonymous wrappers can normalize to the same real ancestor, so deduplicate after mapping.
fn public_hover_chain(
    document: &BaseDocument,
    handles: &mut NodeHandles,
    target: Option<usize>,
) -> Result<Vec<GuardedNode>, DispatchError> {
    let Some(target) = target else {
        return Ok(Vec::new());
    };
    let mut chain = Vec::new();
    for raw in document.node_chain(target) {
        let Some(raw) = public_dom_node_id(document, raw) else {
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
    let Some(target) = guard_node(document, handles, event.target)? else {
        return Ok(None);
    };
    event.target = target.raw;
    Ok(Some(GuardedDomEvent {
        event,
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
    freeze_event_path(
        document,
        handles,
        GuardedDomEvent {
            event: DomEvent::new(target.raw, data),
            target,
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
    if !guarded.is_target_live(document, handles) {
        return Ok(None);
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

fn node_is_live(guard: GuardedNode, document: &BaseDocument, handles: &NodeHandles) -> bool {
    handles.resolve(guard.handle) == Some(guard.raw) && document.get_node(guard.raw).is_some()
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

#[allow(
    clippy::needless_pass_by_value,
    reason = "the helper consumes temporary JsValues at compact object-construction call sites"
)]
fn set(object: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value).map(|_| ())
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
    ) -> Result<JsValue, JsValue> {
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = pointer_event(&state, x, y, MouseEventButton::Main, buttons, modifier_bits)
            .map_or(DispatchRequest::Empty, |event| DispatchRequest::Pointer {
                event,
                flavor: PointerFlavor::Move,
            });
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_pointer_down(
        &self,
        x: f64,
        y: f64,
        button: f64,
        buttons: f64,
        modifier_bits: f64,
    ) -> Result<JsValue, JsValue> {
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let button = mouse_button(button).map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = pointer_event(&state, x, y, button, buttons, modifier_bits).map_or(
            DispatchRequest::Empty,
            |event| DispatchRequest::Pointer {
                event,
                flavor: PointerFlavor::Down,
            },
        );
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_pointer_up(
        &self,
        x: f64,
        y: f64,
        button: f64,
        buttons: f64,
        modifier_bits: f64,
    ) -> Result<JsValue, JsValue> {
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let button = mouse_button(button).map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let request = pointer_event(&state, x, y, button, buttons, modifier_bits).map_or(
            DispatchRequest::Empty,
            |event| DispatchRequest::Pointer {
                event,
                flavor: PointerFlavor::Up,
            },
        );
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_wheel(
        &self,
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        buttons: f64,
        modifier_bits: f64,
    ) -> Result<JsValue, JsValue> {
        let x = finite_f32(x, "x").map_err(NumericArgumentError::into_js)?;
        let y = finite_f32(y, "y").map_err(NumericArgumentError::into_js)?;
        let delta_x = finite_f64(delta_x, "deltaX").map_err(NumericArgumentError::into_js)?;
        let delta_y = finite_f64(delta_y, "deltaY").map_err(NumericArgumentError::into_js)?;
        let buttons = pointer_buttons(buttons).map_err(NumericArgumentError::into_js)?;
        let modifier_bits = known_mask(modifier_bits, POINTER_MOD_KNOWN, "modifierBits")
            .map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let scroll = state.document.viewport_scroll();
        let request =
            super::viewport_point_to_page(x, y, state.width, state.height, scroll.x, scroll.y)
                .map_or(DispatchRequest::Empty, |(page_x, page_y)| {
                    DispatchRequest::Wheel(BlitzWheelEvent {
                        delta: BlitzWheelDelta::Pixels(delta_x, delta_y),
                        coords: super::pointer_coords(x, y, page_x, page_y),
                        buttons,
                        mods: super::build_pointer_modifiers(modifier_bits),
                    })
                });
        let step = begin_request(&mut state, request);
        finish_step(&mut state, step)
    }

    pub fn begin_key_event(
        &self,
        code: &str,
        key: &str,
        modifier_bits: f64,
        location: f64,
        event_flags: f64,
    ) -> Result<JsValue, JsValue> {
        let (modifier_bits, location, event_flags) =
            validate_key_abi(modifier_bits, location, event_flags)
                .map_err(NumericArgumentError::into_js)?;
        let event = key_event(code, key, modifier_bits, location, event_flags);
        let request = DispatchRequest::Key {
            event,
            host_key: key.to_owned(),
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
    use blitz_dom::{DocumentConfig, LocalName, NodeData};
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
        fn point_hitting(&self, node_id: usize) -> Option<(f32, f32)> {
            let rect = self.document.get_client_bounding_rect(node_id)?;
            for y_step in 0..24 {
                for x_step in 0..24 {
                    let x = rect.x + rect.width * (f64::from(x_step) + 0.5) / 24.0;
                    let y = rect.y + rect.height * (f64::from(y_step) + 0.5) / 24.0;
                    if self
                        .document
                        .hit(x as f32, y as f32)
                        .is_some_and(|hit| hit.node_id == node_id)
                    {
                        return Some((x as f32, y as f32));
                    }
                }
            }
            None
        }

        fn raw_text(&mut self, node_id: usize) -> String {
            let mut value = None;
            self.document.with_text_input(node_id, |driver| {
                value = Some(driver.editor.raw_text().to_owned());
            });
            value.expect("test node should be a text input")
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

        let step = context.begin(DispatchRequest::Pointer {
            event: pointer(
                host_point.0,
                host_point.1,
                MouseEventButton::Main,
                MouseEventButtons::None,
            ),
            flavor: PointerFlavor::Move,
        });
        let (types, _, _) = drain(&mut context, step);
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
        }));
        assert_eq!(pointer_down.event_type, "pointerdown");
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
        });
        let _ = drain(&mut context, down);

        let up = context.begin(DispatchRequest::Pointer {
            event: pointer(x, y, MouseEventButton::Main, MouseEventButtons::None),
            flavor: PointerFlavor::Up,
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
                host_key: "Delete".to_owned(),
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
            host_key: "Delete".to_owned(),
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
            host_key: "Enter".to_owned(),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            host_key: "Escape".to_owned(),
            suppress_default: false,
        }));
        assert_ne!(outer.frame_id, inner.frame_id);
        assert_ne!(outer.event_id, inner.event_id);
        assert_eq!(complete(context.resume(&inner, false)).0, inner.frame_id);
        assert_eq!(complete(context.resume(&outer, false)).0, outer.frame_id);

        let outer = event(context.begin(DispatchRequest::Key {
            event: key(Key::Enter, Code::Enter, KeyState::Released),
            host_key: "Enter".to_owned(),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            host_key: "Escape".to_owned(),
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
            host_key: "Enter".to_owned(),
            suppress_default: false,
        }));
        let inner = event(context.begin(DispatchRequest::Key {
            event: key(Key::Escape, Code::Escape, KeyState::Released),
            host_key: "Escape".to_owned(),
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
            host_key: "Enter".to_owned(),
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
            host_key: "Enter".to_owned(),
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
            host_key: "Enter".to_owned(),
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
        let pending = event(context.begin(DispatchRequest::Key {
            event: key(Key::Unidentified, Code::Unidentified, KeyState::Pressed),
            host_key: "FutureNamedKey".to_owned(),
            suppress_default: false,
        }));
        assert!(pending.time_stamp >= 0.0);
        assert!(pending.time_stamp < 1_000_000_000.0);
        assert_eq!(
            context
                .stack
                .frames
                .last()
                .and_then(|frame| frame.pending.as_ref())
                .and_then(|event| event.guarded.metadata.host_key.as_deref()),
            Some("FutureNamedKey")
        );
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
