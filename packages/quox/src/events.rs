use std::ffi::CString;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::keyboard::{Key, PhysicalKey};

/// Serialize an input-relevant `WindowEvent` to a JSON C string.
/// Returns `None` for events that are not exposed as input events.
pub fn serialize(event: &WindowEvent) -> Option<CString> {
    let json = match event {
        WindowEvent::CursorMoved { position, .. } => {
            format!(
                r#"{{"type":"mousemove","x":{},"y":{}}}"#,
                position.x, position.y
            )
        }
        WindowEvent::MouseInput { state, button, .. } => {
            format!(
                r#"{{"type":"{}","button":{}}}"#,
                if *state == ElementState::Pressed {
                    "mousedown"
                } else {
                    "mouseup"
                },
                mouse_button_index(button)
            )
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let (dx, dy) = match delta {
                MouseScrollDelta::LineDelta(x, y) => (*x as f64 * 100.0, *y as f64 * 100.0),
                MouseScrollDelta::PixelDelta(pos) => (pos.x, pos.y),
            };
            format!(r#"{{"type":"wheel","deltaX":{},"deltaY":{}}}"#, dx, dy)
        }
        WindowEvent::KeyboardInput { event, .. } => {
            let kind = if event.state == ElementState::Pressed {
                "keydown"
            } else {
                "keyup"
            };
            let key = match &event.logical_key {
                Key::Character(s) => s.to_string(),
                Key::Named(named) => format!("{named:?}"),
                _ => "Unidentified".to_string(),
            };
            let code = match &event.physical_key {
                PhysicalKey::Code(code) => format!("{code:?}"),
                PhysicalKey::Unidentified(_) => "Unidentified".to_string(),
            };
            format!(
                r#"{{"type":"{kind}","key":{},"code":{}}}"#,
                json_escape(&key),
                json_escape(&code)
            )
        }
        _ => return None,
    };
    CString::new(json).ok()
}

fn mouse_button_index(button: &MouseButton) -> u32 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(n) => u32::from(*n) + 5,
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
