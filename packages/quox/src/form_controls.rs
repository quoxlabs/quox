use blitz_dom::node::{SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, NodeData, QualName, local_name, ns};
use std::collections::HashMap;

/// Browser-facing state which Blitz's render-only text editor does not retain itself.
///
/// Raw node ids are safe keys only while this map is purged before Blitz drops nodes and can
/// recycle their slab slots. Detached nodes remain in Blitz's slab, so their state deliberately
/// remains here as well.
#[derive(Default)]
pub(crate) struct TextControlStates {
    controls: HashMap<usize, TextControlState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextControlKind {
    InputText,
    InputUrl,
    InputEmail,
    InputMultipleEmail,
    InputNumber,
    TextArea,
}

impl TextControlKind {
    fn is_multiline(self) -> bool {
        matches!(self, Self::TextArea)
    }

    fn supports_selection(self) -> bool {
        matches!(self, Self::InputText | Self::InputUrl | Self::TextArea)
    }

    fn preserves_committed_bad_input(self) -> bool {
        matches!(self, Self::InputNumber)
    }

    fn normalize_user_value(self, value: &str) -> String {
        if matches!(self, Self::InputMultipleEmail) {
            let without_newlines = value
                .chars()
                .filter(|character| !matches!(character, '\r' | '\n'))
                .collect::<String>();
            self.normalize_value(&without_newlines)
        } else {
            self.normalize_value(value)
        }
    }

