use blitz_dom::BaseDocument;
use blitz_traits::events::{BlitzPointerEvent, BlitzPointerId, DomEvent, DomEventData, UiEvent};
use keyboard_types::Modifiers;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum ElementEventKind {
    Click,
    DoubleClick,
    ContextMenu,
    Input,
    Focus,
    Blur,
    Scroll,
    PointerMove,
    PointerDown,
    PointerUp,
    PointerOver,
    PointerOut,
    MouseMove,
    MouseDown,
    MouseUp,
    MouseOver,
    MouseOut,
    Wheel,
    KeyDown,
    KeyUp,
}

impl ElementEventKind {
    fn bit(self) -> u32 {
        1_u32 << self as u8
    }

    fn name(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::DoubleClick => "dblclick",
            Self::ContextMenu => "contextmenu",
            Self::Input => "input",
            Self::Focus => "focus",
            Self::Blur => "blur",
            Self::Scroll => "scroll",
            Self::PointerMove => "pointermove",
            Self::PointerDown => "pointerdown",
            Self::PointerUp => "pointerup",
            Self::PointerOver => "pointerover",
            Self::PointerOut => "pointerout",
            Self::MouseMove => "mousemove",
            Self::MouseDown => "mousedown",
            Self::MouseUp => "mouseup",
            Self::MouseOver => "mouseover",
            Self::MouseOut => "mouseout",
            Self::Wheel => "wheel",
            Self::KeyDown => "keydown",
            Self::KeyUp => "keyup",
        }
    }
}

#[derive(Clone)]
pub struct KeyboardMetadata {
    pub code: String,
    pub key: String,
    pub location: u32,
    pub repeat: bool,
    pub modifiers: Modifiers,
}

struct EventEnvelope {
    event: DomEvent,
    keyboard: Option<KeyboardMetadata>,
    host_prevent_default: bool,
}

impl EventEnvelope {
    fn new(event: DomEvent) -> Self {
        Self {
            event,
            keyboard: None,
            host_prevent_default: false,
        }
    }
}

enum Step {
    Dom(EventEnvelope),
    Pointer {
        pointer: EventEnvelope,
        mouse: Option<EventEnvelope>,
    },
    Mouse {
        pointer: EventEnvelope,
        mouse: EventEnvelope,
    },
    Default(EventEnvelope),
    ClearHover,
}

enum Continuation {
    DomDefault(EventEnvelope),
    AfterPointer {
        pointer: EventEnvelope,
        mouse: Option<EventEnvelope>,
    },
    AfterMouse {
        pointer: EventEnvelope,
        mouse: EventEnvelope,
    },
}

struct PendingEvent {
    token: u32,
    continuation: Continuation,
}

