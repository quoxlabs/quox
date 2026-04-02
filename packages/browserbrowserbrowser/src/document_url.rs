//! Resolve the real document URL behind a fetch URL (e.g. CORS proxy) for correct relative link resolution.
use markup5ever::local_name;
use markup5ever_rcdom::{Handle, NodeData};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use url::Url;

/// If HTML was loaded through a known proxy, return the inner page URL; otherwise `fetch_url`.
pub fn document_target_url(fetch_url: &str) -> String {
    let Ok(u) = Url::parse(fetch_url) else {
        return fetch_url.to_string();
    };
    if !host_is_corsproxy(u.host_str()) {
        return fetch_url.to_string();
    }
    if let Some(q) = u.query() {
        if let Ok(inner) = Url::parse(q.trim()) {
            if inner.has_host() {
                return inner.to_string();
            }
        }
    }
    fetch_url.to_string()
}

fn host_is_corsproxy(host: Option<&str>) -> bool {
    matches!(
        host,
        Some("corsproxy.io") | Some("www.corsproxy.io")
    )
}

/// Document URL for resolving relative `href` (after `<base>`).
pub fn effective_base_url(fetch_url: &str, root: &Handle) -> Option<Url> {
    let target = document_target_url(fetch_url);
    let doc_url = Url::parse(&target).ok()?;
    find_base_href(root)
        .and_then(|href| doc_url.join(&href).ok())
        .or(Some(doc_url))
}

/// URL used to fetch a subresource. If the document was fetched via corsproxy.io,
/// subresources are wrapped through the same proxy.
pub fn subresource_fetch_url(fetch_url: &str, absolute_subresource_url: &str) -> String {
    let Ok(fetch) = Url::parse(fetch_url) else {
        return absolute_subresource_url.to_string();
    };
    if host_is_corsproxy(fetch.host_str()) {
        let enc = utf8_percent_encode(absolute_subresource_url, NON_ALPHANUMERIC).to_string();
        format!("https://corsproxy.io/?{enc}")
    } else {
        absolute_subresource_url.to_string()
    }
}

fn find_base_href(root: &Handle) -> Option<String> {
    let el = find_first_base_element(root)?;
    match &el.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .find(|a| a.name.local == local_name!("href"))
            .map(|a| a.value.to_string()),
        _ => None,
    }
}

fn find_first_base_element(handle: &Handle) -> Option<Handle> {
    if let NodeData::Element { name, .. } = &handle.data {
        if name.local == local_name!("base") {
            return Some(handle.clone());
        }
    }
    for c in handle.children.borrow().iter() {
        if let Some(h) = find_first_base_element(c) {
            return Some(h);
        }
    }
    None
}
