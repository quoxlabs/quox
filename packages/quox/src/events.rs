use std::ffi::CString;
use serde::Serialize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::keyboard::{Key, PhysicalKey};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum InputEvent {
    Mousemove {
        x: f64,
        y: f64,
    },
    Mousedown {
        button: u32,
    },
    Mouseup {
        button: u32,
    },
    Wheel {
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    Keydown {
        key: String,
        code: String,
    },
    Keyup {
        key: String,
        code: String,
    },
}

/// Serialize an input-relevant `WindowEvent` to a JSON C string.
/// Returns `None` for events that are not exposed as input events.
pub fn serialize(event: &WindowEvent) -> Option<CString> {
    let input_event = match event {
        WindowEvent::CursorMoved { position, .. } => InputEvent::Mousemove {
            x: position.x,
            y: position.y,
        },
        WindowEvent::MouseInput { state, button, .. } => {
            let button = mouse_button_index(*button);
            if *state == ElementState::Pressed {
                InputEvent::Mousedown { button }
            } else {
                InputEvent::Mouseup { button }
            }
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let (delta_x, delta_y) = match delta {
                MouseScrollDelta::LineDelta(x, y) => (f64::from(*x) * 100.0, f64::from(*y) * 100.0),
                MouseScrollDelta::PixelDelta(pos) => (pos.x, pos.y),
            };
            InputEvent::Wheel { delta_x, delta_y }
        }
        WindowEvent::KeyboardInput { event, .. } => {
            let key = match &event.logical_key {
                Key::Character(s) => s.to_string(),
                Key::Named(named) => format!("{named:?}"),
                _ => "Unidentified".to_string(),
            };
            let code = match &event.physical_key {
                PhysicalKey::Code(code) => format!("{code:?}"),
                PhysicalKey::Unidentified(_) => "Unidentified".to_string(),
            };
            if event.state == ElementState::Pressed {
                InputEvent::Keydown { key, code }
            } else {
                InputEvent::Keyup { key, code }
            }
        }
        _ => return None,
    };
    let json = serde_json::to_string(&input_event).ok()?;
    CString::new(json).ok()
}

fn mouse_button_index(button: MouseButton) -> u32 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(n) => u32::from(n) + 5,
    }
}