#[derive(Default)]
pub struct EventBridge {
    interests: HashMap<usize, u32>,
    steps: VecDeque<Step>,
    pending: Option<PendingEvent>,
    frame: Option<EventFrame>,
    next_token: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventFrame {
    token: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    path: Vec<u32>,
    bubbles: bool,
    cancelable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    button: Option<i16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    buttons: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shift_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ctrl_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alt_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pointer_id: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pointer_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_primary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pressure: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangential_pressure: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tilt_x: Option<i8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tilt_y: Option<i8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    twist: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    altitude_angle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    azimuth_angle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta_mode: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repeat: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_composing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

impl EventFrame {
    fn new(
        document: &BaseDocument,
        token: u32,
        kind: ElementEventKind,
        path: Vec<u32>,
        envelope: &EventEnvelope,
    ) -> Self {
        let mut frame = Self::empty(token, kind, path, envelope);

        match &envelope.event.data {
            DomEventData::PointerMove(event)
            | DomEventData::PointerDown(event)
            | DomEventData::PointerUp(event)
            | DomEventData::PointerOver(event)
            | DomEventData::PointerOut(event) => frame.set_pointer(event, true),
            DomEventData::MouseMove(event)
            | DomEventData::MouseDown(event)
            | DomEventData::MouseUp(event)
            | DomEventData::MouseOver(event)
            | DomEventData::MouseOut(event)
            | DomEventData::Click(event)
            | DomEventData::ContextMenu(event)
            | DomEventData::DoubleClick(event) => frame.set_pointer(event, false),
            DomEventData::Wheel(event) => frame.set_wheel(event),
            DomEventData::KeyDown(event) | DomEventData::KeyUp(event) => {
                frame.set_keyboard(event, envelope.keyboard.as_ref());
            }
            DomEventData::Input(event) => frame.value = Some(event.value.clone()),
            _ => {}
        }

        if frame.client_x.is_some()
            && let Some(rect) = frame
                .path
                .first()
                .and_then(|node_id| document.get_client_bounding_rect(*node_id as usize))
        {
            frame.offset_x = frame.client_x.map(|client_x| client_x - rect.x);
            frame.offset_y = frame.client_y.map(|client_y| client_y - rect.y);
        }

        frame
    }

    fn empty(token: u32, kind: ElementEventKind, path: Vec<u32>, envelope: &EventEnvelope) -> Self {
        Self {
            token,
            event_type: kind.name(),
            path,
            bubbles: envelope.event.bubbles,
            cancelable: envelope.event.cancelable,
            client_x: None,
            client_y: None,
            page_x: None,
            page_y: None,
            screen_x: None,
            screen_y: None,
            offset_x: None,
            offset_y: None,
            button: None,
            buttons: None,
            shift_key: None,
            ctrl_key: None,
            alt_key: None,
            meta_key: None,
            pointer_id: None,
            pointer_type: None,
            is_primary: None,
            pressure: None,
            tangential_pressure: None,
            tilt_x: None,
            tilt_y: None,
            twist: None,
            altitude_angle: None,
            azimuth_angle: None,
            delta_x: None,
            delta_y: None,
            delta_mode: None,
            key: None,
            code: None,
            location: None,
            repeat: None,
            is_composing: None,
            value: None,
        }
    }

    fn set_wheel(&mut self, event: &blitz_traits::events::BlitzWheelEvent) {
        self.client_x = Some(f64::from(event.coords.client_x));
        self.client_y = Some(f64::from(event.coords.client_y));
        self.page_x = Some(f64::from(event.coords.page_x));
        self.page_y = Some(f64::from(event.coords.page_y));
        self.screen_x = Some(f64::from(event.coords.screen_x));
        self.screen_y = Some(f64::from(event.coords.screen_y));
        self.buttons = Some(u16::from(event.buttons.bits()));
        self.set_modifiers(event.mods);
        let (delta_x, delta_y, delta_mode) = match event.delta {
            blitz_traits::events::BlitzWheelDelta::Lines(x, y) => (x, y, 1),
            blitz_traits::events::BlitzWheelDelta::Pixels(x, y) => (x, y, 0),
        };
        self.delta_x = Some(delta_x);
        self.delta_y = Some(delta_y);
        self.delta_mode = Some(delta_mode);
    }

    fn set_keyboard(
        &mut self,
        event: &blitz_traits::events::BlitzKeyEvent,
        keyboard: Option<&KeyboardMetadata>,
    ) {
        if let Some(keyboard) = keyboard {
            self.key = Some(keyboard.key.clone());
            self.code = Some(keyboard.code.clone());
            self.location = Some(keyboard.location);
            self.repeat = Some(keyboard.repeat);
            self.set_modifiers(keyboard.modifiers);
        } else {
            self.key = Some(event.key.to_string());
            self.code = Some(format!("{:?}", event.code));
            self.location = Some(event.location as u32);
            self.repeat = Some(event.is_auto_repeating);
            self.set_modifiers(event.modifiers);
        }
        self.is_composing = Some(event.is_composing);
    }

    fn set_pointer(&mut self, event: &BlitzPointerEvent, include_pointer: bool) {
        self.client_x = Some(f64::from(event.coords.client_x));
        self.client_y = Some(f64::from(event.coords.client_y));
        self.page_x = Some(f64::from(event.coords.page_x));
        self.page_y = Some(f64::from(event.coords.page_y));
        self.screen_x = Some(f64::from(event.coords.screen_x));
        self.screen_y = Some(f64::from(event.coords.screen_y));
        self.offset_x = Some(f64::from(event.element.x));
        self.offset_y = Some(f64::from(event.element.y));
        self.button = Some(event.button as i16);
        self.buttons = Some(u16::from(event.buttons.bits()));
        self.set_modifiers(event.mods);

        if include_pointer {
            let (pointer_id, pointer_type) = match event.id {
                BlitzPointerId::Mouse => (1.0, "mouse"),
                BlitzPointerId::Pen => (2.0, "pen"),
                BlitzPointerId::Finger(id) => {
                    (f64::from(u32::try_from(id).unwrap_or(u32::MAX)), "touch")
                }
            };
            self.pointer_id = Some(pointer_id);
            self.pointer_type = Some(pointer_type);
            self.is_primary = Some(event.is_primary);
            self.pressure = Some(event.details.pressure);
            self.tangential_pressure = Some(f64::from(event.details.tangential_pressure));
            self.tilt_x = Some(event.details.tilt_x);
            self.tilt_y = Some(event.details.tilt_y);
            self.twist = Some(event.details.twist);
            self.altitude_angle = Some(event.details.altitude);
            self.azimuth_angle = Some(event.details.azimuth);
        }
    }

    fn set_modifiers(&mut self, modifiers: Modifiers) {
        self.shift_key = Some(modifiers.contains(Modifiers::SHIFT));
        self.ctrl_key = Some(modifiers.contains(Modifiers::CONTROL));
        self.alt_key = Some(modifiers.contains(Modifiers::ALT));
        self.meta_key = Some(modifiers.contains(Modifiers::META));
    }
}

impl EventBridge {
    pub fn set_interest(&mut self, node_id: usize, kind: ElementEventKind, enabled: bool) {
        if enabled {
            *self.interests.entry(node_id).or_default() |= kind.bit();
            return;
        }

        if let Some(entry) = self.interests.get_mut(&node_id) {
            *entry &= !kind.bit();
            let remove = *entry == 0;
            if remove {
                self.interests.remove(&node_id);
            }
        }
    }

    pub fn begin(
        &mut self,
        document: &mut BaseDocument,
        event: UiEvent,
        keyboard: Option<KeyboardMetadata>,
        host_prevent_default: bool,
    ) -> Result<(), JsValue> {
        if self.pending.is_some() || !self.steps.is_empty() {
            return Err(JsValue::from_str(
                "cannot start a nested DOM input dispatch",
            ));
        }
        self.frame = None;
        self.prepare_ui_event(document, event, keyboard, host_prevent_default);
        self.advance(document);
        Ok(())
    }

    pub fn finish(
        &mut self,
        document: &mut BaseDocument,
        token: u32,
        default_prevented: bool,
    ) -> Result<(), JsValue> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| JsValue::from_str("no DOM event is awaiting a decision"))?;
        if pending.token != token {
            self.pending = Some(pending);
            return Err(JsValue::from_str(
                "DOM event continuation token does not match",
            ));
        }
        self.frame = None;

        match pending.continuation {
            Continuation::DomDefault(mut envelope) => {
                let prevented = envelope.event.cancelable && default_prevented;
                if !prevented && !envelope.host_prevent_default {
                    self.run_default(document, &mut envelope.event);
                }
            }
            Continuation::AfterPointer { pointer, mouse } => {
                let prevented = pointer.event.cancelable && default_prevented;
                if !prevented {
                    if let Some(mouse) = mouse {
                        self.steps.push_front(Step::Mouse { pointer, mouse });
                    } else {
                        self.steps.push_front(Step::Default(pointer));
                    }
                }
            }
            Continuation::AfterMouse { pointer, mouse } => {
                let prevented = mouse.event.cancelable && default_prevented;
                if !prevented {
                    self.steps.push_front(Step::Default(pointer));
                }
            }
        }

        self.advance(document);
        Ok(())
    }

