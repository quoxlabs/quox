use anyrender_vello::VelloWindowRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use std::error::Error;
use std::slice;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn render_raw_html(buffer: *const u8, len: usize) {
    if buffer.is_null() {
        panic!("null pointer html");
    }
    let input_bytes = unsafe { slice::from_raw_parts(buffer, len) };
    let Ok(html_string) = std::str::from_utf8(input_bytes) else {
        panic!("bad string encoding2");
    };

    if let Err(err) = run_html(html_string) {
        eprintln!("run_html failed: {err:?}");
    }
}

/// Open a native window (via `winit`) and render the given HTML using `blitz` + `anyrender_vello`.
pub fn run_html(html: &str) -> Result<(), Box<dyn Error>> {
    let event_loop = blitz_shell::create_default_event_loop::<blitz_shell::BlitzShellEvent>();
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
