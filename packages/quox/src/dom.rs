use crate::QuoxRenderer;
use blitz_dom::{DocumentConfig, DocumentMutator, FontContext, LocalName, QualName, ns};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::DummyShellProvider;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const BLANK_DOCUMENT_HTML: &str = "<!DOCTYPE html><html><head></head><body></body></html>";

/// Prepend a `<style>` that names our embedded font explicitly so that blitz's
/// CSS resolver finds it (the generic-family map is empty on wasm32).
fn inject_font_css(html: &str) -> String {
    const STYLE: &str = "<style>html,body,*{font-family:'Liberation Sans',sans-serif;}</style>";
    if let Some(pos) = html.find("</head>") {
        format!("{}{}{}", &html[..pos], STYLE, &html[pos..])
    } else {
        format!("{STYLE}{html}")
    }
}

pub(super) fn blank_document(font_ctx: FontContext) -> HtmlDocument {
    document_from_html(BLANK_DOCUMENT_HTML, font_ctx)
}

fn document_config(font_ctx: FontContext) -> DocumentConfig {
    DocumentConfig {
        base_url: Some("https://example.com".to_string()),
        net_provider: Some(Arc::new(DummyNetProvider)),
        shell_provider: Some(Arc::new(DummyShellProvider)),
        html_parser_provider: Some(Arc::new(HtmlProvider)),
        font_ctx: Some(font_ctx),
        ..Default::default()
    }
}

fn document_from_html(html: &str, font_ctx: FontContext) -> HtmlDocument {
    HtmlDocument::from_html(&inject_font_css(html), document_config(font_ctx))
}

fn html_name(local: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from(local),
    }
}

fn attr_name(local: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(),
        local: LocalName::from(local),
    }
}

fn node_id_to_usize(node_id: u32) -> Result<usize, JsValue> {
    usize::try_from(node_id).map_err(|_| JsValue::from_str("node id is too large"))
}

fn node_id_to_u32(node_id: usize) -> Result<u32, JsValue> {
    u32::try_from(node_id).map_err(|_| JsValue::from_str("node id is too large"))
}

fn ensure_node(mutr: &DocumentMutator<'_>, node_id: usize) -> Result<(), JsValue> {
    if mutr.doc.get_node(node_id).is_some() {
        Ok(())
    } else {
        Err(JsValue::from_str("node does not exist"))
    }
}

#[wasm_bindgen]
#[allow(clippy::missing_errors_doc)]
impl QuoxRenderer {
    /// Return the root `<html>` element node id.
    pub fn document_element(&self) -> Result<u32, JsValue> {
        self.query_one("html")
    }

    /// Return the document `<head>` node id.
    pub fn head(&self) -> Result<u32, JsValue> {
        self.query_one("head")
    }

    /// Return the document `<body>` node id.
    pub fn body(&self) -> Result<u32, JsValue> {
        self.query_one("body")
    }

    /// Create an element node in the retained document.
    pub fn create_element(&mut self, tag_name: &str) -> Result<u32, JsValue> {
        self.mutate_document(|mutr| {
            node_id_to_u32(mutr.create_element(html_name(tag_name), Vec::new()))
        })
    }

    /// Create a text node in the retained document.
    pub fn create_text_node(&mut self, text: &str) -> Result<u32, JsValue> {
        self.mutate_document(|mutr| node_id_to_u32(mutr.create_text_node(text)))
    }

    /// Append `child_id` to `parent_id`.
    pub fn append_child(&mut self, parent_id: u32, child_id: u32) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let parent = node_id_to_usize(parent_id)?;
            let child = node_id_to_usize(child_id)?;
            ensure_node(mutr, parent)?;
            ensure_node(mutr, child)?;
            mutr.append_children(parent, &[child]);
            Ok(())
        })
    }

    /// Remove a node from the retained document.
    pub fn remove_node(&mut self, node_id: u32) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let node = node_id_to_usize(node_id)?;
            ensure_node(mutr, node)?;
            mutr.remove_and_drop_node(node);
            Ok(())
        })
    }

    /// Set an element attribute.
    pub fn set_attribute(&mut self, node_id: u32, name: &str, value: &str) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let node = node_id_to_usize(node_id)?;
            ensure_node(mutr, node)?;
            mutr.set_attribute(node, attr_name(name), value);
            Ok(())
        })
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&mut self, node_id: u32, name: &str) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let node = node_id_to_usize(node_id)?;
            ensure_node(mutr, node)?;
            mutr.clear_attribute(node, attr_name(name));
            Ok(())
        })
    }

    /// Replace a node's text content.
    pub fn set_text_content(&mut self, node_id: u32, value: &str) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let node = node_id_to_usize(node_id)?;
            ensure_node(mutr, node)?;
            if mutr
                .doc
                .get_node(node)
                .is_some_and(blitz_dom::Node::is_text_node)
            {
                mutr.set_node_text(node, value);
            } else {
                mutr.remove_and_drop_all_children(node);
                if !value.is_empty() {
                    let text = mutr.create_text_node(value);
                    mutr.append_children(node, &[text]);
                }
            }
            Ok(())
        })
    }

    /// Return a node's text content.
    pub fn text_content(&self, node_id: u32) -> Result<String, JsValue> {
        let node = node_id_to_usize(node_id)?;
        self.document
            .get_node(node)
            .map(blitz_dom::Node::text_content)
            .ok_or_else(|| JsValue::from_str("node does not exist"))
    }

    /// Replace an element's children by parsing an HTML fragment through Blitz's mutator.
    pub fn set_inner_html(&mut self, node_id: u32, html: &str) -> Result<(), JsValue> {
        self.mutate_document(|mutr| {
            let node = node_id_to_usize(node_id)?;
            ensure_node(mutr, node)?;
            mutr.set_inner_html(node, html);
            Ok(())
        })
    }
}

impl QuoxRenderer {
    fn query_one(&self, selector: &str) -> Result<u32, JsValue> {
        let node = self
            .document
            .query_selector(selector)
            .map_err(|_| JsValue::from_str("invalid selector"))?
            .ok_or_else(|| JsValue::from_str("node does not exist"))?;
        node_id_to_u32(node)
    }

    fn mutate_document<T>(
        &mut self,
        op: impl FnOnce(&mut DocumentMutator<'_>) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        let mut mutr = self.document.mutate();
        let result = op(&mut mutr);
        drop(mutr);

        result
    }
}