    pub fn take_frame(&mut self) -> Result<JsValue, JsValue> {
        match self.frame.take() {
            Some(frame) => serde_wasm_bindgen::to_value(&frame)
                .map_err(|error| JsValue::from_str(&error.to_string())),
            None => Ok(JsValue::UNDEFINED),
        }
    }

    fn advance(&mut self, document: &mut BaseDocument) {
        while self.pending.is_none() {
            let Some(step) = self.steps.pop_front() else {
                return;
            };

            match step {
                Step::Dom(envelope) => {
                    if let Some((kind, path)) = self.interested_path(document, &envelope.event) {
                        self.pause(document, kind, path, Continuation::DomDefault(envelope));
                    } else if !envelope.host_prevent_default {
                        let mut event = envelope.event;
                        self.run_default(document, &mut event);
                    }
                }
                Step::Pointer { pointer, mouse } => {
                    if let Some((kind, path)) = self.interested_path(document, &pointer.event) {
                        self.pause(
                            document,
                            kind,
                            path,
                            Continuation::AfterPointer { pointer, mouse },
                        );
                    } else if let Some(mouse) = mouse {
                        self.steps.push_front(Step::Mouse { pointer, mouse });
                    } else {
                        self.steps.push_front(Step::Default(pointer));
                    }
                }
                Step::Mouse { pointer, mouse } => {
                    if let Some((kind, path)) = self.interested_path(document, &mouse.event) {
                        self.pause(
                            document,
                            kind,
                            path,
                            Continuation::AfterMouse { pointer, mouse },
                        );
                    } else {
                        self.steps.push_front(Step::Default(pointer));
                    }
                }
                Step::Default(mut envelope) => {
                    if !envelope.host_prevent_default {
                        self.run_default(document, &mut envelope.event);
                    }
                }
                Step::ClearHover => {
                    document.clear_hover();
                }
            }
        }
    }

