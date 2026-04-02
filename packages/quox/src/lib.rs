mod app;
mod events;

use anyrender_vello::VelloWindowRenderer;
use app::{EventCallback, QuoxWindow};
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzShellEvent, create_default_event_loop};
use std::ffi::{CStr, c_void};
use std::os::raw::c_char;
use std::time::Duration;
use tokio::runtime::Runtime;
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};

/// Create a native window rendering the given HTML string.
/// Returns an opaque pointer that must be freed with `window_free`.
///
/// # Panics
///
/// Panics if the tokio runtime cannot be created.
///
/// # Safety
///
/// `html_ptr` must be a valid null-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn window_new(html_ptr: *const c_char) -> *mut c_void {
    let html = unsafe { CStr::from_ptr(html_ptr) }
        .to_string_lossy()
        .into_owned();

    let rt = Runtime::new().unwrap();
    let ev = create_default_event_loop::<BlitzShellEvent>();
    let proxy = ev.create_proxy();

    let doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            base_url: Some("https://example.com".to_string()),
            ..Default::default()
        },
    );

    let renderer = VelloWindowRenderer::new();
    let attrs = blitz_shell::Window::default_attributes().with_title("Blitz HTML");
    let window_config =
        blitz_shell::WindowConfig::with_attributes(Box::new(doc), renderer, attrs);

    let mut app = app::QuoxApplication::new(proxy);
    app.add_window(window_config);

    let window = QuoxWindow {
        rt,
        event_loop: ev,
        app,
    };
    Box::into_raw(Box::new(window)).cast::<c_void>()
}

/// Run a single spin of the event loop.
/// Returns `true` to keep running, `false` if the application has exited.
///
/// # Panics
///
/// Panics if `ptr` is null.
#[unsafe(no_mangle)]
pub extern "C" fn window_tick(ptr: *mut c_void) -> bool {
    assert!(!ptr.is_null());
    let window = unsafe { &mut *ptr.cast::<QuoxWindow>() };
    let _guard = window.rt.enter();
    let status = window
        .event_loop
        .pump_app_events(Some(Duration::ZERO), &mut window.app);
    matches!(status, PumpStatus::Continue)
}

/// Register a callback to receive input events.
/// The callback is invoked synchronously during `window_tick` for each input event,
/// with a pointer to a null-terminated JSON string that is valid only for the
/// duration of the call.
///
/// # Panics
///
/// Panics if `ptr` is null.
#[unsafe(no_mangle)]
pub extern "C" fn window_set_event_listener(ptr: *mut c_void, callback: EventCallback) {
    assert!(!ptr.is_null());
    let window = unsafe { &mut *ptr.cast::<QuoxWindow>() };
    window.app.callback = Some(callback);
}

/// Free a `QuoxWindow` created by `window_new`.
#[unsafe(no_mangle)]
pub extern "C" fn window_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Box::from_raw(ptr.cast::<QuoxWindow>());
    }
}
