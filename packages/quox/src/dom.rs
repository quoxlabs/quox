use super::{QuoxRenderer, QuoxRendererState};
use crate::ffi_numbers::{NumericArgumentError, uint32};
use crate::form_controls::restore_text_editor;
use blitz_dom::{BaseDocument, DocumentMutator, LocalName, NodeData, QualName, ns};
use wasm_bindgen::prelude::*;

const ELEMENT_NODE: u8 = 1;
const TEXT_NODE: u8 = 3;
const ELEMENT_INTERFACE_GENERIC: u8 = 0;
const ELEMENT_INTERFACE_INPUT: u8 = 1;
const ELEMENT_INTERFACE_TEXTAREA: u8 = 2;

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
        local: LocalName::from(local_name.to_ascii_lowercase()),
    }
}

fn attribute_value(document: &BaseDocument, node_id: usize, name: &str) -> Option<String> {
    let name = attr_name(name);
    document
        .get_node(node_id)?
        .element_data()?
        .attr(name.local)
        .map(str::to_owned)
}

fn invalid_node_handle(node_handle: u32) -> JsValue {
    JsValue::from_str(&format!("Invalid or stale DOM node handle: {node_handle}"))
}

fn invalid_element(node_handle: u32) -> JsValue {
    JsValue::from_str(&format!("DOM node handle is not an element: {node_handle}"))
}

fn invalid_text_control(node_handle: u32) -> JsValue {
    js_sys::TypeError::new(&format!(
        "DOM node handle is not a rendered text-like input or textarea: {node_handle}"
    ))
    .into()
}

fn invalid_internal_node(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("Invalid internal DOM node id: {node_id}"))
}

/// Layout-only anonymous nodes are not DOM nodes and can be rebuilt by Blitz without going
/// through a Quox mutation. Map them back to their nearest real DOM ancestor before exposing
/// stable identities at the JavaScript boundary.
pub(super) fn public_dom_node_id(document: &BaseDocument, mut node_id: usize) -> Option<usize> {
    loop {
        let node = document.get_node(node_id)?;
        if !matches!(&node.data, NodeData::AnonymousBlock(_)) {
            return Some(node_id);
        }
        node_id = node.parent.or_else(|| node.layout_parent.get())?;
    }
}

/// Build the target-first DOM ancestor path for a synthetic event. The document itself has no
/// public node handle, so connectivity is returned separately and represented by a zero marker
/// at the JavaScript boundary.
fn synthetic_event_node_path(document: &BaseDocument, target_id: usize) -> (Vec<usize>, bool) {
    let mut path = Vec::new();
    let mut current_id = Some(target_id);

    while let Some(node_id) = current_id {
        let Some(node) = document.get_node(node_id) else {
            break;
        };
        match &node.data {
            NodeData::Document => return (path, true),
            NodeData::Element(_) | NodeData::Text(_) => path.push(node_id),
            NodeData::AnonymousBlock(_) | NodeData::Comment => {}
        }
        current_id = node.parent;
    }

    (path, false)
}

/// Return exactly the node ids Blitz's `remove_and_drop_all_children` will destroy.
fn dropped_descendant_ids(document: &BaseDocument, parent_id: usize) -> Vec<usize> {
    let Some(parent) = document.get_node(parent_id) else {
        return Vec::new();
    };
    let mut pending = parent.children.clone();
    let mut dropped = Vec::new();

    while let Some(node_id) = pending.pop() {
        let Some(node) = document.get_node(node_id) else {
            continue;
        };
        dropped.push(node_id);
        pending.extend(node.children.iter().copied());
        pending.extend(node.before);
        pending.extend(node.after);
    }

    dropped
}

#[derive(Clone, Copy, Default)]
struct FocusedEditorSnapshot {
    enabled: bool,
    composing: bool,
}

impl QuoxRendererState {
    fn focused_editor_snapshot(&self) -> FocusedEditorSnapshot {
        let Some(node_id) = self.document.get_focussed_node_id() else {
            return FocusedEditorSnapshot::default();
        };
        let Some(node) = self
            .document
            .get_node(node_id)
            .filter(|node| node.is_focussed())
        else {
            return FocusedEditorSnapshot::default();
        };
        let Some(editor) = node
            .element_data()
            .and_then(blitz_dom::ElementData::text_input_data)
        else {
            return FocusedEditorSnapshot::default();
        };
        FocusedEditorSnapshot {
            enabled: true,
            composing: editor.editor.raw_compose().is_some(),
        }
    }

