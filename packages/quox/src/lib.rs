use anyrender_vello::VelloWindowRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_shell::{BlitzShellEvent, ControlFlow, EventLoop};
use std::error::Error;
use std::ffi::{CStr, CString, c_void};
use std::os::raw::c_char;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use winit::platform::x11::EventLoopBuilderExtX11;

type StatusCallback = extern "C" fn(event: *const c_char);

pub struct QuoxApp {
    rt: Runtime,
    sender: Option<mpsc::Sender<String>>,
}
impl QuoxApp {
    fn new() -> Self {
        QuoxApp {
            rt: Runtime::new().unwrap(),
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
                            run_html(&cmd).expect("cannot render");
                        }
                    } else {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    i += 10;
                    let msg = format!("Status update: {}", i);
                    let c_str = CString::new(msg).unwrap();
                    cb(c_str.as_ptr());
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

pub fn create_default_event_loop() -> EventLoop<BlitzShellEvent> {
    let mut ev_builder = EventLoop::with_user_event();
    ev_builder.with_any_thread(true);

    let event_loop = ev_builder.build().unwrap();
    event_loop.set_control_flow(ControlFlow::Wait);

    event_loop
}

/// Open a native window (via `winit`) and render the given HTML using `blitz` + `anyrender_vello`.
pub fn run_html(html: &str) -> Result<(), Box<dyn Error>> {
    let event_loop = create_default_event_loop();
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

    // Blocks until the window is closed.
    event_loop
        .run_app(&mut app)
        .map_err(|e| Box::new(e) as Box<dyn Error>)
}