    fn pause(
        &mut self,
        document: &BaseDocument,
        kind: ElementEventKind,
        path: Vec<u32>,
        continuation: Continuation,
    ) {
        self.next_token = self.next_token.wrapping_add(1).max(1);
        let token = self.next_token;
        let envelope = match &continuation {
            Continuation::DomDefault(envelope)
            | Continuation::AfterPointer {
                pointer: envelope, ..
            }
            | Continuation::AfterMouse {
                mouse: envelope, ..
            } => envelope,
        };
        self.frame = Some(EventFrame::new(document, token, kind, path, envelope));
        self.pending = Some(PendingEvent {
            token,
            continuation,
        });
    }

    fn interested_path(
        &self,
        document: &BaseDocument,
        event: &DomEvent,
    ) -> Option<(ElementEventKind, Vec<u32>)> {
        let kind = event_kind(&event.data)?;
        let node_ids = if event.bubbles {
            document.node_chain(event.target)
        } else {
            vec![event.target]
        };
        let path: Vec<u32> = node_ids
            .into_iter()
            .filter(|node_id| {
                document
                    .get_node(*node_id)
                    .and_then(blitz_dom::Node::element_data)
                    .is_some()
            })
            .filter_map(|node_id| u32::try_from(node_id).ok())
            .collect();
        let interested = path.iter().any(|node_id| {
            self.interests
                .get(&(*node_id as usize))
                .is_some_and(|bits| bits & kind.bit() != 0)
        });
        interested.then_some((kind, path))
    }

