use anyrender_vello::VelloWindowRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzShellEvent, EventLoop, create_default_event_loop};
use std::error::Error;
use std::ffi::{CStr, CString, c_void};
use std::os::raw::c_char;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

type StatusCallback = extern "C" fn(event: *const c_char);

pub struct QuoxApp {
    rt: Runtime,
    ev: EventLoop<BlitzShellEvent>,
    sender: Option<mpsc::Sender<String>>,
}
impl QuoxApp {
    fn new() -> Self {
        QuoxApp {
            rt: Runtime::new().unwrap(),
            ev: create_default_event_loop(),
            sender: None,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn app_new() -> *mut c_void {
    let app = QuoxApp::new();
    // move to heap, prevent dealloc
    Box::into_raw(Box::new(app)) as *mut c_void
}

#[unsafe(no_mangle)]
pub extern "C" fn app_start_work(ptr: *mut c_void, cb: StatusCallback) {
    assert!(!ptr.is_null());
    let state = unsafe { &mut *(ptr as *mut QuoxApp) };

    let (tx, mut rx) = mpsc::channel::<String>(32);
    state.sender = Some(tx);

    state.rt.spawn(async move {
        let mut i = 0;
        loop {
            tokio::select! {
                maybe_cmd = rx.recv() => {
                    if let Some(cmd) = maybe_cmd {
                        println!("[Rust] Received event from TypeScript: {}", cmd);
                        if cmd == "reset" {
                            i = 0;
                            let s = CString::new("Counter reset").unwrap();
                            cb(s.as_ptr());
                        } else if cmd.trim_start().starts_with("<!DOCTYPE html>") {
                            run_html(state.ev, &cmd).expect("cannot render");
                        }
                    } else {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    i += 10;
                    let msg = format!("Status update: {}", i);
                    if let Ok(c_str) = CString::new(msg) {
                         cb(c_str.as_ptr());
                    }
                }
            }
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn app_send_cmd(ptr: *mut c_void, cmd: *const c_char) {
    let state = unsafe { &mut *(ptr as *mut QuoxApp) };
    let c_str = unsafe { CStr::from_ptr(cmd) };
    let cmd_str = c_str.to_string_lossy().into_owned();
    if let Some(tx) = &state.sender {
        let _ = tx.try_send(cmd_str);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn app_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        // take ownership in order to dealloc
        let _ = Box::from_raw(ptr as *mut QuoxApp);
    }
}

/// Open a native window (via `winit`) and render the given HTML using `blitz` + `anyrender_vello`.
pub fn run_html(event_loop: EventLoop<BlitzShellEvent>, html: &str) -> Result<(), Box<dyn Error>> {
    let proxy = event_loop.create_proxy();

    // Parse HTML into a Blitz document.
    let doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some("https://example.com".to_string()),
            ..Default::default()
        },
    );

    let renderer = VelloWindowRenderer::new();
    let attrs = blitz_shell::Window::default_attributes().with_title("Blitz HTML");
    let window_config = blitz_shell::WindowConfig::with_attributes(Box::new(doc), renderer, attrs);

    let mut app = blitz_shell::BlitzApplication::new(proxy);
    app.add_window(window_config);

    // FIXME: Houston, we have a problem:
    // 1. The following (blocking!) line is needed in order to run the application.
    // 2. It MUST be called from the main thread, as it requires exclusive access to the windows. Running an application from other threads is apparently a very bad idea.
    // 3. The only way to call into Rust from the main thread is by calling it directly via FFI.
    //   a) We can't delegate this to a tokio runtime (uses a non-main thread to execute the future).
    //   b) We also can't delegate this to our own thread (also non-main thread).
    // 4. This always blocks the JS side indefinitely.
    //   a) If we perform the FFI call directly, we block the application until the following (blocking!) line returns, i.e. never.
    //   b) If we perform the FFI call with `nonblocking: true`, Deno spawns a new dedicated thread which may be blocked---but it is not the main thread.
    // 5. How can we solve this?
    //   a) Implement an event loop that crosses the JS-Rust boundary in order to drive tokio from the main (JS) thread? Ugly, slow, challenging.
    //   b) Lauch the UI in a new process (ew!) and communicate via IPC? Moves more and more away from being self-contained inside Deno, but resembles how most other projects seem do it.
    //   c) Fork Deno and implement a feature that lets us perform a single blocking FFI call from the main thread into Rust, and that makes the rest of Deno run on other worker threads? Probably the cleanest option, but also the hardest.

    // Blocks until the window is closed.
    event_loop
        .run_app(&mut app)
        .map_err(|e| Box::new(e) as Box<dyn Error>)
}