    fn normalize_value(self, value: &str) -> String {
        match self {
            // HTML's value sanitization algorithm for the text-like single-line states removes
            // line breaks rather than allowing them into the editor.
            Self::InputText => value
                .chars()
                .filter(|character| !matches!(character, '\r' | '\n'))
                .collect(),
            // URL and single-address email states additionally strip surrounding ASCII
            // whitespace.
            Self::InputUrl | Self::InputEmail => value
                .chars()
                .filter(|character| !matches!(character, '\r' | '\n'))
                .collect::<String>()
                .trim_matches(|character| matches!(character, '\u{0009}' | '\u{000c}' | '\u{0020}'))
                .to_owned(),
            Self::InputMultipleEmail => value
                .split(',')
                .map(|address| {
                    address.trim_matches(|character| {
                        matches!(
                            character,
                            '\u{0009}' | '\u{000a}' | '\u{000c}' | '\u{000d}' | '\u{0020}'
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::InputNumber => {
                if is_valid_floating_point_number(value) {
                    value.to_owned()
                } else {
                    String::new()
                }
            }
            // DOM text normally reaches us with LF line endings, but script can still provide CR
            // through a Text node. The textarea value API exposes normalized LF line endings.
            Self::TextArea => value.replace("\r\n", "\n").replace('\r', "\n"),
        }
    }
}

struct TextControlState {
    kind: TextControlKind,
    /// Last content default observed: input's value attribute or textarea's child text.
    default_value: String,
    /// Current value exposed by the browser API, including an active IME composition passage.
    value: String,
    /// Exact Parley buffer. URL/email sanitizers may expose a different API value without making
    /// a read mutate the user's in-progress editor text or composition.
    editor_value: String,
    dirty_value: bool,
    /// False while an otherwise-retained valid value is passing through an input value-mode
    /// which Quox/Blitz cannot currently render, expose, or sanitize (date/range/color and
    /// related states). Their full value models are a separate compatibility slice.
    active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnmanagedInputMode {
    UnsupportedValue,
    Default,
    DefaultOn,
    Filename,
}

impl TextControlStates {
    /// Reconcile every live text control before layout or immediately after a DOM mutation.
    pub(crate) fn reconcile_document(&mut self, document: &mut BaseDocument) {
        // Detached nodes are still returned by get_node and must keep their value. Only actually
        // destroyed nodes are removed here; ordinary Quox replacement paths additionally purge
        // before mutation so a recycled raw id cannot inherit this state even transiently.
        let existing = self.controls.keys().copied().collect::<Vec<_>>();
        for node_id in existing {
            if document.get_node(node_id).is_none() {
                self.controls.remove(&node_id);
            } else if control_descriptor(document, node_id).is_none() {
                // Capture the previous value mode's final editor contents before applying the
                // type-change bookkeeping. In particular, active composition text is part of
                // the value which a transition to default/default-on mode can copy to the
                // content attribute.
                self.sync_editor_value(document, node_id);
                if unmanaged_input_mode(document, node_id)
                    == Some(UnmanagedInputMode::UnsupportedValue)
                {
                    // Preserve valid internal values and the dirty flag across unsupported
                    // value-mode states so returning to a supported mode does not resurrect the
                    // old default. Destination-specific sanitizers remain deliberately outside
                    // this text-control slice; `.value` is unavailable while this state is held.
                    self.sync_editor_value(document, node_id);
                    if let Some(control) = self.controls.get_mut(&node_id) {
                        let default_value = input_default_value(document, node_id);
                        if control.default_value != default_value {
                            control.default_value.clone_from(&default_value);
                            if !control.dirty_value {
                                control.value.clone_from(&default_value);
                                control.editor_value = default_value;
                            }
                        }
                        control.active = false;
                    }
                    clear_text_editor(document, node_id);
                } else if let Some(control) = self.controls.remove(&node_id) {
                    transition_out_of_text_value_mode(document, node_id, &control.value);
                }
            }
        }

        let controls = document
            .tree()
            .iter()
            .filter_map(|(node_id, _)| {
                control_descriptor(document, node_id)
                    .map(|(kind, default_value)| (node_id, kind, default_value))
            })
            .collect::<Vec<_>>();

        for (node_id, kind, default_value) in controls {
            self.reconcile_known_control(document, node_id, kind, default_value);
        }
    }

    /// Reconcile one control on demand for the synchronous value FFI.
    pub(crate) fn reconcile_control(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
    ) -> bool {
        let Some((kind, default_value)) = control_descriptor(document, node_id) else {
            return false;
        };
        self.reconcile_known_control(document, node_id, kind, default_value);
        true
    }

    fn reconcile_known_control(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
        kind: TextControlKind,
        default_value: String,
    ) {
        let control = self
            .controls
            .entry(node_id)
            .or_insert_with(|| TextControlState {
                kind,
                value: kind.normalize_value(&default_value),
                editor_value: kind.normalize_value(&default_value),
                default_value: default_value.clone(),
                dirty_value: false,
                active: true,
            });

        let previously_selectable = control.active && control.kind.supports_selection();
        let reactivating = !control.active;
        let mut move_selection_to_start = false;
        if control.kind != kind || reactivating {
            // These input states all use HTML's value mode. Type/`multiple` transitions preserve
            // the live value and dirty flag, then apply the new state's sanitizer.
            move_selection_to_start = !previously_selectable && kind.supports_selection();
            control.kind = kind;
            control.value = kind.normalize_value(&control.value);
            control.editor_value.clone_from(&control.value);
            control.active = true;
        }
        if control.default_value != default_value {
            control.default_value = default_value;
            if !control.dirty_value {
                control.value = kind.normalize_value(&control.default_value);
                control.editor_value.clone_from(&control.value);
            }
        }

        let editor_value = control.editor_value.clone();
        ensure_text_editor(document, node_id, kind);
        apply_value_to_editor(document, node_id, &editor_value, false);
        if move_selection_to_start {
            document.with_text_input(node_id, |mut driver| driver.move_to_text_start());
        }
    }

    /// Return the live value, including active composition text. Native defaults synchronize this
    /// before staging `input`, so a listener observes the mutation which caused its event.
    pub(crate) fn value(&mut self, document: &mut BaseDocument, node_id: usize) -> Option<String> {
        if self.controls.contains_key(&node_id) {
            self.sync_editor_value(document, node_id);
        }
        if self.reconcile_control(document, node_id) {
            return self.controls.get(&node_id).map(|state| state.value.clone());
        }

        match unmanaged_input_mode(document, node_id)? {
            UnmanagedInputMode::Default => {
                Some(input_value_attribute(document, node_id).unwrap_or_default())
            }
            UnmanagedInputMode::DefaultOn => {
                Some(input_value_attribute(document, node_id).unwrap_or_else(|| "on".to_owned()))
            }
            UnmanagedInputMode::UnsupportedValue | UnmanagedInputMode::Filename => None,
        }
    }

    /// Set a supported script value without producing an event. Editor-backed value modes become
    /// dirty even for an identical assignment; default/default-on modes instead reflect the
    /// content attribute and report its observable presence/value change.
    pub(crate) fn set_value(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
        value: &str,
    ) -> Option<bool> {
        if !self.reconcile_control(document, node_id) {
            return match unmanaged_input_mode(document, node_id)? {
                UnmanagedInputMode::Default | UnmanagedInputMode::DefaultOn => {
                    Some(set_input_value_attribute(document, node_id, value))
                }
                UnmanagedInputMode::UnsupportedValue | UnmanagedInputMode::Filename => None,
            };
        }

        let control = self
            .controls
            .get_mut(&node_id)
            .expect("reconcile_control inserted the text control");
        let value = control.kind.normalize_value(value);
        let value_changed = control.value != value;
        let editor_changed = control.editor_value != value;
        control.value.clone_from(&value);
        control.editor_value.clone_from(&value);
        control.dirty_value = true;
        apply_value_to_editor(document, node_id, &value, value_changed);
        Some(value_changed || editor_changed)
    }

    /// Capture edits made directly by Blitz/Parley. `raw_text` includes the active IME passage,
    /// matching the DOM update which browsers make before composition-related `input` listeners.
    /// Reconciliation must compare the same representation or it would erase that composition.
    pub(crate) fn sync_editor_value(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
    ) -> bool {
        if !self.controls.contains_key(&node_id) && !self.reconcile_control(document, node_id) {
            return false;
        }
        let Some((raw_editor_value, composing)) = editor_snapshot(document, node_id) else {
            return false;
        };
        let (changed, corrected_editor_value) = {
            let control = self
                .controls
                .get_mut(&node_id)
                .expect("a reconciled editor has browser state");
            let exposed_value = control.kind.normalize_user_value(&raw_editor_value);
            let retained_editor_value = if composing || control.kind.preserves_committed_bad_input()
            {
                raw_editor_value.clone()
            } else {
                exposed_value.clone()
            };
            let exposed_changed = control.value != exposed_value;
            let retained_bad_input_changed = control.kind.preserves_committed_bad_input()
                && control.editor_value != retained_editor_value;
            let changed = exposed_changed
                || control.editor_value != retained_editor_value
                || raw_editor_value != retained_editor_value;
            if changed {
                control.value = exposed_value;
                control.editor_value.clone_from(&retained_editor_value);
                control.dirty_value |= exposed_changed || retained_bad_input_changed;
            }
            (
                changed,
                (raw_editor_value != retained_editor_value).then_some(retained_editor_value),
            )
        };
        if let Some(editor_value) = corrected_editor_value {
            apply_value_to_editor(document, node_id, &editor_value, false);
        }
        changed
    }

    /// Temporarily remove only an editor whose live/default state Quox owns. Blitz writes a
    /// `value` content-attribute mutation straight into every `TextInputData`; hiding an
    /// unsupported control's editor would instead suppress the only component which owns it.
    pub(crate) fn take_editor_for_value_attribute_mutation(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
    ) -> Option<TextInputData> {
        self.reconcile_control(document, node_id)
            .then(|| take_text_editor(document, node_id))
            .flatten()
    }

    /// Purge before Blitz destroys nodes, not after, because its slab may immediately reuse ids.
    pub(crate) fn invalidate_nodes(&mut self, node_ids: impl IntoIterator<Item = usize>) {
        for node_id in node_ids {
            self.controls.remove(&node_id);
        }
    }

    #[cfg(test)]
    fn state(&self, node_id: usize) -> Option<&TextControlState> {
        self.controls.get(&node_id)
    }
}

fn control_descriptor(
    document: &BaseDocument,
    node_id: usize,
) -> Option<(TextControlKind, String)> {
    let node = document.get_node(node_id)?;
    if !matches!(&node.data, NodeData::Element(_)) {
        return None;
    }
    let element = node.element_data()?;
    if element.name.ns != ns!(html) {
        return None;
    }
    match element.name.local.as_ref() {
        "input" => {
            let input_type = element
                .attr(local_name!("type"))
                .unwrap_or("")
                .to_ascii_lowercase();
            let kind = match input_type.as_str() {
                "url" => TextControlKind::InputUrl,
                "email" => {
                    if element.has_attr(local_name!("multiple")) {
                        TextControlKind::InputMultipleEmail
                    } else {
                        TextControlKind::InputEmail
                    }
                }
                "number" => TextControlKind::InputNumber,
                // Checkbox/radio and unsupported Blitz input modes are outside this isolated
                // live-text implementation.
                "hidden" | "date" | "datetime-local" | "month" | "week" | "time" | "range"
                | "color" | "checkbox" | "radio" | "file" | "submit" | "image" | "reset"
                | "button" => return None,
                // Text-like keywords, the missing value, and the enumerated attribute's invalid
                // value default all use the Text state.
                _ => TextControlKind::InputText,
            };
            Some((
                kind,
                element.attr(local_name!("value")).unwrap_or("").to_owned(),
            ))
        }
        "textarea" => Some((TextControlKind::TextArea, node.text_content())),
        _ => None,
    }
}

fn html_input_element(document: &BaseDocument, node_id: usize) -> Option<&blitz_dom::ElementData> {
    let node = document.get_node(node_id)?;
    let element = node.element_data()?;
    (element.name.ns == ns!(html) && element.name.local.as_ref() == "input").then_some(element)
}

fn input_default_value(document: &BaseDocument, node_id: usize) -> String {
    input_value_attribute(document, node_id).unwrap_or_default()
}

fn input_value_attribute(document: &BaseDocument, node_id: usize) -> Option<String> {
    html_input_element(document, node_id)?
        .attr(local_name!("value"))
        .map(str::to_owned)
}

/// Set an input value content attribute and report attribute identity, not exposed-value
/// equality. An absent checkbox and `value="on"` have the same getter result, but creating the
/// attribute is observable and can affect selectors; likewise an empty submit value suppresses
/// its implementation-defined fallback label.
fn set_input_value_attribute(document: &mut BaseDocument, node_id: usize, value: &str) -> bool {
    if input_value_attribute(document, node_id).as_deref() == Some(value) {
        return false;
    }
    document
        .mutate()
        .set_attribute(node_id, value_attribute_name(), value);
    true
}

fn value_attribute_name() -> QualName {
    QualName {
        prefix: None,
        ns: ns!(),
        local: local_name!("value"),
    }
}

fn unmanaged_input_mode(document: &BaseDocument, node_id: usize) -> Option<UnmanagedInputMode> {
    let input_type = html_input_element(document, node_id)?
        .attr(local_name!("type"))
        .unwrap_or("")
        .to_ascii_lowercase();
    match input_type.as_str() {
        "date" | "datetime-local" | "month" | "week" | "time" | "range" | "color" => {
            Some(UnmanagedInputMode::UnsupportedValue)
        }
        "hidden" | "submit" | "image" | "reset" | "button" => Some(UnmanagedInputMode::Default),
        "checkbox" | "radio" => Some(UnmanagedInputMode::DefaultOn),
        "file" => Some(UnmanagedInputMode::Filename),
        _ => None,
    }
}

fn is_valid_floating_point_number(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let bytes = value.as_bytes();
    let mut index = usize::from(bytes.first() == Some(&b'-'));
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let integer_digits = index - integer_start;
    let mut fraction_digits = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        fraction_digits = index - fraction_start;
        if fraction_digits == 0 {
            return false;
        }
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len() && value.parse::<f64>().is_ok_and(f64::is_finite)
}

/// Apply HTML's simple value-mode exit bookkeeping before handing a non-editor input state back
/// to Blitz. A nonempty live value becomes the content default; returning to a supported value
/// mode initializes from that attribute with a fresh dirty flag.
fn transition_out_of_text_value_mode(document: &mut BaseDocument, node_id: usize, value: &str) {
    if matches!(
        unmanaged_input_mode(document, node_id),
        Some(UnmanagedInputMode::Default | UnmanagedInputMode::DefaultOn)
    ) && !value.is_empty()
    {
        document
            .mutate()
            .set_attribute(node_id, value_attribute_name(), value);
    }

    clear_text_editor(document, node_id);
}

fn clear_text_editor(document: &mut BaseDocument, node_id: usize) {
    if let Some(element) = document
        .get_node_mut(node_id)
        .and_then(blitz_dom::Node::element_data_mut)
        && matches!(&element.special_data, SpecialElementData::TextInput(_))
    {
        // This runs synchronously in Quox's type-attribute mutation. A pending key/IME default
        // must not edit the obsolete Parley buffer before the next layout constructs the new
        // state's appropriate special data.
        element.special_data = SpecialElementData::None;
    }
}

fn ensure_text_editor(document: &mut BaseDocument, node_id: usize, kind: TextControlKind) {
    let Some(element) = document
        .get_node_mut(node_id)
        .and_then(blitz_dom::Node::element_data_mut)
    else {
        return;
    };
    let correct_editor = matches!(
        &element.special_data,
        SpecialElementData::TextInput(data) if data.is_multiline == kind.is_multiline()
    );
    if !correct_editor {
        element.special_data =
            SpecialElementData::TextInput(TextInputData::new(kind.is_multiline()));
    }
}

/// Temporarily hide an editor from Blitz's value-content-attribute mutator. Blitz otherwise
/// replaces the live buffer unconditionally, even when HTML dirty-value semantics say only the
/// default changes, destroying Parley's selection and active composition metadata.
fn take_text_editor(document: &mut BaseDocument, node_id: usize) -> Option<TextInputData> {
    let special_data = &mut document
        .get_node_mut(node_id)?
        .element_data_mut()?
        .special_data;
    match special_data.take() {
        SpecialElementData::TextInput(editor) => Some(editor),
        other => {
            *special_data = other;
            None
        }
    }
}

pub(crate) fn restore_text_editor(
    document: &mut BaseDocument,
    node_id: usize,
    editor: Option<TextInputData>,
) {
    let Some(editor) = editor else {
        return;
    };
    let Some(element) = document
        .get_node_mut(node_id)
        .and_then(blitz_dom::Node::element_data_mut)
    else {
        return;
    };
    debug_assert!(matches!(&element.special_data, SpecialElementData::None));
    element.special_data = SpecialElementData::TextInput(editor);
}

#[cfg(test)]
fn editor_value(document: &BaseDocument, node_id: usize) -> Option<String> {
    document
        .get_node(node_id)?
        .element_data()?
        .text_input_data()
        .map(|input| input.editor.raw_text().to_owned())
}

fn editor_snapshot(document: &BaseDocument, node_id: usize) -> Option<(String, bool)> {
    let editor = &document
        .get_node(node_id)?
        .element_data()?
        .text_input_data()?
        .editor;
    Some((editor.raw_text().to_owned(), editor.raw_compose().is_some()))
}

fn apply_value_to_editor(
    document: &mut BaseDocument,
    node_id: usize,
    value: &str,
    move_caret_to_end: bool,
) {
    document.with_text_input(node_id, |mut driver| {
        if driver.editor.raw_text() == value {
            return;
        }
        let old_text = driver.editor.raw_text().to_owned();
        let old_selection = driver.editor.raw_selection();
        let anchor_utf16 = utf16_offset_for_byte(&old_text, old_selection.anchor().index());
        let focus_utf16 = utf16_offset_for_byte(&old_text, old_selection.focus().index());
        if driver.editor.raw_compose().is_some() {
            // Whole-value replacement aborts composition. `clear_compose` also restores a caret
            // which Parley's set_text alone would leave hidden.
            driver.clear_compose();
        }
        driver.editor.set_text(value);
        driver.refresh_layout();
        if move_caret_to_end {
            driver.move_to_text_end();
        } else {
            let anchor = byte_offset_for_utf16(value, anchor_utf16);
            let focus = byte_offset_for_utf16(value, focus_utf16);
            driver.select_byte_range(anchor, focus);
        }
    });
}

fn utf16_offset_for_byte(value: &str, byte_offset: usize) -> usize {
    let byte_offset = byte_offset.min(value.len());
    value
        .get(..byte_offset)
        .unwrap_or(value)
        .encode_utf16()
        .count()
}

fn byte_offset_for_utf16(value: &str, utf16_offset: usize) -> usize {
    let mut consumed = 0;
    for (byte_offset, character) in value.char_indices() {
        let next = consumed + character.len_utf16();
        if next > utf16_offset {
            return byte_offset;
        }
        consumed = next;
    }
    value.len()
}

#[cfg(test)]
mod tests {
    use super::{TextControlStates, restore_text_editor};
    use blitz_dom::{BaseDocument, DocumentConfig, LocalName, QualName, local_name, ns};
    use blitz_html::{HtmlDocument, HtmlProvider};
    use std::sync::Arc;

    fn document(body: &str) -> BaseDocument {
        HtmlDocument::from_html(
            &format!("<!doctype html><html><body>{body}</body></html>"),
            DocumentConfig {
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..DocumentConfig::default()
            },
        )
        .into_inner()
    }

    fn element(document: &BaseDocument, id: &str) -> usize {
        document
            .tree()
            .iter()
            .find_map(|(node_id, node)| {
                node.element_data().and_then(|element| {
                    (element.attr(LocalName::from("id")) == Some(id)).then_some(node_id)
                })
            })
            .unwrap_or_else(|| panic!("missing test element #{id}"))
    }

    fn value_attribute() -> QualName {
        QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("value"),
        }
    }

    fn type_attribute() -> QualName {
        QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("type"),
        }
    }

    fn set_input_type(document: &mut BaseDocument, node_id: usize, input_type: &str) {
        document
            .mutate()
            .set_attribute(node_id, type_attribute(), input_type);
    }

    fn editor_selection(document: &BaseDocument, node_id: usize) -> std::ops::Range<usize> {
        document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::text_input_data)
            .expect("test node should have an editor")
            .editor
            .raw_selection()
            .text_range()
    }

    #[test]
    fn empty_inputs_and_textarea_children_initialize_the_editor_exactly() {
        let mut document =
            document("<input id='empty'><textarea id='area' value='ignored'>child text</textarea>");
        let input = element(&document, "empty");
        let textarea = element(&document, "area");
        let mut controls = TextControlStates::default();

        controls.reconcile_document(&mut document);

        assert_eq!(controls.value(&mut document, input).as_deref(), Some(""));
        assert_eq!(
            controls.value(&mut document, textarea).as_deref(),
            Some("child text")
        );
        assert_eq!(super::editor_value(&document, input).as_deref(), Some(""));
        assert_eq!(
            super::editor_value(&document, textarea).as_deref(),
            Some("child text")
        );
    }

    #[test]
    fn changing_the_default_follows_only_until_the_value_becomes_dirty() {
        let mut document = document("<input id='field' value='first'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        document
            .mutate()
            .set_attribute(input, value_attribute(), "second");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("second")
        );

        assert_eq!(
            controls.set_value(&mut document, input, "script"),
            Some(true)
        );
        document
            .mutate()
            .set_attribute(input, value_attribute(), "third");
        controls.reconcile_document(&mut document);

        let state = controls
            .state(input)
            .expect("input state should remain live");
        assert_eq!(state.default_value, "third");
        assert_eq!(state.value, "script");
        assert!(state.dirty_value);
        assert_eq!(
            super::editor_value(&document, input).as_deref(),
            Some("script")
        );
    }

    #[test]
    fn textarea_children_follow_only_until_the_raw_value_becomes_dirty() {
        let mut document = document("<textarea id='area'>first</textarea>");
        let textarea = element(&document, "area");
        let text_child = document
            .get_node(textarea)
            .and_then(|node| node.children.first())
            .copied()
            .expect("textarea should have a text child");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        document.mutate().set_node_text(text_child, "second");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, textarea).as_deref(),
            Some("second")
        );

        controls.set_value(&mut document, textarea, "script");
        document.mutate().set_node_text(text_child, "third");
        controls.reconcile_document(&mut document);
        let state = controls
            .state(textarea)
            .expect("textarea state should remain live");
        assert_eq!(state.default_value, "third");
        assert_eq!(state.value, "script");
        assert!(state.dirty_value);
    }

    #[test]
    fn native_editor_edits_are_captured_before_later_reconciliation() {
        let mut document = document("<textarea id='area'>initial</textarea>");
        let textarea = element(&document, "area");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(textarea, |mut driver| {
            driver.move_to_text_end();
            driver.insert_or_replace_selection(" native");
        });

        assert!(controls.sync_editor_value(&mut document, textarea));
        let text_child = document
            .get_node(textarea)
            .and_then(|node| node.children.first())
            .copied()
            .expect("textarea should have a text child");
        document.mutate().set_node_text(text_child, "new default");
        controls.reconcile_document(&mut document);

        assert_eq!(
            controls.value(&mut document, textarea).as_deref(),
            Some("initial native")
        );
    }

    #[test]
    fn committed_single_line_edits_are_sanitized_in_value_and_editor() {
        let mut document = document(
            "<input id='clean' value='a'><input id='text'><input id='url' type='url'><input id='multiple' type='email' multiple>",
        );
        let clean = element(&document, "clean");
        let text = element(&document, "text");
        let url = element(&document, "url");
        let multiple = element(&document, "multiple");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        document.with_text_input(clean, |mut driver| {
            driver.move_to_text_end();
            driver.insert_or_replace_selection("\n");
        });
        document.with_text_input(text, |mut driver| {
            driver.insert_or_replace_selection("a\r\nb");
        });
        document.with_text_input(url, |mut driver| {
            driver.insert_or_replace_selection("  https://example.com\n ");
        });
        document.with_text_input(multiple, |mut driver| {
            driver.insert_or_replace_selection(" first@example.com\n, second@example.com ");
        });

        for node_id in [clean, text, url, multiple] {
            assert!(controls.sync_editor_value(&mut document, node_id));
        }
        assert!(!controls.state(clean).unwrap().dirty_value);
        document
            .mutate()
            .set_attribute(clean, value_attribute(), "new default");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, clean).as_deref(),
            Some("new default")
        );
        assert_eq!(controls.value(&mut document, text).as_deref(), Some("ab"));
        assert_eq!(super::editor_value(&document, text).as_deref(), Some("ab"));
        assert_eq!(
            controls.value(&mut document, url).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            super::editor_value(&document, url).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            controls.value(&mut document, multiple).as_deref(),
            Some("first@example.com,second@example.com")
        );
        assert_eq!(
            super::editor_value(&document, multiple).as_deref(),
            Some("first@example.com,second@example.com")
        );
    }