    fn run_default(&mut self, document: &mut BaseDocument, event: &mut DomEvent) {
        let mut generated = Vec::new();
        document.handle_dom_event(event, |event| generated.push(event));
        for event in generated.into_iter().rev() {
            self.steps.push_front(Step::Dom(EventEnvelope::new(event)));
        }
    }

    fn prepare_ui_event(
        &mut self,
        document: &mut BaseDocument,
        event: UiEvent,
        keyboard: Option<KeyboardMetadata>,
        host_prevent_default: bool,
    ) {
        let hover = document.get_hover_node_id();
        let focus = document.get_focussed_node_id();

        match event {
            UiEvent::PointerMove(event) => {
                let target = self.prepare_pointer_move(document, &event);
                self.push_pointer_pair(document, target, event, PointerPairKind::Move);
            }
            UiEvent::PointerDown(event) => {
                let target = self.prepare_pointer_move(document, &event);
                document.active_node();
                document.set_mousedown_node_id(Some(target));
                self.push_pointer_pair(document, target, event, PointerPairKind::Down);
            }
            UiEvent::PointerUp(event) => {
                let target = self.prepare_pointer_move(document, &event);
                document.unactive_node();
                let clear_hover = event.is_primary && matches!(event.id, BlitzPointerId::Finger(_));
                self.push_pointer_pair(document, target, event, PointerPairKind::Up);
                if clear_hover {
                    self.steps.push_back(Step::ClearHover);
                }
            }
            UiEvent::Wheel(event) => {
                let target = hover.unwrap_or_else(|| document.root_element().id);
                self.steps
                    .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                        target,
                        DomEventData::Wheel(event),
                    ))));
            }
            UiEvent::KeyDown(event) => {
                let target = focus.unwrap_or_else(|| document.root_element().id);
                let mut envelope =
                    EventEnvelope::new(DomEvent::new(target, DomEventData::KeyDown(event)));
                envelope.keyboard = keyboard;
                envelope.host_prevent_default = host_prevent_default;
                self.steps.push_back(Step::Dom(envelope));
            }
            UiEvent::KeyUp(event) => {
                let target = focus.unwrap_or_else(|| document.root_element().id);
                let mut envelope =
                    EventEnvelope::new(DomEvent::new(target, DomEventData::KeyUp(event)));
                envelope.keyboard = keyboard;
                self.steps.push_back(Step::Dom(envelope));
            }
            UiEvent::Ime(event) => {
                let target = focus.unwrap_or_else(|| document.root_element().id);
                self.steps
                    .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                        target,
                        DomEventData::Ime(event),
                    ))));
            }
            UiEvent::AppleStandardKeybinding(event) => {
                let target = focus.unwrap_or_else(|| document.root_element().id);
                self.steps
                    .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                        target,
                        DomEventData::AppleStandardKeybinding(event),
                    ))));
            }
        }
    }

    fn prepare_pointer_move(
        &mut self,
        document: &mut BaseDocument,
        event: &BlitzPointerEvent,
    ) -> usize {
        let previous = document.get_hover_node_id();
        let changed = document.set_hover_to(event.page_x(), event.page_y());
        let current = document.get_hover_node_id();
        if !changed {
            return current
                .or(previous)
                .unwrap_or_else(|| document.root_element().id);
        }

        let mut old_chain = previous
            .map(|node_id| document.node_chain(node_id))
            .unwrap_or_default();
        let mut new_chain = current
            .map(|node_id| document.node_chain(node_id))
            .unwrap_or_default();
        old_chain.reverse();
        new_chain.reverse();
        let difference = old_chain
            .iter()
            .zip(&new_chain)
            .position(|(old, new)| old != new)
            .unwrap_or_else(|| old_chain.len().min(new_chain.len()));

        if let Some(target) = previous {
            self.push_transition(target, event, TransitionKind::Out);
            for &node_id in old_chain.get(difference..).unwrap_or(&[]) {
                self.push_transition(node_id, event, TransitionKind::Leave);
            }
        }
        if let Some(target) = current {
            self.push_transition(target, event, TransitionKind::Over);
            for &node_id in new_chain.get(difference..).unwrap_or(&[]) {
                self.push_transition(node_id, event, TransitionKind::Enter);
            }
        }

        current.unwrap_or_else(|| document.root_element().id)
    }

    fn push_transition(&mut self, target: usize, event: &BlitzPointerEvent, kind: TransitionKind) {
        let pointer_data = match kind {
            TransitionKind::Over => DomEventData::PointerOver(event.clone()),
            TransitionKind::Out => DomEventData::PointerOut(event.clone()),
            TransitionKind::Enter => DomEventData::PointerEnter(event.clone()),
            TransitionKind::Leave => DomEventData::PointerLeave(event.clone()),
        };
        let mouse_data = match kind {
            TransitionKind::Over => DomEventData::MouseOver(event.clone()),
            TransitionKind::Out => DomEventData::MouseOut(event.clone()),
            TransitionKind::Enter => DomEventData::MouseEnter(event.clone()),
            TransitionKind::Leave => DomEventData::MouseLeave(event.clone()),
        };
        self.steps
            .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                target,
                pointer_data,
            ))));
        if event.is_mouse() {
            self.steps
                .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                    target, mouse_data,
                ))));
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "Blitz stores layout rectangles as f64 but pointer element coordinates as f32"
    )]
    fn push_pointer_pair(
        &mut self,
        document: &BaseDocument,
        target: usize,
        mut event: BlitzPointerEvent,
        kind: PointerPairKind,
    ) {
        if let Some(rect) = document.get_client_bounding_rect(target) {
            event.element.x = event.coords.client_x - rect.x as f32;
            event.element.y = event.coords.client_y - rect.y as f32;
        }
        let pointer_data = match kind {
            PointerPairKind::Move => DomEventData::PointerMove(event.clone()),
            PointerPairKind::Down => DomEventData::PointerDown(event.clone()),
            PointerPairKind::Up => DomEventData::PointerUp(event.clone()),
        };
        let mouse_data = match kind {
            PointerPairKind::Move => DomEventData::MouseMove(event.clone()),
            PointerPairKind::Down => DomEventData::MouseDown(event.clone()),
            PointerPairKind::Up => DomEventData::MouseUp(event.clone()),
        };
        let pointer = EventEnvelope::new(DomEvent::new(target, pointer_data));
        let mouse = event
            .is_mouse()
            .then(|| EventEnvelope::new(DomEvent::new(target, mouse_data)));
        self.steps.push_back(Step::Pointer { pointer, mouse });
    }
}

