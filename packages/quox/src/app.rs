use anyrender_vello::VelloWindowRenderer;
use blitz_shell::{BlitzApplication, BlitzShellEvent, EventLoop, WindowConfig};
use std::os::raw::c_char;
use tokio::runtime::Runtime;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::window::WindowId;

use crate::events;

pub type EventCallback = unsafe extern "C" fn(*const c_char);

/// Wraps `BlitzApplication` and forwards input events to an optional FFI callback.
pub struct QuoxApplication {
    inner: BlitzApplication<VelloWindowRenderer>,
    pub callback: Option<EventCallback>,
}

impl QuoxApplication {
    pub fn new(proxy: EventLoopProxy<BlitzShellEvent>) -> Self {
        Self {
            inner: BlitzApplication::new(proxy),
            callback: None,
        }
    }

    pub fn add_window(&mut self, config: WindowConfig<VelloWindowRenderer>) {
        self.inner.add_window(config);
    }
}

impl ApplicationHandler<BlitzShellEvent> for QuoxApplication {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.inner.resumed(event_loop);
    }

    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        self.inner.suspended(event_loop);
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if let Some(cb) = self.callback {
            if let Some(json) = events::serialize(&event) {
                // SAFETY: `json` outlives this call; `cb` is a valid function pointer
                // provided by Deno and kept alive on the TypeScript side.
                unsafe { cb(json.as_ptr()) };
            }
        }
        self.inner.window_event(event_loop, window_id, event);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: BlitzShellEvent) {
        self.inner.user_event(event_loop, event);
    }
}

/// Owns the tokio runtime, winit event loop, and blitz application.
pub struct QuoxWindow {
    pub _rt: Runtime,
    pub event_loop: EventLoop<BlitzShellEvent>,
    pub app: QuoxApplication,
}
