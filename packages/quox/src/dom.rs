use super::{QuoxRenderer, QuoxRendererState};
use blitz_dom::node::{ImageData, RasterImageData, SpecialElementData};
use blitz_dom::{DocumentMutator, LocalName, NodeData, QualName, ns};
use image::ImageReader;
use std::io::Cursor;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

fn html_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from(local_name),
    }
}

fn attr_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(),
        local: LocalName::from(local_name),
    }
}

fn invalid_node(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("Invalid DOM node id: {node_id}"))
}

fn invalid_element(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("DOM node id is not an element: {node_id}"))
}

impl QuoxRendererState {
    fn mutate_document<T>(
        &mut self,
        op: impl FnOnce(&mut DocumentMutator<'_>) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        let mut mutator = self.document.mutate();
        let result = op(&mut mutator);
        drop(mutator);

        result
    }

    fn ensure_node(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .map(|_| ())
            .ok_or_else(|| invalid_node(node_id))
    }

    fn ensure_element(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .ok_or_else(|| invalid_node(node_id))?
            .element_data()
            .map(|_| ())
            .ok_or_else(|| invalid_element(node_id))
    }

    /// The tag name of `node_id`'s element, lowercase for HTML elements.
    fn element_tag_name(&self, node_id: usize) -> Result<&str, JsValue> {
        Ok(self
            .document
            .get_node(node_id)
            .ok_or_else(|| invalid_node(node_id))?
            .element_data()
            .ok_or_else(|| invalid_element(node_id))?
            .name
            .local
            .as_ref())
    }

    /// Reject a resource reference that can't be resolved against the document's base URL.
    ///
    /// Blitz resolves `<img src>` and `<link href>` the moment they're set — that's what
    /// kicks off the fetch — and treats a URL it can't resolve as unreachable, panicking,
    /// which in WebAssembly takes the whole renderer with it. Validating against the same
    /// base URL first turns a bad URL into an ordinary error the caller can catch.
    fn ensure_resolvable_resource_url(
        &self,
        node_id: usize,
        name: &str,
        value: &str,
    ) -> Result<(), JsValue> {
        // Blitz ignores an empty reference rather than resolving it.
        if value.is_empty() {
            return Ok(());
        }

        match (self.element_tag_name(node_id)?, name) {
            ("img", "src") | ("link", "href") => {}
            _ => return Ok(()),
        }

        self.base_url.join(value).map(|_| ()).map_err(|e| {
            JsValue::from_str(&format!(
                "Cannot resolve {name}={value:?} against the document base URL {}: {e}",
                self.base_url
            ))
        })
    }

    fn child_element_by_tag(&self, parent_id: usize, tag_name: &str) -> Result<usize, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        parent
            .children
            .iter()
            .find_map(|child_id| {
                let child = self.document.get_node(*child_id)?;
                let element = child.element_data()?;
                (element.name.local.as_ref() == tag_name).then_some(*child_id)
            })
            .ok_or_else(|| JsValue::from_str(&format!("Missing <{tag_name}> element")))
    }

