use anyrender_vello::VelloWindowRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzApplication, BlitzShellEvent, EventLoop, create_default_event_loop};
use std::ffi::{CStr, c_void};
use std::os::raw::c_char;
use std::time::Duration;
use tokio::runtime::Runtime;
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};

pub struct QuoxWindow {
    _rt: Runtime,
    event_loop: EventLoop<BlitzShellEvent>,
    app: BlitzApplication<VelloWindowRenderer>,
}

/// Create a native window rendering the given HTML string.
/// Returns a pointer to the `QuoxWindow` which must be freed with `window_free`.
#[unsafe(no_mangle)]
pub extern "C" fn window_new(html_ptr: *const c_char) -> *mut c_void {
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
    let window_config = blitz_shell::WindowConfig::with_attributes(Box::new(doc), renderer, attrs);

    let mut app = BlitzApplication::new(proxy);
    app.add_window(window_config);

    let window = QuoxWindow {
        _rt: rt,
        event_loop: ev,
        app,
    };
    Box::into_raw(Box::new(window)) as *mut c_void
}

/// Run a single spin of the event loop.
/// Returns `true` if the application should keep running, `false` if it has exited.
#[unsafe(no_mangle)]
pub extern "C" fn window_tick(ptr: *mut c_void) -> bool {
    assert!(!ptr.is_null());
    let window = unsafe { &mut *(ptr as *mut QuoxWindow) };
    let _guard = window._rt.enter();
    let status = window
        .event_loop
        .pump_app_events(Some(Duration::ZERO), &mut window.app);
    matches!(status, PumpStatus::Continue)
}

/// Free a `QuoxWindow` created by `window_new`.
#[unsafe(no_mangle)]
pub extern "C" fn window_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Box::from_raw(ptr as *mut QuoxWindow);
    }
}