#[derive(Clone, Copy)]
enum PointerPairKind {
    Move,
    Down,
    Up,
}

#[derive(Clone, Copy)]
enum TransitionKind {
    Over,
    Out,
    Enter,
    Leave,
}

fn event_kind(data: &DomEventData) -> Option<ElementEventKind> {
    match data {
        DomEventData::Click(_) => Some(ElementEventKind::Click),
        DomEventData::DoubleClick(_) => Some(ElementEventKind::DoubleClick),
        DomEventData::ContextMenu(_) => Some(ElementEventKind::ContextMenu),
        DomEventData::Input(_) => Some(ElementEventKind::Input),
        DomEventData::Focus(_) => Some(ElementEventKind::Focus),
        DomEventData::Blur(_) => Some(ElementEventKind::Blur),
        DomEventData::Scroll(_) => Some(ElementEventKind::Scroll),
        DomEventData::PointerMove(_) => Some(ElementEventKind::PointerMove),
        DomEventData::PointerDown(_) => Some(ElementEventKind::PointerDown),
        DomEventData::PointerUp(_) => Some(ElementEventKind::PointerUp),
        DomEventData::PointerOver(_) => Some(ElementEventKind::PointerOver),
        DomEventData::PointerOut(_) => Some(ElementEventKind::PointerOut),
        DomEventData::MouseMove(_) => Some(ElementEventKind::MouseMove),
        DomEventData::MouseDown(_) => Some(ElementEventKind::MouseDown),
        DomEventData::MouseUp(_) => Some(ElementEventKind::MouseUp),
        DomEventData::MouseOver(_) => Some(ElementEventKind::MouseOver),
        DomEventData::MouseOut(_) => Some(ElementEventKind::MouseOut),
        DomEventData::Wheel(_) => Some(ElementEventKind::Wheel),
        DomEventData::KeyDown(_) => Some(ElementEventKind::KeyDown),
        DomEventData::KeyUp(_) => Some(ElementEventKind::KeyUp),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{ElementEventKind, EventBridge, EventEnvelope, PointerPairKind, Step};
    use blitz_dom::{BaseDocument, DocumentConfig};
    use blitz_html::HtmlDocument;
    use blitz_traits::events::{
        BlitzFocusEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent,
        DomEvent, DomEventData, MouseEventButton, MouseEventButtons, Point, PointerCoords,
        PointerDetails,
    };
    use blitz_traits::shell::{ColorScheme, Viewport};
    use keyboard_types::Modifiers;

    fn document(html: &str) -> BaseDocument {
        let mut document = HtmlDocument::from_html(
            html,
            DocumentConfig {
                viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
                ..Default::default()
            },
        )
        .into_inner();
        document.resolve(0.0);
        document
    }

    fn element_id(document: &BaseDocument, tag_name: &str) -> usize {
        document
            .tree()
            .iter()
            .find_map(|(id, node)| {
                node.element_data()
                    .is_some_and(|element| element.name.local.as_ref() == tag_name)
                    .then_some(id)
            })
            .expect("element should exist")
    }

    fn pointer_event() -> BlitzPointerEvent {
        BlitzPointerEvent {
            id: BlitzPointerId::Mouse,
            is_primary: true,
            coords: PointerCoords {
                page_x: 12.0,
                page_y: 18.0,
                screen_x: 12.0,
                screen_y: 18.0,
                client_x: 12.0,
                client_y: 18.0,
            },
            button: MouseEventButton::Main,
            buttons: MouseEventButtons::empty(),
            mods: Modifiers::SHIFT,
            details: PointerDetails::default(),
            element: Point { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn text_target_is_normalized_to_its_nearest_element() {
        let mut document = document("<button>-</button>");
        let button = element_id(&document, "button");
        let text = document
            .get_node(button)
            .and_then(|node| node.children.first())
            .copied()
            .expect("button should contain text");
        assert!(
            document
                .get_node(text)
                .is_some_and(blitz_dom::Node::is_text_node)
        );

        let mut bridge = EventBridge::default();
        bridge.set_interest(button, ElementEventKind::Click, true);
        bridge
            .steps
            .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                text,
                DomEventData::Click(pointer_event()),
            ))));
        bridge.advance(&mut document);

        let frame = bridge
            .frame
            .as_ref()
            .expect("click should cross the bridge");
        assert_eq!(frame.event_type, "click");
        assert_eq!(frame.path.first().copied(), u32::try_from(button).ok());
        assert!(!frame.path.contains(&u32::try_from(text).unwrap()));
    }

    #[test]
    fn non_bubbling_event_only_considers_its_target() {
        let document = document("<main><input></main>");
        let input = element_id(&document, "input");
        let parent = document
            .get_node(input)
            .and_then(|node| node.parent)
            .unwrap();
        let event = DomEvent::new(input, DomEventData::Focus(BlitzFocusEvent));
        let mut bridge = EventBridge::default();

        bridge.set_interest(parent, ElementEventKind::Focus, true);
        assert!(bridge.interested_path(&document, &event).is_none());
        bridge.set_interest(input, ElementEventKind::Focus, true);
        let (_, path) = bridge
            .interested_path(&document, &event)
            .expect("target handler should be interested");
        assert_eq!(path, vec![u32::try_from(input).unwrap()]);
    }

    #[test]
    fn pointer_mouse_and_generated_click_frames_keep_blitz_order() {
        let mut document = document("<button>go</button>");
        let button = element_id(&document, "button");
        let mut bridge = EventBridge::default();
        bridge.set_interest(button, ElementEventKind::PointerUp, true);
        bridge.set_interest(button, ElementEventKind::MouseUp, true);
        bridge.set_interest(button, ElementEventKind::Click, true);

        bridge.push_pointer_pair(&document, button, pointer_event(), PointerPairKind::Up);
        bridge.advance(&mut document);
        assert_eq!(bridge.frame.as_ref().unwrap().event_type, "pointerup");

        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, false).unwrap();
        assert_eq!(bridge.frame.as_ref().unwrap().event_type, "mouseup");

        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, false).unwrap();
        assert_eq!(bridge.frame.as_ref().unwrap().event_type, "click");
    }

    #[test]
    fn cancellation_suppresses_checkbox_activation() {
        let mut document = document("<input type=checkbox>");
        let checkbox = element_id(&document, "input");
        let checked = |document: &BaseDocument| {
            document
                .get_node(checkbox)
                .and_then(blitz_dom::Node::element_data)
                .and_then(blitz_dom::ElementData::checkbox_input_checked)
                .unwrap()
        };
        assert!(!checked(&document));

        let mut bridge = EventBridge::default();
        bridge.set_interest(checkbox, ElementEventKind::Click, true);
        bridge
            .steps
            .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                checkbox,
                DomEventData::Click(pointer_event()),
            ))));
        bridge.advance(&mut document);
        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, true).unwrap();
        assert!(!checked(&document));

        bridge
            .steps
            .push_back(Step::Dom(EventEnvelope::new(DomEvent::new(
                checkbox,
                DomEventData::Click(pointer_event()),
            ))));
        bridge.advance(&mut document);
        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, false).unwrap();
        assert!(checked(&document));
    }

    #[test]
    fn cancellation_suppresses_wheel_scrolling() {
        let mut document = document("<main style='height: 2000px'>content</main>");
        let root = document.root_element().id;
        let wheel = || {
            DomEvent::new(
                root,
                DomEventData::Wheel(BlitzWheelEvent {
                    delta: BlitzWheelDelta::Pixels(0.0, -100.0),
                    coords: pointer_event().coords,
                    buttons: MouseEventButtons::empty(),
                    mods: Modifiers::empty(),
                }),
            )
        };
        let mut bridge = EventBridge::default();
        bridge.set_interest(root, ElementEventKind::Wheel, true);

        bridge
            .steps
            .push_back(Step::Dom(EventEnvelope::new(wheel())));
        bridge.advance(&mut document);
        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, true).unwrap();
        assert!(document.viewport_scroll().y.abs() < f64::EPSILON);

        bridge
            .steps
            .push_back(Step::Dom(EventEnvelope::new(wheel())));
        bridge.advance(&mut document);
        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, false).unwrap();
        assert!(document.viewport_scroll().y > 0.0);
    }

    #[test]
    fn canceled_compatibility_mouse_event_suppresses_pointer_default() {
        let mut document = document("<button>go</button>");
        let button = element_id(&document, "button");
        let mut bridge = EventBridge::default();
        bridge.set_interest(button, ElementEventKind::MouseUp, true);
        bridge.set_interest(button, ElementEventKind::Click, true);
        bridge.push_pointer_pair(&document, button, pointer_event(), PointerPairKind::Up);
        bridge.advance(&mut document);
        assert_eq!(bridge.frame.as_ref().unwrap().event_type, "mouseup");

        let token = bridge.pending.as_ref().unwrap().token;
        bridge.finish(&mut document, token, true).unwrap();
        assert!(bridge.frame.is_none());
        assert!(bridge.pending.is_none());
    }
}