    fn optional_child_element_by_tag(
        &self,
        parent_id: usize,
        tag_name: &str,
    ) -> Result<Option<usize>, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        Ok(parent.children.iter().find_map(|child_id| {
            let child = self.document.get_node(*child_id)?;
            let element = child.element_data()?;
            (element.name.local.as_ref() == tag_name).then_some(*child_id)
        }))
    }

    /// Find the document's `<title>` element, if any. Mirrors the HTML spec's tolerance for a
    /// missing `<head>` (e.g. after `document.head.remove()`) by returning `None` rather than
    /// failing, so title lookups never break unrelated DOM operations.
    fn title_element(&self) -> Result<Option<usize>, JsValue> {
        let Some(head_id) =
            self.optional_child_element_by_tag(self.document.root_element().id, "head")?
        else {
            return Ok(None);
        };
        self.optional_child_element_by_tag(head_id, "title")
    }
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Remove a node from the retained document.
    pub fn remove_node(&self, node_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(node_id)?;
        state.mutate_document(|mutator| {
            mutator.remove_node(node_id);
            Ok(())
        })
    }

    // Append `child_id` to `parent_id`.
    pub fn append_child(&self, parent_id: usize, child_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(parent_id)?;
        state.ensure_node(child_id)?;
        state.mutate_document(|mutator| {
            mutator.append_children(parent_id, &[child_id]);
            Ok(())
        })
    }

    /// Return a node's text content.
    pub fn text_content(&self, node_id: usize) -> Result<String, JsValue> {
        let state = self.state.borrow();
        state
            .document
            .get_node(node_id)
            .map(blitz_dom::Node::text_content)
            .ok_or_else(|| invalid_node(node_id))
    }

    /// Return the document title.
    pub fn title(&self) -> Result<String, JsValue> {
        let state = self.state.borrow();
        match state.title_element()? {
            Some(node_id) => state
                .document
                .get_node(node_id)
                .map(blitz_dom::Node::text_content)
                .ok_or_else(|| invalid_node(node_id)),
            None => Ok(String::new()),
        }
    }

    /// Set an element attribute.
    ///
    /// Setting an attribute that references a resource (`<img src>`, `<link href>`) is what
    /// starts a fetch for it: Blitz resolves the value against the document's base URL and
    /// asks quox's net provider for the bytes (see `net`). The value is validated first, so
    /// an unresolvable URL is an error here rather than a panic inside Blitz.
    pub fn set_attribute(&self, node_id: usize, name: &str, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.ensure_resolvable_resource_url(node_id, name, value)?;
        state.mutate_document(|mutator| {
            mutator.set_attribute(node_id, attr_name(name), value);
            Ok(())
        })
    }

    /// Return an element attribute's value, or `None` if the attribute isn't set.
    pub fn get_attribute(&self, node_id: usize, name: &str) -> Result<Option<String>, JsValue> {
        let state = self.state.borrow();
        state.ensure_element(node_id)?;
        Ok(state
            .document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .and_then(|element| element.attr(LocalName::from(name)))
            .map(str::to_owned))
    }

    /// Decode an encoded image from `bytes` and display it in an `<img>` element.
    ///
    /// You pass the raw bytes of an image file — exactly what `Deno.readFile`
    /// returns — not pre-decoded pixels; decoding happens inside quox's WebAssembly
    /// module, so the caller only ever provides a byte buffer.
    ///
    /// Supported formats are PNG, JPEG, GIF and WebP. Animated formats (e.g. GIF)
    /// are shown as a still first frame, not animated.
    ///
    /// The image's intrinsic size becomes the element's natural size; `width`/`height`
    /// attributes or CSS on the element override it as usual. Errors if `node_id`
    /// isn't an `<img>` element or the bytes can't be decoded.
    ///
    /// This is the direct route for bytes the caller already holds. Setting the element's
    /// `src` attribute instead has Blitz request the URL through quox's net provider (see
    /// `net`), which ends up decoding the very same kind of byte buffer.
    //
    // Format support is pinned in `Cargo.toml` (`image` with `default-features =
    // false`); see the comment there for why we don't just take `image`'s defaults.
    pub fn set_image_data(&self, node_id: usize, bytes: &[u8]) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();

        // Restrict this to <img>. In HTML/CSS an <img> is a "replaced element": its
        // box isn't laid out from child content but is sized from an external
        // resource's own intrinsic dimensions — here, the decoded pixels.
        // (See https://developer.mozilla.org/en-US/docs/Glossary/Replaced_elements)
        // Blitz only derives that intrinsic size for replaced elements
        // (img/canvas/svg), so an <img> lays out and paints at the image's natural
        // size, as callers expect.
        //
        // On any other element (e.g. a <div>) the image decodes fine and would even
        // paint if the element were given an explicit CSS size, but it gets no
        // intrinsic size from the image — so by default the box collapses and nothing
        // shows. We reject non-<img> up front rather than ship that half-working case.
        if state.element_tag_name(node_id)? != "img" {
            return Err(JsValue::from_str(&format!(
                "DOM node id is not an <img> element: {node_id}"
            )));
        }

        let decoded = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| JsValue::from_str(&format!("Image format: {e}")))?
            .decode()
            .map_err(|e| JsValue::from_str(&format!("Image decode: {e}")))?;
        let width = decoded.width();
        let height = decoded.height();
        let rgba = decoded.into_rgba8().into_raw();

        let node = state
            .document
            .get_node_mut(node_id)
            .ok_or_else(|| invalid_node(node_id))?;
        node.element_data_mut()
            .ok_or_else(|| invalid_element(node_id))?
            .special_data = SpecialElementData::Image(Box::new(ImageData::Raster(
            RasterImageData::new(width, height, Arc::new(rgba)),
        )));
        // Drop the node's cached intrinsic-size measurement so the next layout pass
        // (`sync_layout` fully re-resolves on every render) picks up the new image.
        node.cache.clear();

        Ok(())
    }

    /// Create an element node in the retained document.
    pub fn create_element(&self, tag_name: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| {
            Ok(mutator.create_element(html_name(&tag_name.to_ascii_lowercase()), Vec::new()))
        })
    }

    /// Replace an element's children by parsing an HTML fragment through Blitz's mutator.
    pub fn set_inner_html(&self, node_id: usize, html: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.set_inner_html(node_id, html);
            Ok(())
        })
    }

    /// Create a text node in the retained document.
    pub fn create_text_node(&self, text: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| Ok(mutator.create_text_node(text)))
    }

    /// Return the root `<html>` element node id.
    pub fn document_element(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        Ok(state.document.root_element().id)
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&self, node_id: usize, name: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.clear_attribute(node_id, attr_name(name));
            Ok(())
        })
    }

    /// Replace a node's text content.
    pub fn set_text_content(&self, node_id: usize, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let is_text_node = {
            let node = state
                .document
                .get_node(node_id)
                .ok_or_else(|| invalid_node(node_id))?;
            matches!(&node.data, NodeData::Text(_))
        };

        state.mutate_document(|mutator| {
            if is_text_node {
                mutator.set_node_text(node_id, value);
            } else {
                mutator.remove_and_drop_all_children(node_id);
                if !value.is_empty() {
                    let text_id = mutator.create_text_node(value);
                    mutator.append_children(node_id, &[text_id]);
                }
            }

            Ok(())
        })
    }

    /// Replace the first document `<title>` text, creating the element in `<head>` if needed.
    /// Mirrors the HTML spec's `document.title` setter: if there is no `<head>` (e.g. after
    /// `document.head.remove()`), this is a no-op rather than an error.
    pub fn set_title(&self, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let Some(head_id) =
            state.optional_child_element_by_tag(state.document.root_element().id, "head")?
        else {
            return Ok(());
        };
        let existing_title_id = state.optional_child_element_by_tag(head_id, "title")?;

        state.mutate_document(|mutator| {
            let title_id = existing_title_id.unwrap_or_else(|| {
                let title_id = mutator.create_element(html_name("title"), Vec::new());
                mutator.append_children(head_id, &[title_id]);
                title_id
            });

            mutator.remove_and_drop_all_children(title_id);
            if !value.is_empty() {
                let text_id = mutator.create_text_node(value);
                mutator.append_children(title_id, &[text_id]);
            }

            Ok(())
        })
    }

    /// Return the document `<body>` node id.
    pub fn body(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "body")
    }

    /// Return the document `<head>` node id.
    pub fn head(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "head")
    }
}