    fn reconcile_native_ime_after_editor_mutation(&self, before: FocusedEditorSnapshot) {
        let after = self.focused_editor_snapshot();
        match (before.enabled, after.enabled) {
            (true, false) => self.ime_requests.request_enabled(false),
            (false, true) => self.ime_requests.request_enabled(true),
            (true, true) if before.composing && !after.composing => {
                self.ime_requests.request_restart();
            }
            _ => {}
        }
    }

    fn mutate_document<T>(
        &mut self,
        op: impl FnOnce(&mut DocumentMutator<'_>) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        let mut mutator = self.document.mutate();
        let result = op(&mut mutator);
        drop(mutator);

        result
    }

    /// Resolve an opaque public handle and verify that its Blitz node is still live. A mapping
    /// whose node disappeared unexpectedly is invalidated defensively, preventing a later slab
    /// occupant from inheriting the stale public handle.
    fn resolve_node(&mut self, node_handle: u32) -> Result<usize, JsValue> {
        let node_id = self
            .node_handles
            .resolve(node_handle)
            .ok_or_else(|| invalid_node_handle(node_handle))?;
        if self.document.get_node(node_id).is_none() {
            let _ = self.node_handles.invalidate_node(node_id);
            return Err(invalid_node_handle(node_handle));
        }

        Ok(node_id)
    }

    fn resolve_element(&mut self, node_handle: u32) -> Result<usize, JsValue> {
        let node_id = self.resolve_node(node_handle)?;
        self.document
            .get_node(node_id)
            .expect("resolve_node verified the node")
            .element_data()
            .map(|_| ())
            .ok_or_else(|| invalid_element(node_handle))?;
        Ok(node_id)
    }

    fn expose_node(&mut self, node_id: usize) -> Result<u32, JsValue> {
        if self.document.get_node(node_id).is_none() {
            return Err(invalid_internal_node(node_id));
        }

        self.node_handles
            .expose(node_id)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub(super) fn expose_public_dom_node(
        &mut self,
        node_id: usize,
    ) -> Result<Option<u32>, JsValue> {
        let Some(node_id) = public_dom_node_id(&self.document, node_id) else {
            return Ok(None);
        };
        self.expose_node(node_id).map(Some)
    }

    fn node_kind(&self, node_id: usize) -> u8 {
        match &self
            .document
            .get_node(node_id)
            .expect("callers resolve or expose live nodes")
            .data
        {
            NodeData::Element(_) => ELEMENT_NODE,
            NodeData::Text(_) => TEXT_NODE,
            _ => 0,
        }
    }

    fn invalidate_dropped_descendants(&mut self, parent_id: usize) -> Vec<u32> {
        // Collect and invalidate before mutation so the HTML parser cannot reuse a freed slab
        // index while its old public mapping still exists.
        let dropped = dropped_descendant_ids(&self.document, parent_id);
        self.text_controls.invalidate_nodes(dropped.iter().copied());
        self.node_handles.invalidate_nodes(dropped)
    }

    fn reconcile_text_controls(&mut self) {
        self.text_controls.reconcile_document(&mut self.document);
    }

    fn child_element_by_tag(&self, parent_id: usize, tag_name: &str) -> Result<usize, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_internal_node(parent_id))?;

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
            .ok_or_else(|| invalid_internal_node(parent_id))?;

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
    /// Detach a node from the retained document without destroying it or changing its public
    /// handle. This preserves browser-style identity if the caller later reattaches it.
    pub fn remove_node(&self, node_handle: f64) -> Result<(), JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_node(node_handle)?;
        state.mutate_document(|mutator| {
            mutator.remove_node(node_id);
            Ok(())
        })?;
        state.reconcile_text_controls();
        Ok(())
    }

    // Append `child_handle` to `parent_handle`.
    pub fn append_child(&self, parent_handle: f64, child_handle: f64) -> Result<(), JsValue> {
        let parent_handle =
            uint32(parent_handle, "parentHandle").map_err(NumericArgumentError::into_js)?;
        let child_handle =
            uint32(child_handle, "childHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let parent_id = state.resolve_node(parent_handle)?;
        let child_id = state.resolve_node(child_handle)?;
        state.mutate_document(|mutator| {
            mutator.append_children(parent_id, &[child_id]);
            Ok(())
        })?;
        state.reconcile_text_controls();
        Ok(())
    }

    /// Return a node's text content.
    pub fn text_content(&self, node_handle: f64) -> Result<String, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_node(node_handle)?;
        state
            .document
            .get_node(node_id)
            .map(blitz_dom::Node::text_content)
            .ok_or_else(|| invalid_node_handle(node_handle))
    }

