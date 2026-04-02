//! Inner “browser”: WASM build uses **Dioxus Blitz** (Stylo + Taffy + Vello) to render HTML/CSS offscreen,
//! then draws RGBA into `<canvas>`. Requires WebGPU.
#![cfg(target_arch = "wasm32")]

mod blitz_wasm;
mod document_url;

use html5ever::driver::parse_document;
use html5ever::tendril::TendrilSink;
use markup5ever::local_name;
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
pub struct PaintResult {
    pub height_css_px: f64,
}

async fn fetch_text_with_cors(url: &str) -> Result<String, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no window"))?;
    let opts = web_sys::RequestInit::new();
    opts.set_method("GET");
    opts.set_mode(web_sys::RequestMode::Cors);

    let request = web_sys::Request::new_with_str_and_init(url, &opts)
        .map_err(|_| JsValue::from_str("invalid request"))?;

    let resp_val = JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(|_| JsValue::from_str("fetch failed"))?;

    let resp: web_sys::Response = resp_val
        .dyn_into()
        .map_err(|_| JsValue::from_str("bad response"))?;

    if !resp.ok() {
        return Err(JsValue::from_str(&format!("HTTP {}", resp.status())));
    }

    let text_val = JsFuture::from(resp.text().map_err(|_| JsValue::from_str("no body"))?)
        .await
        .map_err(|_| JsValue::from_str("read failed"))?;

    text_val
        .as_string()
        .ok_or_else(|| JsValue::from_str("empty body"))
}

async fn inline_stylesheets_for_blitz(html: &str, fetch_url: &str) -> String {
    let dom = RcDom::default();
    let Ok(dom) = parse_document(dom, html5ever::ParseOpts::default())
        .from_utf8()
        .read_from(&mut std::io::Cursor::new(html.as_bytes()))
    else {
        return html.to_string();
    };
    let root = dom.document.clone();
    let base = document_url::effective_base_url(fetch_url, &root);
    let mut hrefs = Vec::new();
    collect_stylesheet_hrefs(&root, &mut hrefs);
    hrefs.truncate(24);

    let mut css = String::new();
    for href in hrefs {
        let abs = if let Some(ref b) = base {
            if let Ok(u) = b.join(&href) {
                u.to_string()
            } else {
                continue;
            }
        } else {
            continue;
        };
        let fetch_css_url = document_url::subresource_fetch_url(fetch_url, &abs);
        if let Ok(txt) = fetch_text_with_cors(&fetch_css_url).await {
            css.push('\n');
            css.push_str(&txt);
        }
    }
    if css.is_empty() {
        return html.to_string();
    }

    let injected = format!("<style>{css}</style>");
    if html.contains("</head>") {
        html.replacen("</head>", &(injected + "</head>"), 1)
    } else {
        format!("{injected}{html}")
    }
}

#[wasm_bindgen(js_name = fetchAndPaint)]
pub async fn fetch_and_paint(
    canvas: &HtmlCanvasElement,
    url: &str,
    css_width: f64,
    device_pixel_ratio: f64,
) -> Result<JsValue, JsValue> {
    let html = fetch_text_with_cors(url).await?;
    let html = inline_stylesheets_for_blitz(&html, url).await;
    let out =
        blitz_wasm::paint_blitz_async(canvas, &html, url, css_width, device_pixel_ratio).await?;
    serde_wasm_bindgen::to_value(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn collect_stylesheet_hrefs(handle: &Handle, out: &mut Vec<String>) {
    if let NodeData::Element { name, attrs, .. } = &handle.data {
        if name.local == local_name!("link") {
            let attrs = attrs.borrow();
            let mut rel_ok = false;
            let mut href: Option<String> = None;
            for a in attrs.iter() {
                if a.name.local == local_name!("rel") {
                    rel_ok = a
                        .value
                        .to_ascii_lowercase()
                        .split_whitespace()
                        .any(|v| v == "stylesheet");
                } else if a.name.local == local_name!("href") {
                    href = Some(a.value.to_string());
                }
            }
            if rel_ok {
                if let Some(h) = href {
                    out.push(h);
                }
            }
        }
    }
    for child in handle.children.borrow().iter() {
        collect_stylesheet_hrefs(child, out);
    }
}
