use std::ffi::c_void;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

type StatusCallback = extern "C" fn(val: i32);

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
                            cb(i);
                        }
                    } else {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    i += 10;
                    cb(i);
                }
            }
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn app_send_cmd(ptr: *mut c_void, cmd: *const std::os::raw::c_char) {
    let state = unsafe { &mut *(ptr as *mut QuoxApp) };
    let c_str = unsafe { std::ffi::CStr::from_ptr(cmd) };
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