    /// Return the document title.
    pub fn title(&self) -> Result<String, JsValue> {
        let state = self.state.borrow();
        match state.title_element()? {
            Some(node_id) => state
                .document
                .get_node(node_id)
                .map(blitz_dom::Node::text_content)
                .ok_or_else(|| invalid_internal_node(node_id)),
            None => Ok(String::new()),
        }
    }

    /// Set an element attribute.
    pub fn set_attribute(&self, node_handle: f64, name: &str, value: &str) -> Result<(), JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let ime_before = state.focused_editor_snapshot();
        let editor = if name.eq_ignore_ascii_case("value") {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.take_editor_for_value_attribute_mutation(document, node_id)
        } else {
            None
        };
        let result = state.mutate_document(|mutator| {
            mutator.set_attribute(node_id, attr_name(name), value);
            Ok(())
        });
        restore_text_editor(&mut state.document, node_id, editor);
        result?;
        state.reconcile_text_controls();
        state.reconcile_native_ime_after_editor_mutation(ime_before);
        Ok(())
    }

    /// Return an element attribute, preserving the distinction between absent and empty values.
    pub fn get_attribute(&self, node_handle: f64, name: &str) -> Result<Option<String>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        Ok(attribute_value(&state.document, node_id, name))
    }

    /// Create an element node and return its opaque, non-reused public handle.
    pub fn create_element(&self, tag_name: &str) -> Result<u32, JsValue> {
        let mut state = self.state.borrow_mut();
        let node_id = state.mutate_document(|mutator| {
            Ok(mutator.create_element(html_name(&tag_name.to_ascii_lowercase()), Vec::new()))
        })?;
        state.reconcile_text_controls();
        state.expose_node(node_id)
    }

    /// Replace an element's children by parsing an HTML fragment through Blitz's mutator.
    pub fn set_inner_html(&self, node_handle: f64, html: &str) -> Result<Box<[u32]>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let invalidated_handles = state.invalidate_dropped_descendants(node_id);
        state.mutate_document(|mutator| {
            mutator.set_inner_html(node_id, html);
            Ok(())
        })?;
        state.reconcile_text_controls();
        Ok(invalidated_handles.into_boxed_slice())
    }

    /// Create a text node and return its opaque, non-reused public handle.
    pub fn create_text_node(&self, text: &str) -> Result<u32, JsValue> {
        let mut state = self.state.borrow_mut();
        let node_id = state.mutate_document(|mutator| Ok(mutator.create_text_node(text)))?;
        state.expose_node(node_id)
    }

    /// Return the root `<html>` element's opaque public handle.
    pub fn document_element(&self) -> Result<u32, JsValue> {
        let mut state = self.state.borrow_mut();
        let node_id = state.document.root_element().id;
        state.expose_node(node_id)
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&self, node_handle: f64, name: &str) -> Result<(), JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let ime_before = state.focused_editor_snapshot();
        let editor = if name.eq_ignore_ascii_case("value") {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.take_editor_for_value_attribute_mutation(document, node_id)
        } else {
            None
        };
        let result = state.mutate_document(|mutator| {
            mutator.clear_attribute(node_id, attr_name(name));
            Ok(())
        });
        restore_text_editor(&mut state.document, node_id, editor);
        result?;
        state.reconcile_text_controls();
        state.reconcile_native_ime_after_editor_mutation(ime_before);
        Ok(())
    }

    /// Replace a node's text content.
    pub fn set_text_content(&self, node_handle: f64, value: &str) -> Result<Box<[u32]>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_node(node_handle)?;
        let is_text_node = {
            let node = state
                .document
                .get_node(node_id)
                .ok_or_else(|| invalid_node_handle(node_handle))?;
            matches!(&node.data, NodeData::Text(_))
        };

        let invalidated_handles = if is_text_node {
            Vec::new()
        } else {
            state.invalidate_dropped_descendants(node_id)
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
        })?;
        state.reconcile_text_controls();
        Ok(invalidated_handles.into_boxed_slice())
    }

    /// Replace the first document `<title>` text, creating the element in `<head>` if needed.
    /// Mirrors the HTML spec's `document.title` setter: if there is no `<head>` (e.g. after
    /// `document.head.remove()`), this is a no-op rather than an error.
    pub fn set_title(&self, value: &str) -> Result<Box<[u32]>, JsValue> {
        let mut state = self.state.borrow_mut();
        let Some(head_id) =
            state.optional_child_element_by_tag(state.document.root_element().id, "head")?
        else {
            return Ok(Vec::new().into_boxed_slice());
        };
        let existing_title_id = state.optional_child_element_by_tag(head_id, "title")?;

        let invalidated_handles = existing_title_id
            .map(|title_id| state.invalidate_dropped_descendants(title_id))
            .unwrap_or_default();

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
        })?;
        state.reconcile_text_controls();
        Ok(invalidated_handles.into_boxed_slice())
    }

    /// Return the document `<body>` element's opaque public handle.
    pub fn body(&self) -> Result<u32, JsValue> {
        let mut state = self.state.borrow_mut();
        let node_id = state.child_element_by_tag(state.document.root_element().id, "body")?;
        state.expose_node(node_id)
    }

    /// Return the document `<head>` element's opaque public handle.
    pub fn head(&self) -> Result<u32, JsValue> {
        let mut state = self.state.borrow_mut();
        let node_id = state.child_element_by_tag(state.document.root_element().id, "head")?;
        state.expose_node(node_id)
    }

    /// Return the browser `nodeType` value for a public handle. The TypeScript facade uses this
    /// to select the correct cached wrapper class for hit-test and event targets.
    pub fn node_kind(&self, node_handle: f64) -> Result<u8, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_node(node_handle)?;
        Ok(state.node_kind(node_id))
    }

    /// Identify the browser wrapper class for an element without exposing Blitz's raw node id.
    pub fn element_interface(&self, node_handle: f64) -> Result<u8, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let element = state
            .document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .ok_or_else(|| invalid_element(node_handle))?;
        if element.name.ns != ns!(html) {
            return Ok(ELEMENT_INTERFACE_GENERIC);
        }
        let local_name = element.name.local.as_ref();
        Ok(match local_name {
            "input" => ELEMENT_INTERFACE_INPUT,
            "textarea" => ELEMENT_INTERFACE_TEXTAREA,
            _ => ELEMENT_INTERFACE_GENERIC,
        })
    }

    /// Read the live value of a rendered text-like form control, including active composition.
    pub fn form_control_value(&self, node_handle: f64) -> Result<String, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let QuoxRendererState {
            document,
            text_controls,
            ..
        } = &mut *state;
        text_controls
            .value(document, node_id)
            .ok_or_else(|| invalid_text_control(node_handle))
    }

    /// Set a live value without dispatching an event. Returns whether the value changed.
    pub fn set_form_control_value(&self, node_handle: f64, value: &str) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let ime_before = state.focused_editor_snapshot();
        let changed = {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls
                .set_value(document, node_id, value)
                .ok_or_else(|| invalid_text_control(node_handle))?
        };
        state.reconcile_native_ime_after_editor_mutation(ime_before);
        Ok(changed)
    }

    /// Return a target-first propagation path for a synthetic event dispatched on a DOM node.
    /// A trailing zero marks the document; TypeScript replaces it with the document and window
    /// objects, neither of which has a numeric node handle.
    pub fn synthetic_event_path(&self, node_handle: f64) -> Result<Box<[u32]>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let target_id = state.resolve_node(node_handle)?;
        let (node_ids, connected) = synthetic_event_node_path(&state.document, target_id);
        let mut path = Vec::with_capacity(node_ids.len() + usize::from(connected));
        for node_id in node_ids {
            path.push(state.expose_node(node_id)?);
        }
        if connected {
            path.push(0);
        }
        Ok(path.into_boxed_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::{attr_name, attribute_value, dropped_descendant_ids, synthetic_event_node_path};
    use crate::node_handles::NodeHandles;
    use blitz_dom::{DocumentConfig, NodeData};
    use blitz_html::{HtmlDocument, HtmlProvider};
    use std::sync::Arc;

    fn element_by_tag(document: &blitz_dom::BaseDocument, tag_name: &str) -> usize {
        document
            .tree()
            .iter()
            .find_map(|(node_id, node)| {
                node.element_data()
                    .is_some_and(|element| element.name.local.as_ref() == tag_name)
                    .then_some(node_id)
            })
            .unwrap_or_else(|| panic!("test document should contain <{tag_name}>"))
    }

    #[test]
    fn invalidates_dropped_descendants_before_blitz_reuses_their_raw_ids() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><section><span>old</span></section></body></html>",
            DocumentConfig {
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..DocumentConfig::default()
            },
        )
        .into_inner();
        let body_id = element_by_tag(&document, "body");
        let old_section_id = element_by_tag(&document, "section");
        let old_span_id = element_by_tag(&document, "span");
        let mut handles = NodeHandles::default();

        let dropped = dropped_descendant_ids(&document, body_id);
        assert!(dropped.contains(&old_section_id));
        assert!(dropped.contains(&old_span_id));
        let old_handles = dropped
            .iter()
            .map(|node_id| {
                (
                    *node_id,
                    handles.expose(*node_id).expect("old handle should fit"),
                )
            })
            .collect::<Vec<_>>();
        let invalidated_handles = handles.invalidate_nodes(dropped.iter().copied());
        assert_eq!(invalidated_handles.len(), dropped.len());
        document
            .mutate()
            .set_inner_html(body_id, "<section>replacement</section>");

        let replacement_id = element_by_tag(&document, "section");
        assert!(
            dropped.contains(&replacement_id),
            "Blitz should reuse one of the freed descendant slab ids"
        );
        let stale_handle_for_reused_id = old_handles
            .iter()
            .find_map(|(node_id, handle)| (*node_id == replacement_id).then_some(*handle))
            .expect("the reused id should have had an old public handle");
        let replacement_handle = handles
            .expose(replacement_id)
            .expect("replacement handle should fit");

        assert_ne!(replacement_handle, stale_handle_for_reused_id);
        for (_, old_handle) in old_handles {
            assert_eq!(handles.resolve(old_handle), None);
        }
        assert_eq!(handles.resolve(replacement_handle), Some(replacement_id));
    }

    #[test]
    fn detaching_and_reattaching_a_node_preserves_its_handle() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><p>retained</p></body></html>",
            DocumentConfig::default(),
        )
        .into_inner();
        let body_id = element_by_tag(&document, "body");
        let paragraph_id = element_by_tag(&document, "p");
        assert!(matches!(
            document.get_node(paragraph_id).map(|node| &node.data),
            Some(NodeData::Element(_))
        ));
        let mut handles = NodeHandles::default();
        let handle = handles.expose(paragraph_id).expect("handle should fit");

        document.mutate().remove_node(paragraph_id);
        assert!(document.get_node(paragraph_id).is_some());
        assert_eq!(handles.expose(paragraph_id), Ok(handle));

        document.mutate().append_children(body_id, &[paragraph_id]);
        assert_eq!(handles.expose(paragraph_id), Ok(handle));
    }

    #[test]
    fn synthetic_event_paths_distinguish_connected_and_detached_nodes() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><section><span>target</span></section></body></html>",
            DocumentConfig::default(),
        )
        .into_inner();
        let html_id = element_by_tag(&document, "html");
        let body_id = element_by_tag(&document, "body");
        let section_id = element_by_tag(&document, "section");
        let span_id = element_by_tag(&document, "span");

        assert_eq!(
            synthetic_event_node_path(&document, span_id),
            (vec![span_id, section_id, body_id, html_id], true)
        );

        document.mutate().remove_node(section_id);
        assert_eq!(
            synthetic_event_node_path(&document, span_id),
            (vec![span_id, section_id], false)
        );

        document.mutate().append_children(body_id, &[section_id]);
        assert_eq!(
            synthetic_event_node_path(&document, span_id),
            (vec![span_id, section_id, body_id, html_id], true)
        );
    }

    #[test]
    fn html_attribute_names_are_case_insensitive_without_losing_empty_values() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><div data-empty=\"\"></div></body></html>",
            DocumentConfig::default(),
        )
        .into_inner();
        let div_id = element_by_tag(&document, "div");

        assert_eq!(
            attribute_value(&document, div_id, "DATA-EMPTY"),
            Some(String::new())
        );
        assert_eq!(attribute_value(&document, div_id, "data-missing"), None);

        document
            .mutate()
            .set_attribute(div_id, attr_name("DaTa-LaBeL"), "present");
        assert_eq!(
            attribute_value(&document, div_id, "data-label"),
            Some("present".into())
        );

        document
            .mutate()
            .clear_attribute(div_id, attr_name("DATA-LABEL"));
        assert_eq!(attribute_value(&document, div_id, "data-label"), None);
    }
}