    #[test]
    fn active_ime_preedit_is_visible_and_survives_reconciliation() {
        let mut document = document("<input id='field' value='before'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(input, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });

        assert!(controls.sync_editor_value(&mut document, input));
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("before候補")
        );
        controls.reconcile_document(&mut document);
        assert_eq!(
            super::editor_value(&document, input).as_deref(),
            Some("before候補")
        );
    }

    #[test]
    fn dirty_default_mutation_preserves_selection_and_active_composition() {
        let mut document = document("<input id='field' value='default'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "dirty");
        document.with_text_input(input, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });
        controls.sync_editor_value(&mut document, input);

        let editor = controls.take_editor_for_value_attribute_mutation(&mut document, input);
        document
            .mutate()
            .set_attribute(input, value_attribute(), "new default");
        restore_text_editor(&mut document, input, editor);
        controls.reconcile_document(&mut document);

        let editor = document
            .get_node(input)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::text_input_data)
            .expect("managed input should retain its editor");
        assert_eq!(editor.editor.raw_text(), "dirty候補");
        assert!(editor.editor.raw_compose().is_some());

        document.with_text_input(input, |mut driver| driver.set_compose("続", None));
        assert_eq!(
            super::editor_value(&document, input).as_deref(),
            Some("dirty続")
        );
    }

    #[test]
    fn shrinking_a_clean_default_clamps_selection_before_the_next_edit() {
        let mut document = document("<textarea id='area'>abcdef</textarea>");
        let textarea = element(&document, "area");
        let text_child = document
            .get_node(textarea)
            .and_then(|node| node.children.first())
            .copied()
            .expect("textarea should have a text child");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(textarea, |mut driver| driver.move_to_text_end());

        document.mutate().set_node_text(text_child, "x");
        controls.reconcile_document(&mut document);
        assert_eq!(editor_selection(&document, textarea), 1..1);

        document.with_text_input(textarea, |mut driver| {
            driver.insert_or_replace_selection("y");
        });
        controls.sync_editor_value(&mut document, textarea);
        assert_eq!(
            controls.value(&mut document, textarea).as_deref(),
            Some("xy")
        );
    }

    #[test]
    fn detached_controls_keep_state_but_destroyed_ids_do_not() {
        let mut document = document("<input id='field' value='default'>");
        let body = document
            .tree()
            .iter()
            .find_map(|(node_id, node)| {
                node.element_data()
                    .is_some_and(|element| element.name.local.as_ref() == "body")
                    .then_some(node_id)
            })
            .expect("test document should have a body");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "retained");

        document.mutate().remove_node(input);
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("retained")
        );

        document.mutate().append_children(body, &[input]);
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("retained")
        );

        controls.invalidate_nodes([input]);
        assert!(controls.state(input).is_none());
        document.mutate().remove_and_drop_all_children(body);
        document
            .mutate()
            .set_inner_html(body, "<input id='replacement' value='fresh'>");
        let replacement = element(&document, "replacement");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, replacement).as_deref(),
            Some("fresh")
        );
    }

    #[test]
    fn script_values_are_sanitized_and_same_value_assignments_still_become_dirty() {
        let mut document = document("<input id='field'><textarea id='area'></textarea>");
        let input = element(&document, "field");
        let textarea = element(&document, "area");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        assert_eq!(
            controls.set_value(&mut document, input, "one\r\ntwo\nthree"),
            Some(true)
        );
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("onetwothree")
        );
        assert_eq!(editor_selection(&document, input), 11..11);
        document.with_text_input(input, |mut driver| driver.move_to_text_start());
        assert_eq!(
            controls.set_value(&mut document, input, "onetwothree"),
            Some(false)
        );
        assert_eq!(editor_selection(&document, input), 0..0);
        assert!(controls.state(input).unwrap().dirty_value);

        controls.set_value(&mut document, textarea, "one\r\ntwo\rthree");
        assert_eq!(
            controls.value(&mut document, textarea).as_deref(),
            Some("one\ntwo\nthree")
        );
    }

    #[test]
    fn default_modes_reflect_value_attribute_presence_and_contents() {
        let mut document = document(
            "<input id='hidden' type='hidden'>\
             <input id='submit' type='submit'>\
             <input id='image' type='image'>\
             <input id='reset' type='reset'>\
             <input id='button' type='button'>",
        );
        let inputs =
            ["hidden", "submit", "image", "reset", "button"].map(|id| element(&document, id));
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        for input in inputs {
            assert_eq!(controls.value(&mut document, input).as_deref(), Some(""));
            assert_eq!(controls.set_value(&mut document, input, ""), Some(true));
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("")
            );
            assert_eq!(controls.set_value(&mut document, input, ""), Some(false));

            assert_eq!(
                controls.set_value(&mut document, input, "button label"),
                Some(true)
            );
            assert_eq!(
                controls.value(&mut document, input).as_deref(),
                Some("button label")
            );
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("button label")
            );

            document.mutate().clear_attribute(input, value_attribute());
            assert_eq!(controls.value(&mut document, input).as_deref(), Some(""));
            assert!(controls.state(input).is_none());
            assert!(super::editor_value(&document, input).is_none());
        }
    }

    #[test]
    fn default_on_modes_use_on_only_while_the_value_attribute_is_missing() {
        let mut document = document(
            "<input id='checkbox' type='checkbox' checked>\
             <input id='radio' type='radio' checked>",
        );
        let inputs = ["checkbox", "radio"].map(|id| element(&document, id));
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        for input in inputs {
            assert_eq!(controls.value(&mut document, input).as_deref(), Some("on"));
            assert_eq!(controls.set_value(&mut document, input, "on"), Some(true));
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("on")
            );
            assert_eq!(controls.set_value(&mut document, input, "on"), Some(false));

            assert_eq!(controls.set_value(&mut document, input, ""), Some(true));
            assert_eq!(controls.value(&mut document, input).as_deref(), Some(""));
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("")
            );

            document.mutate().clear_attribute(input, value_attribute());
            assert_eq!(controls.value(&mut document, input).as_deref(), Some("on"));
            assert!(
                document
                    .get_node(input)
                    .and_then(blitz_dom::Node::element_data)
                    .is_some_and(|element| element.has_attr(local_name!("checked")))
            );
            assert!(controls.state(input).is_none());
            assert!(super::editor_value(&document, input).is_none());
        }
    }

    #[test]
    fn non_value_type_changes_follow_html_value_bookkeeping() {
        let mut document = document(
            "<input id='dirty-checkbox' value='old default'>\
             <input id='dirty-hidden' value='old default'>\
             <input id='empty-checkbox' value='old default'>\
             <input id='empty-hidden' value='old default'>\
             <input id='absent-checkbox' type='checkbox'>\
             <input id='assigned-checkbox' type='checkbox'>\
             <input id='fallback' type='hidden'>",
        );
        let dirty_checkbox = element(&document, "dirty-checkbox");
        let dirty_hidden = element(&document, "dirty-hidden");
        let empty_checkbox = element(&document, "empty-checkbox");
        let empty_hidden = element(&document, "empty-hidden");
        let absent_checkbox = element(&document, "absent-checkbox");
        let assigned_checkbox = element(&document, "assigned-checkbox");
        let fallback = element(&document, "fallback");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        for input in [dirty_checkbox, dirty_hidden] {
            controls.set_value(&mut document, input, "live value");
        }
        for input in [empty_checkbox, empty_hidden] {
            controls.set_value(&mut document, input, "");
        }
        set_input_type(&mut document, dirty_checkbox, "checkbox");
        set_input_type(&mut document, dirty_hidden, "hidden");
        set_input_type(&mut document, empty_checkbox, "checkbox");
        set_input_type(&mut document, empty_hidden, "hidden");
        controls.reconcile_document(&mut document);

        for input in [dirty_checkbox, dirty_hidden] {
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("live value")
            );
            assert_eq!(
                controls.value(&mut document, input).as_deref(),
                Some("live value")
            );
            assert!(controls.state(input).is_none());
        }
        for input in [empty_checkbox, empty_hidden] {
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("old default")
            );
            assert_eq!(
                controls.value(&mut document, input).as_deref(),
                Some("old default")
            );
        }

        for input in [dirty_checkbox, dirty_hidden] {
            set_input_type(&mut document, input, "text");
        }
        controls.reconcile_document(&mut document);
        for input in [dirty_checkbox, dirty_hidden] {
            assert_eq!(
                controls.value(&mut document, input).as_deref(),
                Some("live value")
            );
            assert!(!controls.state(input).unwrap().dirty_value);
            document
                .mutate()
                .set_attribute(input, value_attribute(), "new default");
        }
        controls.reconcile_document(&mut document);
        for input in [dirty_checkbox, dirty_hidden] {
            assert_eq!(
                controls.value(&mut document, input).as_deref(),
                Some("new default")
            );
        }

        set_input_type(&mut document, absent_checkbox, "text");
        assert_eq!(
            controls.set_value(&mut document, assigned_checkbox, "choice"),
            Some(true)
        );
        set_input_type(&mut document, assigned_checkbox, "text");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, absent_checkbox).as_deref(),
            Some("")
        );
        assert_eq!(
            controls.value(&mut document, assigned_checkbox).as_deref(),
            Some("choice")
        );
        assert!(!controls.state(absent_checkbox).unwrap().dirty_value);
        assert!(!controls.state(assigned_checkbox).unwrap().dirty_value);

        assert_eq!(controls.value(&mut document, fallback).as_deref(), Some(""));
        set_input_type(&mut document, fallback, "checkbox");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, fallback).as_deref(),
            Some("on")
        );
        assert!(super::input_value_attribute(&document, fallback).is_none());
        set_input_type(&mut document, fallback, "hidden");
        controls.reconcile_document(&mut document);
        assert_eq!(controls.value(&mut document, fallback).as_deref(), Some(""));
        assert!(super::input_value_attribute(&document, fallback).is_none());
    }

    #[test]
    fn type_change_copies_the_latest_active_composition_to_default_on_mode() {
        let mut document = document("<input id='field' value='before'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(input, |mut driver| {
            driver.move_to_text_end();
            driver.set_compose("候補", None);
        });

        document
            .mutate()
            .set_attribute(input, type_attribute(), "checkbox");
        controls.reconcile_document(&mut document);

        assert_eq!(
            super::input_value_attribute(&document, input).as_deref(),
            Some("before候補")
        );
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("before候補")
        );
        assert!(controls.state(input).is_none());
        assert!(super::editor_value(&document, input).is_none());
    }

    #[test]
    fn complex_and_filename_modes_remain_explicitly_unsupported() {
        let mut document = document(
            "<input id='date' type='date' value='sentinel'>\
             <input id='datetime' type='datetime-local' value='sentinel'>\
             <input id='month' type='month' value='sentinel'>\
             <input id='week' type='week' value='sentinel'>\
             <input id='time' type='time' value='sentinel'>\
             <input id='range' type='range' value='sentinel'>\
             <input id='color' type='color' value='sentinel'>\
             <input id='file' type='file' value='sentinel'>",
        );
        let inputs = [
            "date", "datetime", "month", "week", "time", "range", "color", "file",
        ]
        .map(|id| element(&document, id));
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        for input in inputs {
            assert_eq!(controls.value(&mut document, input), None);
            assert_eq!(
                controls.set_value(&mut document, input, "replacement"),
                None
            );
            assert_eq!(
                super::input_value_attribute(&document, input).as_deref(),
                Some("sentinel")
            );
        }
    }

    #[test]
    fn value_to_default_mode_preserves_nonempty_value_then_reinitializes() {
        let mut document = document("<input id='field' value='default'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "dirty");

        document
            .mutate()
            .set_attribute(input, type_attribute(), "checkbox");
        controls.reconcile_document(&mut document);
        assert!(controls.state(input).is_none());

        document
            .mutate()
            .set_attribute(input, type_attribute(), "text");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("dirty")
        );
        assert!(!controls.state(input).unwrap().dirty_value);
    }

    #[test]
    fn supported_value_mode_changes_preserve_and_resanitize_the_live_value() {
        let mut document = document("<input id='field' type='text' value='default'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "  https://example.com  ");

        document
            .mutate()
            .set_attribute(input, type_attribute(), "URL");
        controls.reconcile_document(&mut document);

        let state = controls.state(input).unwrap();
        assert_eq!(state.value, "https://example.com");
        assert_eq!(state.editor_value, "https://example.com");
        assert!(state.dirty_value);
    }

    #[test]
    fn unsupported_value_modes_retain_valid_live_state_until_a_supported_mode_returns() {
        let mut document = document(
            "<input id='dirty' type='text' value='old'><input id='clean' type='text' value='2023-01-01'>",
        );
        let dirty = element(&document, "dirty");
        let clean = element(&document, "clean");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, dirty, "2024-01-01");

        for node_id in [dirty, clean] {
            document
                .mutate()
                .set_attribute(node_id, type_attribute(), "date");
        }
        controls.reconcile_document(&mut document);
        assert!(!controls.state(dirty).unwrap().active);
        assert!(super::editor_value(&document, dirty).is_none());
        assert_eq!(controls.value(&mut document, dirty), None);

        document
            .mutate()
            .set_attribute(dirty, value_attribute(), "2026-03-03");
        document
            .mutate()
            .set_attribute(clean, value_attribute(), "2025-02-02");
        controls.reconcile_document(&mut document);

        for node_id in [dirty, clean] {
            document
                .mutate()
                .set_attribute(node_id, type_attribute(), "text");
        }
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, dirty).as_deref(),
            Some("2024-01-01")
        );
        assert!(controls.state(dirty).unwrap().dirty_value);
        assert_eq!(editor_selection(&document, dirty), 0..0);
        assert_eq!(
            controls.value(&mut document, clean).as_deref(),
            Some("2025-02-02")
        );
        assert!(!controls.state(clean).unwrap().dirty_value);
    }

    #[test]
    fn filename_mode_clears_live_state_instead_of_retaining_it() {
        let mut document = document("<input id='field' type='text' value='default'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "dirty");

        document
            .mutate()
            .set_attribute(input, type_attribute(), "file");
        controls.reconcile_document(&mut document);
        assert!(controls.state(input).is_none());

        document
            .mutate()
            .set_attribute(input, type_attribute(), "text");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, input).as_deref(),
            Some("default")
        );
        assert!(!controls.state(input).unwrap().dirty_value);
    }

    #[test]
    fn becoming_selectable_places_the_text_cursor_at_the_start() {
        let mut document = document("<input id='field' type='number'>");
        let input = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, input, "123");
        assert_eq!(editor_selection(&document, input), 3..3);

        document
            .mutate()
            .set_attribute(input, type_attribute(), "text");
        controls.reconcile_document(&mut document);

        assert_eq!(controls.value(&mut document, input).as_deref(), Some("123"));
        assert_eq!(editor_selection(&document, input), 0..0);
    }

    #[test]
    fn url_and_email_values_use_their_trimmed_sanitizer() {
        let mut document = document("<input id='url' type='url'><input id='email' type='email'>");
        let url = element(&document, "url");
        let email = element(&document, "email");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        controls.set_value(&mut document, url, " \t https://example.com\r\n ");
        controls.set_value(&mut document, email, " \t user@example.com\n ");
        assert_eq!(
            controls.value(&mut document, url).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            controls.value(&mut document, email).as_deref(),
            Some("user@example.com")
        );
    }

    #[test]
    fn multiple_email_trims_each_address_and_resanitizes_when_toggled() {
        let mut document =
            document("<input id='single' type='email'><input id='multiple' type='email' multiple>");
        let single = element(&document, "single");
        let multiple = element(&document, "multiple");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        controls.set_value(
            &mut document,
            single,
            " first@example.com , second@example.com ",
        );
        controls.set_value(
            &mut document,
            multiple,
            " first@example.com , second@example.com ",
        );
        assert_eq!(
            controls.value(&mut document, single).as_deref(),
            Some("first@example.com , second@example.com")
        );
        assert_eq!(
            controls.value(&mut document, multiple).as_deref(),
            Some("first@example.com,second@example.com")
        );

        document.mutate().set_attribute(
            single,
            QualName {
                prefix: None,
                ns: ns!(),
                local: local_name!("multiple"),
            },
            "",
        );
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, single).as_deref(),
            Some("first@example.com,second@example.com")
        );
    }

    #[test]
    fn type_keywords_are_case_insensitive_and_invalid_types_default_to_text() {
        let mut document =
            document("<input id='upper' type='TEXT'><input id='invalid' type='wat'>");
        let upper = element(&document, "upper");
        let invalid = element(&document, "invalid");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        assert!(controls.state(upper).is_some());
        assert!(controls.state(invalid).is_some());
        assert_eq!(
            controls.set_value(&mut document, upper, "a\r\nb"),
            Some(true)
        );
        assert_eq!(
            controls.set_value(&mut document, invalid, "c\nd"),
            Some(true)
        );
        assert_eq!(controls.value(&mut document, upper).as_deref(), Some("ab"));
        assert_eq!(
            controls.value(&mut document, invalid).as_deref(),
            Some("cd")
        );
    }

    #[test]
    fn number_controls_expose_sanitized_values_without_erasing_bad_input() {
        let mut document = document("<input id='number' type='number'>");
        let number = element(&document, "number");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(number, |mut driver| {
            driver.move_to_text_end();
            driver.insert_or_replace_selection("-");
        });

        controls.sync_editor_value(&mut document, number);
        assert_eq!(controls.value(&mut document, number).as_deref(), Some(""));
        assert_eq!(super::editor_value(&document, number).as_deref(), Some("-"));

        assert_eq!(
            controls.set_value(&mut document, number, "1.5e2"),
            Some(true)
        );
        assert_eq!(
            controls.value(&mut document, number).as_deref(),
            Some("1.5e2")
        );
        assert_eq!(
            controls.set_value(&mut document, number, "not a number"),
            Some(true)
        );
        assert_eq!(controls.value(&mut document, number).as_deref(), Some(""));
        assert_eq!(super::editor_value(&document, number).as_deref(), Some(""));
    }

    #[test]
    fn unsupported_controls_keep_ownership_of_any_existing_blitz_editor() {
        let mut document = document("<input id='date' type='date'>");
        let date = element(&document, "date");
        let mut controls = TextControlStates::default();
        document
            .get_node_mut(date)
            .and_then(blitz_dom::Node::element_data_mut)
            .unwrap()
            .special_data = blitz_dom::node::SpecialElementData::TextInput(
            blitz_dom::node::TextInputData::new(false),
        );

        assert!(
            controls
                .take_editor_for_value_attribute_mutation(&mut document, date)
                .is_none()
        );
        assert!(
            document
                .get_node(date)
                .and_then(blitz_dom::Node::element_data)
                .and_then(blitz_dom::ElementData::text_input_data)
                .is_some()
        );
    }
}
