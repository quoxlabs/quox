use super::{QuoxRenderer, QuoxRendererState};
use crate::ffi_numbers::{NumericArgumentError, integer_range, uint32};
use crate::form_controls::{TextControlSelectionDirection, restore_text_editor};
use blitz_dom::{BaseDocument, DocumentMutator, LocalName, NodeData, Point, QualName, ns};
use style::computed_values::visibility::T as Visibility;
use style::values::computed::Overflow;
use style::values::specified::box_::DisplayInside;
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

fn unsupported_form_control_value(node_handle: u32) -> JsValue {
    js_sys::TypeError::new(&format!(
        "DOM node handle does not identify a supported form-control value: {node_handle}"
    ))
    .into()
}

fn unsupported_input_checkedness(node_handle: u32) -> JsValue {
    js_sys::TypeError::new(&format!(
        "DOM node handle does not identify an HTML input: {node_handle}"
    ))
    .into()
}

fn selection_offset(value: usize) -> Result<u32, JsValue> {
    u32::try_from(value).map_err(|_| {
        js_sys::RangeError::new("quox: text-control selection offset exceeds unsigned long").into()
    })
}

fn selection_index(value: u32) -> Result<usize, JsValue> {
    usize::try_from(value).map_err(|_| {
        js_sys::RangeError::new("quox: text-control selection offset exceeds target usize").into()
    })
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

/// Return the connected element which actually owns DOM focus. Blitz reports the document
/// element when no node is focused, so the focus bit is part of the distinction.
pub(super) fn actual_focus_node_id(document: &BaseDocument) -> Option<usize> {
    retained_focus_node_id(document).filter(|target| {
        document
            .get_node(*target)
            .is_some_and(|node| node.flags.is_in_document())
    })
}

fn is_disabled_by_fieldset(document: &BaseDocument, target_id: usize) -> bool {
    let mut ancestor_id = document.get_node(target_id).and_then(|node| node.parent);
    while let Some(current_id) = ancestor_id {
        let Some(current) = document.get_node(current_id) else {
            return false;
        };
        if current.element_data().is_some_and(|element| {
            element.name.ns == ns!(html)
                && element.name.local.as_ref() == "fieldset"
                && element.has_attr(LocalName::from("disabled"))
        }) {
            let first_legend = current.children.iter().copied().find(|child_id| {
                document.get_node(*child_id).is_some_and(|child| {
                    child.element_data().is_some_and(|element| {
                        element.name.ns == ns!(html) && element.name.local.as_ref() == "legend"
                    })
                })
            });
            if !first_legend
                .is_some_and(|legend_id| subtree_contains_node(document, legend_id, target_id))
            {
                return true;
            }
        }
        ancestor_id = current.parent;
    }
    false
}

fn is_disabled_form_control(document: &BaseDocument, node_id: usize) -> bool {
    document.get_node(node_id).is_some_and(|node| {
        node.element_data().is_some_and(|element| {
            element.name.ns == ns!(html)
                && matches!(
                    element.name.local.as_ref(),
                    "button" | "input" | "select" | "textarea"
                )
                && (element.has_attr(LocalName::from("disabled"))
                    || is_disabled_by_fieldset(document, node_id))
        })
    })
}

fn nearest_ancestor_select(document: &BaseDocument, node_id: usize) -> Option<usize> {
    let mut ancestor_id = document.get_node(node_id).and_then(|node| node.parent);
    let mut saw_optgroup = false;
    while let Some(current_id) = ancestor_id {
        let current = document.get_node(current_id)?;
        if let Some(element) = current
            .element_data()
            .filter(|element| element.name.ns == ns!(html))
        {
            match element.name.local.as_ref() {
                "datalist" | "hr" | "option" => return None,
                "optgroup" if saw_optgroup => return None,
                "optgroup" => saw_optgroup = true,
                "select" => return Some(current_id),
                _ => {}
            }
        }
        ancestor_id = current.parent;
    }
    None
}

fn option_is_disabled(document: &BaseDocument, node_id: usize) -> bool {
    let Some(option) = document
        .get_node(node_id)
        .and_then(blitz_dom::Node::element_data)
    else {
        return false;
    };
    if option.has_attr(LocalName::from("disabled")) {
        return true;
    }

    let mut ancestor_id = document.get_node(node_id).and_then(|node| node.parent);
    while let Some(current_id) = ancestor_id {
        let Some(current) = document.get_node(current_id) else {
            return false;
        };
        if let Some(element) = current
            .element_data()
            .filter(|element| element.name.ns == ns!(html))
        {
            match element.name.local.as_ref() {
                "select" | "hr" | "datalist" | "option" => return false,
                "optgroup" => return element.has_attr(LocalName::from("disabled")),
                _ => {}
            }
        }
        ancestor_id = current.parent;
    }
    false
}

fn is_html_actually_disabled(document: &BaseDocument, node_id: usize) -> bool {
    let Some(element) = document
        .get_node(node_id)
        .and_then(blitz_dom::Node::element_data)
    else {
        return false;
    };
    if element.name.ns != ns!(html) {
        return false;
    }

    match element.name.local.as_ref() {
        "button" | "input" | "select" | "textarea" => is_disabled_form_control(document, node_id),
        "fieldset" => element.has_attr(LocalName::from("disabled")),
        "optgroup" => {
            element.has_attr(LocalName::from("disabled"))
                || nearest_ancestor_select(document, node_id)
                    .is_some_and(|select_id| is_disabled_form_control(document, select_id))
        }
        "option" => {
            option_is_disabled(document, node_id)
                || nearest_ancestor_select(document, node_id)
                    .is_some_and(|select_id| is_disabled_form_control(document, select_id))
        }
        _ => false,
    }
}

/// Return whether an element can receive focus through the DOM `focus()` method. Blitz's cached
/// focusability deliberately models sequential focus navigation, so an explicit negative
/// `tabindex` needs a separate programmatic-focus path.
pub(super) fn is_programmatically_focusable(document: &BaseDocument, node_id: usize) -> bool {
    let Some(node) = document.get_node(node_id) else {
        return false;
    };
    let Some(element) = node.element_data() else {
        return false;
    };
    if !node.flags.is_in_document()
        || is_html_actually_disabled(document, node_id)
        || (element.name.ns == ns!(html)
            && element.name.local.as_ref() == "input"
            && element
                .attr(LocalName::from("type"))
                .is_some_and(|value| value.eq_ignore_ascii_case("hidden")))
    {
        return false;
    }
    if node.primary_styles().is_some_and(|style| {
        matches!(
            style.clone_visibility(),
            Visibility::Hidden | Visibility::Collapse
        )
    }) {
        return false;
    }

    // `inert` and display suppression on an ancestor also remove the target from the focusable
    // areas. Style has been resolved by the public focus entry point before this check runs.
    let mut ancestor_id = Some(node_id);
    while let Some(current_id) = ancestor_id {
        let Some(current) = document.get_node(current_id) else {
            return false;
        };
        if current
            .element_data()
            .is_some_and(|ancestor| ancestor.has_attr(LocalName::from("inert")))
            || current
                .primary_styles()
                .is_some_and(|style| style.clone_display().is_none())
        {
            return false;
        }
        ancestor_id = current.parent;
    }

    node.is_focussable()
        || element
            .attr(LocalName::from("tabindex"))
            .and_then(|value| value.trim().parse::<i32>().ok())
            .is_some()
}

/// Return Blitz's retained focus owner even if a previous tree mutation disconnected it. The
/// focus bit distinguishes a real owner from Blitz's document-element keyboard-target fallback.
fn retained_focus_node_id(document: &BaseDocument) -> Option<usize> {
    document.get_focussed_node_id().filter(|target| {
        document
            .get_node(*target)
            .is_some_and(|node| node.element_data().is_some() && node.is_focussed())
    })
}

fn subtree_contains_node(document: &BaseDocument, root_id: usize, mut node_id: usize) -> bool {
    loop {
        if node_id == root_id {
            return true;
        }
        let Some(parent_id) = document.get_node(node_id).and_then(|node| node.parent) else {
            return false;
        };
        node_id = parent_id;
    }
}

/// Synchronize the live editor and clear Blitz's retained focus before a subtree leaves its
/// current position. `BaseDocument::clear_focus` updates internal focus/IME state but does not
/// synthesize DOM blur or focusout events, matching browser removal behavior.
fn clear_retained_focus_in_subtree(
    document: &mut BaseDocument,
    text_controls: &mut crate::form_controls::TextControlStates,
    root_id: usize,
) -> bool {
    let Some(focus_id) = retained_focus_node_id(document) else {
        return false;
    };
    if !subtree_contains_node(document, root_id, focus_id) {
        return false;
    }

    text_controls.sync_editor_value(document, focus_id);
    document.clear_focus();
    true
}

fn clear_retained_focus_in_descendants(
    document: &mut BaseDocument,
    text_controls: &mut crate::form_controls::TextControlStates,
    parent_id: usize,
) -> bool {
    let Some(focus_id) = retained_focus_node_id(document) else {
        return false;
    };
    if focus_id == parent_id || !subtree_contains_node(document, parent_id, focus_id) {
        return false;
    }

    text_controls.sync_editor_value(document, focus_id);
    document.clear_focus();
    true
}

/// Resolve `Document.activeElement`, including the HTML fallback used when no element owns
/// focus: a connected body, then the connected document element, then no element.
fn active_element_node_id(document: &BaseDocument) -> Option<usize> {
    if let Some(node_id) = actual_focus_node_id(document) {
        return Some(node_id);
    }

    let root = document.try_root_element()?;
    let root_id = root.id;
    if root.element_data().is_none() || !root.flags.is_in_document() {
        return None;
    }

    root.children
        .iter()
        .copied()
        .find(|child_id| {
            document.get_node(*child_id).is_some_and(|child| {
                child.flags.is_in_document()
                    && child.element_data().is_some_and(|element| {
                        element.name.ns == ns!(html)
                            && matches!(element.name.local.as_ref(), "body" | "frameset")
                    })
            })
        })
        .or(Some(root_id))
}

#[derive(Clone, Copy)]
enum ScrollAxis {
    Horizontal,
    Vertical,
}

fn normalize_scroll_offset(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

fn has_layout_box(document: &BaseDocument, node_id: usize) -> bool {
    let Some(node) = document.get_node(node_id) else {
        return false;
    };
    if node.element_data().is_none() || !node.flags.is_in_document() {
        return false;
    }

    // A connected descendant of `display:none` has no associated CSS box even if Blitz retains
    // its previous layout values. Layout has already been resolved before public callers arrive.
    let mut current_id = Some(node_id);
    while let Some(id) = current_id {
        let Some(current) = document.get_node(id) else {
            return false;
        };
        if current.element_data().is_some() {
            let Some(style) = current.primary_styles() else {
                return false;
            };
            let display = style.clone_display();
            if display.is_none() || (id == node_id && display.inside() == DisplayInside::Contents) {
                return false;
            }
        }
        current_id = current.parent;
    }

    true
}

fn finite_scroll_limit(value: f32) -> f64 {
    let value = f64::from(value);
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

fn body_overflow_propagates_to_viewport(document: &BaseDocument, node_id: usize) -> bool {
    let Some(body) = document.get_node(node_id) else {
        return false;
    };
    let Some(body_element) = body.element_data() else {
        return false;
    };
    let Some(root) = document.try_root_element() else {
        return false;
    };
    let Some(root_element) = root.element_data() else {
        return false;
    };
    if body.parent != Some(root.id)
        || body_element.name.ns != ns!(html)
        || body_element.name.local.as_ref() != "body"
        || root_element.name.ns != ns!(html)
        || root_element.name.local.as_ref() != "html"
    {
        return false;
    }

    let Some(body_style) = body.primary_styles() else {
        return false;
    };
    let Some(root_style) = root.primary_styles() else {
        return false;
    };
    if !body_style.clone_contain().is_empty() || !root_style.clone_contain().is_empty() {
        return false;
    }
    if root_style.clone_overflow_x() != Overflow::Visible
        || root_style.clone_overflow_y() != Overflow::Visible
    {
        return false;
    }

    // HTML propagates only the first direct body child whose display is not none.
    root.children.iter().copied().find(|child_id| {
        document.get_node(*child_id).is_some_and(|child| {
            child.element_data().is_some_and(|element| {
                element.name.ns == ns!(html) && element.name.local.as_ref() == "body"
            }) && child
                .primary_styles()
                .is_some_and(|style| !style.clone_display().is_none())
        })
    }) == Some(node_id)
}

fn element_scroll_limits(document: &BaseDocument, node_id: usize) -> Point<f64> {
    let Some(node) = document
        .get_node(node_id)
        .filter(|_| has_layout_box(document, node_id))
    else {
        return Point::ZERO;
    };
    if body_overflow_propagates_to_viewport(document, node_id) {
        return Point::ZERO;
    }

    Point {
        x: if node.style.overflow.x.is_scroll_container() {
            finite_scroll_limit(node.final_layout.scroll_width())
        } else {
            0.0
        },
        y: if node.style.overflow.y.is_scroll_container() {
            finite_scroll_limit(node.final_layout.scroll_height())
        } else {
            0.0
        },
    }
}

fn clamp_scroll_offsets(offsets: Point<f64>, limits: Point<f64>) -> Point<f64> {
    Point {
        x: normalize_scroll_offset(offsets.x).clamp(0.0, limits.x),
        y: normalize_scroll_offset(offsets.y).clamp(0.0, limits.y),
    }
}

/// Return the live CSS-pixel scroll offsets for an element. In Quox's standards-mode document,
/// the root element reflects the viewport; all other elements retain their own Blitz offset.
fn element_scroll_offsets(document: &mut BaseDocument, node_id: usize) -> Point<f64> {
    if document
        .try_root_element()
        .is_some_and(|root| root.id == node_id)
    {
        // `set_viewport_scroll` itself does not clamp, and layout may have changed the range since
        // the last viewport update. A zero delta applies Blitz's current viewport bounds.
        document.scroll_viewport_by(0.0, 0.0);
        return document.viewport_scroll();
    }

    let limits = element_scroll_limits(document, node_id);
    let offsets = document
        .get_node(node_id)
        .map_or(Point::ZERO, |node| node.scroll_offset);
    let clamped = clamp_scroll_offsets(offsets, limits);
    if let Some(node) = document.get_node_mut(node_id) {
        // Blitz does not re-clamp element offsets when layout removes overflow. Correct retained
        // values while servicing this layout-flushing CSSOM getter/setter.
        node.scroll_offset = clamped;
    }
    clamped
}

fn set_element_scroll_offset(
    document: &mut BaseDocument,
    node_id: usize,
    axis: ScrollAxis,
    value: f64,
) -> bool {
    let current = element_scroll_offsets(document, node_id);
    let mut requested = current;
    let value = normalize_scroll_offset(value);
    match axis {
        ScrollAxis::Horizontal => requested.x = value,
        ScrollAxis::Vertical => requested.y = value,
    }

    if document
        .try_root_element()
        .is_some_and(|root| root.id == node_id)
    {
        document.set_viewport_scroll(requested);
        document.scroll_viewport_by(0.0, 0.0);
        return document.viewport_scroll() != current;
    }

    let requested = clamp_scroll_offsets(requested, element_scroll_limits(document, node_id));
    if let Some(node) = document.get_node_mut(node_id) {
        node.scroll_offset = requested;
    }
    requested != current
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

    pub(super) fn resolve_element(&mut self, node_handle: u32) -> Result<usize, JsValue> {
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
        self.clear_focus_in_descendants(parent_id);
        let dropped = dropped_descendant_ids(&self.document, parent_id);
        self.text_controls.invalidate_nodes(dropped.iter().copied());
        self.checked_controls
            .invalidate_nodes(dropped.iter().copied());
        self.node_handles.invalidate_nodes(dropped)
    }

    fn clear_focus_in_subtree(&mut self, root_id: usize) {
        let ime_before = self.focused_editor_snapshot();
        let cleared =
            clear_retained_focus_in_subtree(&mut self.document, &mut self.text_controls, root_id);
        if cleared {
            // Blitz's shell callback already publishes this edge for ordinary text controls. The
            // snapshot reconciliation also covers retained editor states which Blitz cannot see.
            self.reconcile_native_ime_after_editor_mutation(ime_before);
        }
    }

    fn clear_focus_in_descendants(&mut self, parent_id: usize) {
        let ime_before = self.focused_editor_snapshot();
        let cleared = clear_retained_focus_in_descendants(
            &mut self.document,
            &mut self.text_controls,
            parent_id,
        );
        if cleared {
            self.reconcile_native_ime_after_editor_mutation(ime_before);
        }
    }

    fn reconcile_form_controls(&mut self) {
        self.text_controls.reconcile_document(&mut self.document);
        self.checked_controls.reconcile_document(&mut self.document);
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
        state.clear_focus_in_subtree(node_id);
        state.mutate_document(|mutator| {
            mutator.remove_node(node_id);
            Ok(())
        })?;
        state.reconcile_form_controls();
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
        // appendChild reparents through a removal, even when both parents are connected. Like a
        // browser's ordinary appendChild (as opposed to state-preserving moveBefore), that loses
        // focus before the node is inserted at its new position.
        state.clear_focus_in_subtree(child_id);
        state.mutate_document(|mutator| {
            mutator.append_children(parent_id, &[child_id]);
            Ok(())
        })?;
        state.reconcile_form_controls();
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
        {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.note_range_constraint_attribute_mutation(document, node_id, name);
        }
        state.reconcile_form_controls();
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
        state.reconcile_form_controls();
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
        state.reconcile_form_controls();
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

    /// Return the active element, applying the browser body/document-element fallback when no
    /// connected element actually owns focus.
    pub fn active_element(&self) -> Result<Option<u32>, JsValue> {
        let mut state = self.state.borrow_mut();
        active_element_node_id(&state.document)
            .map(|node_id| state.expose_node(node_id))
            .transpose()
    }

    /// Return an element's live horizontal scroll offset in logical CSS pixels. The root element
    /// reflects document viewport scrolling in Quox's standards-mode HTML document.
    pub fn element_scroll_left(&self, node_handle: f64) -> Result<f64, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        state.sync_layout();
        Ok(element_scroll_offsets(&mut state.document, node_id).x)
    }

    /// Return an element's live vertical scroll offset in logical CSS pixels.
    pub fn element_scroll_top(&self, node_handle: f64) -> Result<f64, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        state.sync_layout();
        Ok(element_scroll_offsets(&mut state.document, node_id).y)
    }

    /// Set an element's absolute horizontal scroll offset, returning whether its effective
    /// position changed. Non-finite values follow CSSOM View and normalize to zero.
    pub fn set_element_scroll_left(&self, node_handle: f64, value: f64) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        state.sync_layout();
        Ok(set_element_scroll_offset(
            &mut state.document,
            node_id,
            ScrollAxis::Horizontal,
            value,
        ))
    }

    /// Set an element's absolute vertical scroll offset, returning whether its effective
    /// position changed. Non-finite values follow CSSOM View and normalize to zero.
    pub fn set_element_scroll_top(&self, node_handle: f64, value: f64) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        state.sync_layout();
        Ok(set_element_scroll_offset(
            &mut state.document,
            node_id,
            ScrollAxis::Vertical,
            value,
        ))
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&self, node_handle: f64, name: &str) -> Result<(), JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let had_attribute = attribute_value(&state.document, node_id, name).is_some();
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
        if had_attribute {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.note_range_constraint_attribute_mutation(document, node_id, name);
        }
        state.reconcile_form_controls();
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
        state.reconcile_form_controls();
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
        state.reconcile_form_controls();
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

    /// Read a supported live form-control value, including active text composition.
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
            .ok_or_else(|| unsupported_form_control_value(node_handle))
    }

    /// Set a supported form-control value without dispatching an event.
    /// Returns whether its rendered or attribute state changed.
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
                .ok_or_else(|| unsupported_form_control_value(node_handle))?
        };
        state.reconcile_native_ime_after_editor_mutation(ime_before);
        Ok(changed)
    }

    /// Return the current checkedness of an HTML input, including states whose current type does
    /// not render a checkbox. Checkedness is retained across later type transitions.
    pub fn form_control_checked(&self, node_handle: f64) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let QuoxRendererState {
            document,
            checked_controls,
            ..
        } = &mut *state;
        checked_controls
            .checked(document, node_id)
            .ok_or_else(|| unsupported_input_checkedness(node_handle))
    }

    /// Set script checkedness without dispatching `input`, `change`, or `click`. The result only
    /// reports a renderer-visible change; an identical assignment still makes checkedness dirty.
    pub fn set_form_control_checked(
        &self,
        node_handle: f64,
        checked: bool,
    ) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let QuoxRendererState {
            document,
            checked_controls,
            ..
        } = &mut *state;
        checked_controls
            .set_checked(document, node_id, checked)
            .ok_or_else(|| unsupported_input_checkedness(node_handle))
    }

    /// Return `[selectionStart, selectionEnd, direction]` for a selectable text control. Input
    /// states to which HTML's range APIs do not apply return `undefined` at the JS boundary.
    pub fn form_control_selection(&self, node_handle: f64) -> Result<Option<Box<[u32]>>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let selection = {
            let QuoxRendererState {
                document,
                text_controls,
                ..
            } = &mut *state;
            text_controls.selection(document, node_id)
        };
        let Some(selection) = selection else {
            return Ok(None);
        };
        Ok(Some(
            [
                selection_offset(selection.start)?,
                selection_offset(selection.end)?,
                selection.direction.wire_value(),
            ]
            .into(),
        ))
    }

    /// Set a selectable control's UTF-16 range and return whether its extent or direction changed.
    /// `undefined` tells the browser wrapper to throw `InvalidStateError` for this input state.
    pub fn set_form_control_selection(
        &self,
        node_handle: f64,
        start: f64,
        end: f64,
        direction: f64,
    ) -> Result<Option<bool>, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let start = uint32(start, "selectionStart").map_err(NumericArgumentError::into_js)?;
        let end = uint32(end, "selectionEnd").map_err(NumericArgumentError::into_js)?;
        let direction = integer_range(direction, 0, 2, "selectionDirection")
            .map_err(NumericArgumentError::into_js)?;
        let direction =
            TextControlSelectionDirection::from_wire_value(direction).ok_or_else(|| {
                js_sys::RangeError::new("quox: unknown text-control selection direction")
            })?;
        let start = selection_index(start)?;
        let end = selection_index(end)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let QuoxRendererState {
            document,
            text_controls,
            ..
        } = &mut *state;
        Ok(text_controls.set_selection_range(document, node_id, start, end, direction))
    }

    /// Select every character in a control whose current rendered UI exposes selectable text.
    /// Unsupported and button-like controls follow HTML by ignoring the call.
    pub fn select_form_control_text(&self, node_handle: f64) -> Result<bool, JsValue> {
        let node_handle =
            uint32(node_handle, "nodeHandle").map_err(NumericArgumentError::into_js)?;
        let mut state = self.state.borrow_mut();
        let node_id = state.resolve_element(node_handle)?;
        let QuoxRendererState {
            document,
            text_controls,
            ..
        } = &mut *state;
        Ok(text_controls.select_all(document, node_id))
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
    use super::{
        ScrollAxis, active_element_node_id, actual_focus_node_id, attr_name, attribute_value,
        clear_retained_focus_in_descendants, clear_retained_focus_in_subtree,
        dropped_descendant_ids, element_scroll_limits, element_scroll_offsets,
        retained_focus_node_id, set_element_scroll_offset, synthetic_event_node_path,
    };
    use crate::form_controls::TextControlStates;
    use crate::node_handles::NodeHandles;
    use crate::{IME_REQUEST_ENABLED, ImeRequestMailbox, QuoxShellProvider};
    use blitz_dom::{DocumentConfig, NodeData};
    use blitz_html::{HtmlDocument, HtmlProvider};
    use blitz_traits::shell::{ColorScheme, Viewport};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

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

    fn element_by_id(document: &blitz_dom::BaseDocument, id: &str) -> usize {
        document
            .tree()
            .iter()
            .find_map(|(node_id, node)| {
                node.element_data()
                    .is_some_and(|element| {
                        element.attr(blitz_dom::LocalName::from("id")) == Some(id)
                    })
                    .then_some(node_id)
            })
            .unwrap_or_else(|| panic!("test document should contain #{id}"))
    }

    fn ime_document(body: &str) -> (blitz_dom::BaseDocument, Arc<ImeRequestMailbox>) {
        let ime_requests = Arc::new(ImeRequestMailbox::default());
        let document = HtmlDocument::from_html(
            &format!("<!doctype html><html><body>{body}</body></html>"),
            DocumentConfig {
                shell_provider: Some(Arc::new(QuoxShellProvider {
                    redraw_requested: Arc::new(AtomicBool::new(false)),
                    ime_requests: Arc::clone(&ime_requests),
                })),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..DocumentConfig::default()
            },
        )
        .into_inner();
        (document, ime_requests)
    }

    fn layout_document(body: &str, width: u32, height: u32) -> blitz_dom::BaseDocument {
        let mut document = HtmlDocument::from_html(
            &format!("<!doctype html><html><body>{body}</body></html>"),
            DocumentConfig {
                viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..DocumentConfig::default()
            },
        )
        .into_inner();
        document.resolve(0.0);
        document
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "IME wire revisions are exactly represented u32 values"
    )]
    fn acknowledge_ime_request(ime_requests: &ImeRequestMailbox) -> [f64; 7] {
        let snapshot = ime_requests
            .peek_snapshot()
            .expect("IME request peek should succeed")
            .expect("an IME request should be pending");
        ime_requests
            .acknowledge_snapshot(snapshot[0] as u32)
            .expect("IME request acknowledgment should succeed");
        snapshot
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
    fn active_element_requires_connected_focus_and_uses_html_fallbacks() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><input></body></html>",
            DocumentConfig::default(),
        )
        .into_inner();
        let html_id = element_by_tag(&document, "html");
        let body_id = element_by_tag(&document, "body");
        let input_id = element_by_tag(&document, "input");

        // Blitz reports the document element when focus is absent. That is only the
        // activeElement fallback; it is not actual element focus.
        assert_eq!(document.get_focussed_node_id(), Some(html_id));
        assert_eq!(actual_focus_node_id(&document), None);
        assert_eq!(active_element_node_id(&document), Some(body_id));

        assert!(document.set_focus_to(input_id));
        assert_eq!(actual_focus_node_id(&document), Some(input_id));
        assert_eq!(active_element_node_id(&document), Some(input_id));

        // A detached node can retain Blitz's focus bit until mutation handling clears it. Do
        // not expose that stale state through the DOM API.
        document.mutate().remove_node(input_id);
        assert!(
            document
                .get_node(input_id)
                .is_some_and(blitz_dom::Node::is_focussed)
        );
        assert_eq!(actual_focus_node_id(&document), None);
        assert_eq!(active_element_node_id(&document), Some(body_id));

        document.mutate().remove_node(body_id);
        assert_eq!(active_element_node_id(&document), Some(html_id));

        document.mutate().remove_node(html_id);
        assert_eq!(active_element_node_id(&document), None);

        let frameset_document = HtmlDocument::from_html(
            "<!doctype html><html><frameset><frame></frameset></html>",
            DocumentConfig::default(),
        )
        .into_inner();
        let frameset_id = element_by_tag(&frameset_document, "frameset");
        assert_eq!(
            active_element_node_id(&frameset_document),
            Some(frameset_id)
        );
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "one shared layout fixture covers every supported overflow mode and native updates"
    )]
    fn element_scroll_offsets_are_live_fractional_and_cssom_clamped() {
        let mut document = layout_document(
            "<div id='auto' style='overflow:auto;width:100px;height:80px'>\
               <div id='auto-content' style='width:300px;height:240px'></div>\
             </div>\
             <div id='hidden' style='overflow:hidden;width:100px;height:80px'>\
               <div style='width:300px;height:240px'></div>\
             </div>\
             <div id='scroll' style='overflow:scroll;width:100px;height:80px'>\
               <div style='width:300px;height:240px'></div>\
             </div>\
             <div id='visible' style='overflow:visible;width:100px;height:80px'>\
               <div style='width:300px;height:240px'></div>\
             </div>\
             <div id='clip' style='overflow:clip;width:100px;height:80px'>\
               <div style='width:300px;height:240px'></div>\
             </div>",
            800,
            600,
        );
        let auto = element_by_id(&document, "auto");

        let limits = element_scroll_limits(&document, auto);
        assert!(limits.x > 100.0);
        assert!(limits.y > 100.0);
        assert!(set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Horizontal,
            25.5,
        ));
        assert!(set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Vertical,
            30.25,
        ));
        assert_eq!(
            element_scroll_offsets(&mut document, auto),
            blitz_dom::Point { x: 25.5, y: 30.25 }
        );
        assert!(!set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Vertical,
            30.25,
        ));

        assert!(set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Horizontal,
            f64::MAX,
        ));
        assert_eq!(element_scroll_offsets(&mut document, auto).x, limits.x);
        assert!(set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Horizontal,
            -1.0,
        ));
        assert_eq!(element_scroll_offsets(&mut document, auto).x, 0.0);

        assert!(set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Vertical,
            f64::INFINITY,
        ));
        assert_eq!(element_scroll_offsets(&mut document, auto).y, 0.0);
        assert!(!set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Vertical,
            f64::NAN,
        ));
        assert!(!set_element_scroll_offset(
            &mut document,
            auto,
            ScrollAxis::Vertical,
            f64::NEG_INFINITY,
        ));

        // Blitz's wheel default uses this primitive. The public getter must observe its retained
        // offset directly rather than a Quox-side mirror.
        assert!(document.scroll_node_by_has_changed(auto, -9.5, -11.75, |_| {}));
        assert_eq!(
            element_scroll_offsets(&mut document, auto),
            blitz_dom::Point { x: 9.5, y: 11.75 }
        );

        for id in ["hidden", "scroll"] {
            let node_id = element_by_id(&document, id);
            assert!(set_element_scroll_offset(
                &mut document,
                node_id,
                ScrollAxis::Vertical,
                17.5,
            ));
            assert_eq!(element_scroll_offsets(&mut document, node_id).y, 17.5);
        }

        for id in ["visible", "clip"] {
            let node_id = element_by_id(&document, id);
            assert!(!set_element_scroll_offset(
                &mut document,
                node_id,
                ScrollAxis::Vertical,
                17.5,
            ));
            assert_eq!(element_scroll_offsets(&mut document, node_id).y, 0.0);
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "zero is the exact CSSOM result for elements without a scrolling box"
    )]
    fn element_scroll_offsets_reclamp_for_layout_and_connectivity_changes() {
        let mut document = layout_document(
            "<div id='host'>\
               <div id='scroller' style='overflow:auto;width:100px;height:80px'>\
                 <div id='content' style='width:300px;height:240px'></div>\
               </div>\
             </div>\
             <div id='none' style='display:none;overflow:scroll;width:100px;height:80px'>\
               <div style='width:300px;height:240px'></div>\
             </div>",
            800,
            600,
        );
        let body = element_by_tag(&document, "body");
        let host = element_by_id(&document, "host");
        let scroller = element_by_id(&document, "scroller");
        let content = element_by_id(&document, "content");
        let none = element_by_id(&document, "none");

        assert!(set_element_scroll_offset(
            &mut document,
            scroller,
            ScrollAxis::Vertical,
            90.0,
        ));
        document
            .mutate()
            .set_attribute(content, attr_name("style"), "width:50px;height:40px");
        document.resolve(0.0);
        assert_eq!(element_scroll_offsets(&mut document, scroller).y, 0.0);
        assert_eq!(document.get_node(scroller).unwrap().scroll_offset.y, 0.0);

        assert!(!set_element_scroll_offset(
            &mut document,
            none,
            ScrollAxis::Vertical,
            20.0,
        ));
        assert_eq!(element_scroll_offsets(&mut document, none).y, 0.0);

        document
            .mutate()
            .set_attribute(content, attr_name("style"), "width:300px;height:240px");
        document.resolve(0.0);
        assert!(set_element_scroll_offset(
            &mut document,
            scroller,
            ScrollAxis::Vertical,
            20.0,
        ));

        document.mutate().set_attribute(
            scroller,
            attr_name("style"),
            "display:contents;overflow:auto;width:100px;height:80px",
        );
        document.resolve(0.0);
        assert_eq!(element_scroll_offsets(&mut document, scroller).y, 0.0);
        assert_eq!(document.get_node(scroller).unwrap().scroll_offset.y, 0.0);
        assert!(!set_element_scroll_offset(
            &mut document,
            scroller,
            ScrollAxis::Vertical,
            20.0,
        ));

        // A contents element has no box of its own, but does not suppress descendant boxes.
        document.mutate().set_attribute(
            scroller,
            attr_name("style"),
            "overflow:auto;width:100px;height:80px",
        );
        document
            .mutate()
            .set_attribute(host, attr_name("style"), "display:contents");
        document.resolve(0.0);
        assert!(set_element_scroll_offset(
            &mut document,
            scroller,
            ScrollAxis::Vertical,
            20.0,
        ));

        document.mutate().remove_node(scroller);
        assert_eq!(element_scroll_offsets(&mut document, scroller).y, 0.0);
        assert!(!set_element_scroll_offset(
            &mut document,
            scroller,
            ScrollAxis::Vertical,
            20.0,
        ));

        document.mutate().append_children(body, &[scroller]);
        document.resolve(0.0);
        assert_eq!(element_scroll_offsets(&mut document, scroller).y, 0.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "viewport and element offsets retain exactly representable input doubles"
    )]
    fn standards_root_proxies_viewport_while_body_keeps_an_element_offset() {
        let mut body_document = layout_document("<div style='height:400px'></div>", 200, 100);
        let root = element_by_tag(&body_document, "html");
        let body = element_by_tag(&body_document, "body");

        assert!(set_element_scroll_offset(
            &mut body_document,
            root,
            ScrollAxis::Vertical,
            37.5,
        ));
        assert_eq!(body_document.viewport_scroll().y, 37.5);
        assert_eq!(element_scroll_offsets(&mut body_document, root).y, 37.5);
        assert_eq!(body_document.get_node(root).unwrap().scroll_offset.y, 0.0);
        assert!(!set_element_scroll_offset(
            &mut body_document,
            body,
            ScrollAxis::Vertical,
            20.0,
        ));
        assert_eq!(body_document.viewport_scroll().y, 37.5);

        let mut scrolling_body = layout_document("<div style='height:400px'></div>", 200, 100);
        let root = element_by_tag(&scrolling_body, "html");
        let body = element_by_tag(&scrolling_body, "body");
        scrolling_body.mutate().set_attribute(
            body,
            attr_name("style"),
            "height:80px;margin:0;overflow:hidden",
        );
        scrolling_body.resolve(0.0);
        assert!(!set_element_scroll_offset(
            &mut scrolling_body,
            body,
            ScrollAxis::Vertical,
            22.25,
        ));
        assert_eq!(element_scroll_offsets(&mut scrolling_body, body).y, 0.0);

        // Default root overflow propagates the body's overflow to the viewport. Once the root
        // establishes its own overflow behavior, the body keeps its ordinary element scroll box.
        scrolling_body
            .mutate()
            .set_attribute(root, attr_name("style"), "overflow:hidden");
        scrolling_body.resolve(0.0);
        assert!(set_element_scroll_offset(
            &mut scrolling_body,
            body,
            ScrollAxis::Vertical,
            22.25,
        ));
        assert_eq!(element_scroll_offsets(&mut scrolling_body, body).y, 22.25);
        assert_eq!(scrolling_body.viewport_scroll().y, 0.0);

        assert!(set_element_scroll_offset(
            &mut body_document,
            root,
            ScrollAxis::Vertical,
            f64::INFINITY,
        ));
        assert_eq!(body_document.viewport_scroll().y, 0.0);
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::float_cmp,
        reason = "IME wire flags and booleans are exactly represented integer values"
    )]
    fn subtree_detach_saves_the_live_value_clears_focus_and_disables_ime_silently() {
        let (mut document, ime_requests) = ime_document(
            "<main><section id='moving'><input id='field' value='seed'></section><aside></aside></main>",
        );
        let body_id = element_by_tag(&document, "body");
        let aside_id = element_by_tag(&document, "aside");
        let moving_id = element_by_id(&document, "moving");
        let input_id = element_by_id(&document, "field");
        let mut text_controls = TextControlStates::default();
        text_controls.reconcile_document(&mut document);

        assert!(document.set_focus_to(input_id));
        let enabled = acknowledge_ime_request(&ime_requests);
        assert_ne!(enabled[1] as u8 & IME_REQUEST_ENABLED, 0);
        assert_eq!(enabled[6], 1.0);
        document.with_text_input(input_id, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });

        assert!(clear_retained_focus_in_subtree(
            &mut document,
            &mut text_controls,
            moving_id,
        ));
        assert_eq!(retained_focus_node_id(&document), None);
        assert!(!document.get_node(input_id).unwrap().is_focussed());
        let disabled = acknowledge_ime_request(&ime_requests);
        assert_ne!(disabled[1] as u8 & IME_REQUEST_ENABLED, 0);
        assert_eq!(disabled[6], 0.0);

        document.mutate().remove_node(moving_id);
        text_controls.reconcile_document(&mut document);
        assert_eq!(
            text_controls.value(&mut document, input_id).as_deref(),
            Some("seed候補")
        );

        document.mutate().append_children(body_id, &[moving_id]);
        text_controls.reconcile_document(&mut document);
        assert_eq!(retained_focus_node_id(&document), None);
        assert_eq!(
            text_controls.value(&mut document, input_id).as_deref(),
            Some("seed候補")
        );

        // An ordinary connected reparent is also a removal/insertion operation and must not carry
        // focus to the new parent. There is deliberately no DOM event callback in this path.
        assert!(document.set_focus_to(input_id));
        acknowledge_ime_request(&ime_requests);
        assert!(clear_retained_focus_in_subtree(
            &mut document,
            &mut text_controls,
            moving_id,
        ));
        document.mutate().append_children(aside_id, &[moving_id]);
        assert_eq!(retained_focus_node_id(&document), None);
        assert_eq!(
            text_controls.value(&mut document, input_id).as_deref(),
            Some("seed候補")
        );
    }

    #[test]
    fn child_replacement_clears_only_focus_that_will_be_destroyed() {
        let mut document = HtmlDocument::from_html(
            "<!doctype html><html><body><section id='host'><input id='field' value='old'></section></body></html>",
            DocumentConfig {
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..DocumentConfig::default()
            },
        )
        .into_inner();
        let host_id = element_by_id(&document, "host");
        let input_id = element_by_id(&document, "field");
        let mut text_controls = TextControlStates::default();
        text_controls.reconcile_document(&mut document);

        assert!(document.set_focus_to(host_id));
        assert!(!clear_retained_focus_in_descendants(
            &mut document,
            &mut text_controls,
            host_id,
        ));
        assert_eq!(retained_focus_node_id(&document), Some(host_id));

        assert!(document.set_focus_to(input_id));
        document.with_text_input(input_id, |mut driver| {
            driver.move_to_text_end();
            driver.insert_or_replace_selection("-edited");
        });
        assert!(clear_retained_focus_in_descendants(
            &mut document,
            &mut text_controls,
            host_id,
        ));
        assert_eq!(
            text_controls.value(&mut document, input_id).as_deref(),
            Some("old-edited")
        );

        let dropped = dropped_descendant_ids(&document, host_id);
        text_controls.invalidate_nodes(dropped);
        document
            .mutate()
            .set_inner_html(host_id, "<span>replacement</span>");
        assert!(document.tree().iter().all(|(_, node)| {
            node.element_data().is_none_or(|element| {
                element.attr(blitz_dom::LocalName::from("id")) != Some("field")
            })
        }));
        assert_eq!(retained_focus_node_id(&document), None);
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
