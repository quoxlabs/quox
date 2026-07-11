use blitz_dom::node::{SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, NodeData, QualName, local_name, ns};
use std::collections::HashMap;
use style::invalidation::element::restyle_hints::RestyleHint;

/// Browser-facing checkedness which Blitz's render-only checkbox data cannot own correctly.
///
/// Checkedness exists on every HTML input, including while its current type is not checkbox or
/// radio. Keeping that state here preserves the dirty flag and current value across type changes.
/// Raw node ids remain safe only because every Quox destruction path invalidates this map before
/// Blitz can recycle its slab slot; detached inputs intentionally retain their state.
#[derive(Default)]
pub(crate) struct CheckedControlStates {
    controls: HashMap<usize, CheckedControlState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CheckedInputKind {
    Other,
    Checkbox,
    Radio,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CheckedInputDescriptor {
    kind: CheckedInputKind,
    name: Option<String>,
    tree_root: usize,
    form_owner: Option<usize>,
    connected: bool,
}

impl CheckedInputDescriptor {
    fn radio_group(&self) -> Option<RadioGroupKey> {
        if self.kind != CheckedInputKind::Radio {
            return None;
        }
        let name = self.name.as_ref().filter(|name| !name.is_empty())?;
        Some(RadioGroupKey {
            name: name.clone(),
            tree_root: self.tree_root,
            form_owner: self.form_owner,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RadioGroupKey {
    name: String,
    tree_root: usize,
    form_owner: Option<usize>,
}

struct CheckedControlState {
    checked: bool,
    default_checked: bool,
    dirty_checkedness: bool,
    descriptor: CheckedInputDescriptor,
}

impl CheckedControlStates {
    /// Reconcile content attributes, input-type/group transitions, connectivity, and Blitz's
    /// render facade. The text-control owner must reconcile first so a type transition has
    /// already released any obsolete Parley editor before this installs checkbox data.
    pub(crate) fn reconcile_document(&mut self, document: &mut BaseDocument) -> bool {
        self.controls
            .retain(|node_id, _| input_checked_descriptor(document, *node_id).is_some());

        let inputs = dom_child_preorder(document)
            .into_iter()
            .filter_map(|node_id| {
                let descriptor = input_checked_descriptor(document, node_id)?;
                let default_checked = input_checked_attribute(document, node_id);
                Some((node_id, descriptor, default_checked))
            })
            .collect::<Vec<_>>();

        // Record every input before enforcing groups. An initial fragment can contain multiple
        // checked radios; replaying set-to-true actions in actual child preorder makes the later
        // DOM radio win even when Blitz has reused slab slots in a different numeric order.
        let mut set_true = Vec::new();
        for (node_id, descriptor, default_checked) in inputs {
            match self.controls.entry(node_id) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(CheckedControlState {
                        checked: default_checked,
                        default_checked,
                        dirty_checkedness: false,
                        descriptor,
                    });
                    if default_checked {
                        set_true.push(node_id);
                    }
                }
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let state = entry.get_mut();
                    let old_group = state.descriptor.radio_group();
                    let became_connected = !state.descriptor.connected && descriptor.connected;
                    let group_changed = old_group != descriptor.radio_group();
                    let default_changed = state.default_checked != default_checked;

                    state.default_checked = default_checked;
                    state.descriptor = descriptor;
                    if default_changed && !state.dirty_checkedness {
                        state.checked = default_checked;
                        if default_checked {
                            set_true.push(node_id);
                        }
                    } else if state.checked
                        && state.descriptor.kind == CheckedInputKind::Radio
                        && (group_changed || became_connected)
                    {
                        set_true.push(node_id);
                    }
                }
            }
        }

        for node_id in set_true {
            self.set_true_and_enforce_group(node_id);
        }
        self.project_document(document)
    }

    /// Return the current checkedness of any HTML input, irrespective of its current type.
    pub(crate) fn checked(&mut self, document: &mut BaseDocument, node_id: usize) -> Option<bool> {
        self.reconcile_document(document);
        self.controls.get(&node_id).map(|state| state.checked)
    }

    /// Set script checkedness without dispatching an event. An identical assignment still makes
    /// the dirty flag true, while the return value reports only an observable renderer change.
    pub(crate) fn set_checked(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
        checked: bool,
    ) -> Option<bool> {
        let mut rendered_changed = self.reconcile_document(document);
        let state = self.controls.get_mut(&node_id)?;
        state.dirty_checkedness = true;
        state.checked = checked;
        if checked {
            self.set_true_and_enforce_group(node_id);
        }
        rendered_changed |= self.project_document(document);
        Some(rendered_changed)
    }

    /// Import a checkedness mutation made inside pinned Blitz's click default before the generated
    /// `input` record is exposed to JavaScript. Quox then reprojects every state, repairing Blitz's
    /// name-only radio grouping (which can otherwise uncheck unrelated radios and checkboxes).
    pub(crate) fn import_user_activation(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
    ) -> bool {
        let Some(descriptor) = input_checked_descriptor(document, node_id) else {
            return false;
        };
        if !matches!(
            descriptor.kind,
            CheckedInputKind::Checkbox | CheckedInputKind::Radio
        ) {
            return false;
        }
        let Some(blitz_checked) = document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::checkbox_input_checked)
        else {
            return false;
        };
        let previous_checkedness = self
            .controls
            .iter()
            .map(|(node_id, state)| (*node_id, state.checked))
            .collect::<HashMap<_, _>>();

        let default_checked = input_checked_attribute(document, node_id);
        let state = self
            .controls
            .entry(node_id)
            .or_insert_with(|| CheckedControlState {
                checked: default_checked,
                default_checked,
                dirty_checkedness: false,
                descriptor: descriptor.clone(),
            });
        state.default_checked = default_checked;
        state.descriptor = descriptor;
        if state.checked != blitz_checked {
            state.checked = blitz_checked;
            state.dirty_checkedness = true;
        }
        if blitz_checked {
            self.set_true_and_enforce_group(node_id);
        }
        let logically_changed = self
            .controls
            .iter()
            .filter_map(|(node_id, state)| {
                (previous_checkedness.get(node_id) != Some(&state.checked)).then_some(*node_id)
            })
            .collect::<Vec<_>>();
        for changed_id in &logically_changed {
            mark_checkedness_restyle(document, *changed_id);
        }
        self.project_document(document) || !logically_changed.is_empty()
    }

    /// Purge before Blitz destroys nodes because its slab may immediately reuse their ids.
    pub(crate) fn invalidate_nodes(&mut self, node_ids: impl IntoIterator<Item = usize>) {
        for node_id in node_ids {
            self.controls.remove(&node_id);
        }
    }

    fn set_true_and_enforce_group(&mut self, node_id: usize) {
        let Some(state) = self.controls.get_mut(&node_id) else {
            return;
        };
        state.checked = true;
        let Some(group) = state.descriptor.radio_group() else {
            return;
        };

        for (other_id, other) in &mut self.controls {
            if *other_id != node_id && other.descriptor.radio_group().as_ref() == Some(&group) {
                // Radio-group maintenance changes current checkedness, not the peer's dirty flag.
                other.checked = false;
            }
        }
    }

    fn project_document(&self, document: &mut BaseDocument) -> bool {
        let controls = self
            .controls
            .iter()
            .map(|(node_id, state)| (*node_id, state.descriptor.kind, state.checked))
            .collect::<Vec<_>>();
        controls
            .into_iter()
            .fold(false, |changed, (node_id, kind, checked)| {
                project_checkedness(document, node_id, kind, checked) || changed
            })
    }

    #[cfg(test)]
    fn state(&self, node_id: usize) -> Option<&CheckedControlState> {
        self.controls.get(&node_id)
    }
}

fn input_checked_descriptor(
    document: &BaseDocument,
    node_id: usize,
) -> Option<CheckedInputDescriptor> {
    let node = document.get_node(node_id)?;
    let element = node.element_data()?;
    if element.name.ns != ns!(html) || element.name.local.as_ref() != "input" {
        return None;
    }

    let kind = match element
        .attr(local_name!("type"))
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "checkbox" => CheckedInputKind::Checkbox,
        "radio" => CheckedInputKind::Radio,
        _ => CheckedInputKind::Other,
    };
    let tree_root = input_tree_root(document, node_id);
    Some(CheckedInputDescriptor {
        kind,
        name: element.attr(local_name!("name")).map(str::to_owned),
        tree_root,
        form_owner: input_form_owner(document, node_id, tree_root),
        connected: node.flags.is_in_document(),
    })
}

/// Return every live DOM node in child preorder within each connected or detached tree. Root
/// ordering is immaterial to radio exclusivity because distinct roots are distinct groups.
fn dom_child_preorder(document: &BaseDocument) -> Vec<usize> {
    let roots = document
        .tree()
        .iter()
        .filter_map(|(node_id, node)| node.parent.is_none().then_some(node_id))
        .collect::<Vec<_>>();
    let mut preorder = Vec::new();
    for root_id in roots {
        let mut pending = vec![root_id];
        while let Some(node_id) = pending.pop() {
            let Some(node) = document.get_node(node_id) else {
                continue;
            };
            preorder.push(node_id);
            pending.extend(node.children.iter().rev().copied());
        }
    }
    preorder
}

fn input_checked_attribute(document: &BaseDocument, node_id: usize) -> bool {
    document
        .get_node(node_id)
        .and_then(blitz_dom::Node::element_data)
        .is_some_and(|element| element.has_attr(local_name!("checked")))
}

fn input_tree_root(document: &BaseDocument, mut node_id: usize) -> usize {
    while let Some(parent) = document.get_node(node_id).and_then(|node| node.parent) {
        node_id = parent;
    }
    node_id
}

fn input_form_owner(document: &BaseDocument, node_id: usize, tree_root: usize) -> Option<usize> {
    let node = document.get_node(node_id)?;
    let element = node.element_data()?;
    if node.flags.is_in_document()
        && let Some(form_id) = element.attr(local_name!("form"))
    {
        if form_id.is_empty() {
            return None;
        }
        // The first element with the requested id decides association, even when it is not a
        // form. Explicit reassociation applies only while the control is connected.
        let owner = first_element_with_id(document, tree_root, form_id)?;
        return is_html_form(document, owner).then_some(owner);
    }

    let mut ancestor = document.get_node(node_id).and_then(|node| node.parent);
    while let Some(ancestor_id) = ancestor {
        if is_html_form(document, ancestor_id) {
            return Some(ancestor_id);
        }
        ancestor = document.get_node(ancestor_id).and_then(|node| node.parent);
    }
    None
}

fn first_element_with_id(
    document: &BaseDocument,
    root_id: usize,
    requested_id: &str,
) -> Option<usize> {
    let mut pending = vec![root_id];
    while let Some(node_id) = pending.pop() {
        let node = document.get_node(node_id)?;
        if node
            .element_data()
            .and_then(|element| element.attr(local_name!("id")))
            == Some(requested_id)
        {
            return Some(node_id);
        }
        pending.extend(node.children.iter().rev().copied());
    }
    None
}

fn is_html_form(document: &BaseDocument, node_id: usize) -> bool {
    document
        .get_node(node_id)
        .and_then(blitz_dom::Node::element_data)
        .is_some_and(|element| {
            element.name.ns == ns!(html) && element.name.local.as_ref() == "form"
        })
}

fn project_checkedness(
    document: &mut BaseDocument,
    node_id: usize,
    kind: CheckedInputKind,
    checked: bool,
) -> bool {
    let changed = {
        let Some(node) = document.get_node_mut(node_id) else {
            return false;
        };
        let Some(element) = node.element_data_mut() else {
            return false;
        };
        if matches!(kind, CheckedInputKind::Checkbox | CheckedInputKind::Radio) {
            if let SpecialElementData::CheckboxInput(rendered_checked) = &mut element.special_data {
                if *rendered_checked == checked {
                    false
                } else {
                    *rendered_checked = checked;
                    true
                }
            } else {
                element.special_data = SpecialElementData::CheckboxInput(checked);
                true
            }
        } else if matches!(element.special_data, SpecialElementData::CheckboxInput(_)) {
            element.special_data = SpecialElementData::None;
            true
        } else {
            false
        }
    };
    if changed {
        mark_checkedness_restyle(document, node_id);
    }
    changed
}

fn mark_checkedness_restyle(document: &mut BaseDocument, node_id: usize) {
    let parent_id = document.get_node(node_id).and_then(|node| node.parent);
    if let Some(node) = document.get_node_mut(node_id) {
        node.set_restyle_hint(RestyleHint::restyle_subtree());
    }
    // `:checked` can select later siblings. Match Blitz's attribute invalidation by rematching the
    // parent subtree too; the input hint remains necessary for a detached root without a parent.
    if let Some(parent_id) = parent_id
        && let Some(parent) = document.get_node_mut(parent_id)
    {
        parent.set_restyle_hint(RestyleHint::restyle_subtree());
    }
}

/// Browser-facing live value state which Blitz's render-only controls do not retain themselves.
///
/// Raw node ids are safe keys only while this map is purged before Blitz drops nodes and can
/// recycle their slab slots. Detached nodes remain in Blitz's slab, so their state deliberately
/// remains here as well.
#[derive(Default)]
pub(crate) struct TextControlStates {
    controls: HashMap<usize, TextControlState>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum TextControlSelectionDirection {
    #[default]
    None,
    Forward,
    Backward,
}

impl TextControlSelectionDirection {
    pub(crate) fn from_wire_value(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::None),
            1 => Some(Self::Forward),
            2 => Some(Self::Backward),
            _ => None,
        }
    }

    pub(crate) const fn wire_value(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Forward => 1,
            Self::Backward => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TextControlSelection {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) direction: TextControlSelectionDirection,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct EditorSelectionState {
    anchor: usize,
    focus: usize,
    direction: TextControlSelectionDirection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextControlKind {
    InputText,
    InputUrl,
    InputEmail,
    InputMultipleEmail,
    InputNumber,
    InputDate,
    InputMonth,
    InputWeek,
    InputTime,
    InputDateTimeLocal,
    TextArea,
}

impl TextControlKind {
    fn uses_text_editor(self) -> bool {
        matches!(
            self,
            Self::InputText
                | Self::InputUrl
                | Self::InputEmail
                | Self::InputMultipleEmail
                | Self::InputNumber
                | Self::TextArea
        )
    }

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
            Self::InputDate => sanitize_date(value),
            Self::InputMonth => sanitize_month(value),
            Self::InputWeek => sanitize_week(value),
            Self::InputTime => sanitize_time(value),
            Self::InputDateTimeLocal => sanitize_local_date_time(value),
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
    /// Parley's raw UTF-8 anchor/focus plus the browser direction which Parley cannot represent
    /// independently (most importantly, a non-collapsed selection with direction `none`).
    selection: EditorSelectionState,
    dirty_value: bool,
    /// False while an otherwise-retained value is passing through a value-mode which Quox cannot
    /// yet expose or sanitize (currently range and color).
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
        // A script type mutation can move directly from an editor-backed value state into a
        // non-editor date/time state. Capture the old editor before choosing the destination
        // sanitizer or clearing Blitz's special data.
        if self
            .controls
            .get(&node_id)
            .is_some_and(|control| control.kind != kind)
        {
            self.sync_editor_value(document, node_id);
        }
        self.sync_editor_selection(document, node_id);
        let control = self
            .controls
            .entry(node_id)
            .or_insert_with(|| TextControlState {
                kind,
                value: kind.normalize_value(&default_value),
                editor_value: kind.normalize_value(&default_value),
                default_value: default_value.clone(),
                selection: EditorSelectionState::default(),
                dirty_value: false,
                active: true,
            });

        let selection_projection_kind = control.kind;
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
        let preserved_direction = control.selection.direction;
        if kind.uses_text_editor() {
            ensure_text_editor(document, node_id, kind);
            apply_value_to_editor(
                document,
                node_id,
                &editor_value,
                false,
                selection_projection_kind,
            );
            if move_selection_to_start {
                document.with_text_input(node_id, |mut driver| driver.move_to_text_start());
            }
            self.record_editor_selection(
                document,
                node_id,
                if move_selection_to_start {
                    TextControlSelectionDirection::None
                } else {
                    preserved_direction
                },
            );
        } else {
            clear_text_editor(document, node_id);
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

        self.sync_editor_selection(document, node_id);
        let (value, value_changed, editor_changed, preserved_direction, kind) = {
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
            (
                value,
                value_changed,
                editor_changed,
                control.selection.direction,
                control.kind,
            )
        };
        apply_value_to_editor(document, node_id, &value, value_changed, kind);
        self.record_editor_selection(
            document,
            node_id,
            if value_changed {
                TextControlSelectionDirection::None
            } else {
                preserved_direction
            },
        );
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
        let Some(snapshot) = editor_snapshot(document, node_id) else {
            return false;
        };
        self.sync_editor_selection_from_snapshot(node_id, &snapshot);
        let raw_editor_value = snapshot.raw_text;
        let composing = snapshot.composing;
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
            let control = self
                .controls
                .get(&node_id)
                .expect("a reconciled editor has browser state");
            let preserved_direction = control.selection.direction;
            let kind = control.kind;
            apply_value_to_editor(document, node_id, &editor_value, false, kind);
            self.record_editor_selection(document, node_id, preserved_direction);
        }
        changed
    }

    fn sync_editor_selection(&mut self, document: &BaseDocument, node_id: usize) {
        let Some(snapshot) = editor_snapshot(document, node_id) else {
            return;
        };
        self.sync_editor_selection_from_snapshot(node_id, &snapshot);
    }

    fn sync_editor_selection_from_snapshot(&mut self, node_id: usize, snapshot: &EditorSnapshot) {
        let Some(control) = self.controls.get_mut(&node_id) else {
            return;
        };
        if (control.selection.anchor, control.selection.focus) == (snapshot.anchor, snapshot.focus)
        {
            return;
        }

        control.selection = EditorSelectionState {
            anchor: snapshot.anchor,
            focus: snapshot.focus,
            direction: selection_direction_from_editor(snapshot.anchor, snapshot.focus),
        };
    }

    fn record_editor_selection(
        &mut self,
        document: &BaseDocument,
        node_id: usize,
        direction: TextControlSelectionDirection,
    ) {
        let Some(snapshot) = editor_snapshot(document, node_id) else {
            return;
        };
        let Some(control) = self.controls.get_mut(&node_id) else {
            return;
        };
        control.selection = EditorSelectionState {
            anchor: snapshot.anchor,
            focus: snapshot.focus,
            direction,
        };
    }

    /// Return the browser selection for input states to which the range APIs apply, and for every
    /// textarea. Offsets are UTF-16 code units in the sanitized API value, not Parley's UTF-8
    /// buffer coordinates.
    pub(crate) fn selection(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
    ) -> Option<TextControlSelection> {
        self.prepare_managed_control(document, node_id);
        self.sync_editor_selection(document, node_id);
        self.supported_selection(document, node_id)
    }

    /// Apply HTML's set-the-selection-range algorithm. `None` distinguishes input states for
    /// which setters must throw `InvalidStateError` from a supported no-op.
    pub(crate) fn set_selection_range(
        &mut self,
        document: &mut BaseDocument,
        node_id: usize,
        mut start: usize,
        mut end: usize,
        direction: TextControlSelectionDirection,
    ) -> Option<bool> {
        self.prepare_managed_control(document, node_id);
        self.sync_editor_selection(document, node_id);
        let old_selection = self.supported_selection(document, node_id)?;
        let old_editor_selection = self.controls.get(&node_id)?.selection;
        let (kind, value_len) = {
            let control = self.controls.get(&node_id)?;
            (control.kind, control.value.encode_utf16().count())
        };

        start = start.min(value_len);
        end = end.min(value_len);
        if end <= start {
            start = end;
        }

        let snapshot = editor_snapshot(document, node_id)?;
        let projection = SelectionProjection::new(kind, &snapshot.raw_text);
        let raw_start = projection.raw_byte_for_utf16(start);
        let raw_end = projection.raw_byte_for_utf16(end);
        let (anchor, focus) = if direction == TextControlSelectionDirection::Backward {
            (raw_end, raw_start)
        } else {
            (raw_start, raw_end)
        };
        document.with_text_input(node_id, |mut driver| {
            driver.select_byte_range(anchor, focus);
        });
        self.record_editor_selection(document, node_id, direction);

        let new_selection = self.supported_selection(document, node_id)?;
        let new_editor_selection = self.controls.get(&node_id)?.selection;
        Some(new_selection != old_selection || new_editor_selection != old_editor_selection)
    }

    /// Select all text exposed by the current editor. HTML permits `select()` on a few input
    /// states whose range properties do not apply (notably email and number), while controls with
    /// no selectable text simply ignore the call.
    pub(crate) fn select_all(&mut self, document: &mut BaseDocument, node_id: usize) -> bool {
        self.prepare_managed_control(document, node_id);
        self.sync_editor_selection(document, node_id);
        let Some(control) = self.controls.get(&node_id) else {
            return false;
        };
        if !control.active {
            return false;
        }
        if control.kind.supports_selection() {
            let value_len = control.value.encode_utf16().count();
            return self
                .set_selection_range(
                    document,
                    node_id,
                    0,
                    value_len,
                    TextControlSelectionDirection::None,
                )
                .unwrap_or(false);
        }

        let Some(before) = editor_snapshot(document, node_id) else {
            return false;
        };
        let before_state = self
            .controls
            .get(&node_id)
            .expect("the managed control state remains present")
            .selection;
        let raw_len = before.raw_text.len();
        document.with_text_input(node_id, |mut driver| {
            driver.select_byte_range(0, raw_len);
        });
        self.record_editor_selection(document, node_id, TextControlSelectionDirection::None);
        let Some(after) = editor_snapshot(document, node_id) else {
            return false;
        };
        before_state
            != EditorSelectionState {
                anchor: after.anchor,
                focus: after.focus,
                direction: TextControlSelectionDirection::None,
            }
    }

    fn prepare_managed_control(&mut self, document: &mut BaseDocument, node_id: usize) -> bool {
        if self.controls.contains_key(&node_id) {
            self.sync_editor_value(document, node_id);
        }
        self.reconcile_control(document, node_id)
    }

    fn supported_selection(
        &self,
        document: &BaseDocument,
        node_id: usize,
    ) -> Option<TextControlSelection> {
        let control = self.controls.get(&node_id)?;
        if !control.active || !control.kind.supports_selection() {
            return None;
        }
        let snapshot = editor_snapshot(document, node_id)?;
        let projection = SelectionProjection::new(control.kind, &snapshot.raw_text);
        debug_assert_eq!(
            control.kind.normalize_user_value(&snapshot.raw_text),
            control.value
        );
        let anchor = projection.utf16_for_raw_byte(snapshot.anchor);
        let focus = projection.utf16_for_raw_byte(snapshot.focus);
        Some(TextControlSelection {
            start: anchor.min(focus),
            end: anchor.max(focus),
            direction: control.selection.direction,
        })
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
                "date" => TextControlKind::InputDate,
                "month" => TextControlKind::InputMonth,
                "week" => TextControlKind::InputWeek,
                "time" => TextControlKind::InputTime,
                "datetime-local" => TextControlKind::InputDateTimeLocal,
                // Non-value modes and the remaining unsupported Blitz value modes are outside
                // this live-value owner.
                "hidden" | "range" | "color" | "checkbox" | "radio" | "file" | "submit"
                | "image" | "reset" | "button" => return None,
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
        "range" | "color" => Some(UnmanagedInputMode::UnsupportedValue),
        "hidden" | "submit" | "image" | "reset" | "button" => Some(UnmanagedInputMode::Default),
        "checkbox" | "radio" => Some(UnmanagedInputMode::DefaultOn),
        "file" => Some(UnmanagedInputMode::Filename),
        _ => None,
    }
}

fn sanitize_date(value: &str) -> String {
    parse_date_prefix(value.as_bytes())
        .filter(|(_, end)| *end == value.len())
        .map_or_else(String::new, |_| value.to_owned())
}

fn sanitize_month(value: &str) -> String {
    parse_month_prefix(value.as_bytes())
        .filter(|(_, _, end)| *end == value.len())
        .map_or_else(String::new, |_| value.to_owned())
}

fn sanitize_week(value: &str) -> String {
    let bytes = value.as_bytes();
    let Some((year, year_end)) = parse_year_prefix(bytes) else {
        return String::new();
    };
    if bytes.get(year_end..year_end + 2) != Some(b"-W") || value.len() != year_end + 4 {
        return String::new();
    }
    let Some(week) = ascii_two_digits(bytes, year_end + 2) else {
        return String::new();
    };
    if week == 0 || week > weeks_in_year(year) {
        return String::new();
    }
    value.to_owned()
}

fn sanitize_time(value: &str) -> String {
    parse_time(value.as_bytes()).map_or_else(String::new, |_| value.to_owned())
}

fn sanitize_local_date_time(value: &str) -> String {
    let bytes = value.as_bytes();
    let Some((_, date_end)) = parse_date_prefix(bytes) else {
        return String::new();
    };
    if !matches!(bytes.get(date_end), Some(b'T' | b' ')) {
        return String::new();
    }
    let time = &bytes[date_end + 1..];
    let Some(parsed_time) = parse_time(time) else {
        return String::new();
    };

    let mut normalized = String::with_capacity(value.len());
    normalized.push_str(&value[..date_end]);
    normalized.push('T');
    normalized
        .push_str(std::str::from_utf8(&time[..5]).expect("a parsed HTML time prefix is ASCII"));
    let fraction_end = parsed_time
        .fraction
        .iter()
        .rposition(|digit| *digit != b'0')
        .map_or(0, |index| index + 1);
    let fraction = &parsed_time.fraction[..fraction_end];
    if parsed_time.second != 0 || !fraction.is_empty() {
        normalized.push(':');
        normalized
            .push_str(std::str::from_utf8(&time[6..8]).expect("parsed HTML seconds are ASCII"));
        if !fraction.is_empty() {
            normalized.push('.');
            normalized.push_str(
                std::str::from_utf8(fraction).expect("a parsed HTML second fraction is ASCII"),
            );
        }
    }
    normalized
}

fn parse_year_prefix(bytes: &[u8]) -> Option<(&[u8], usize)> {
    let year_end = bytes
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(bytes.len());
    let year = bytes.get(..year_end)?;
    (year.len() >= 4 && year.iter().any(|byte| *byte != b'0')).then_some((year, year_end))
}

fn parse_month_prefix(bytes: &[u8]) -> Option<(&[u8], u8, usize)> {
    let (year, year_end) = parse_year_prefix(bytes)?;
    if bytes.get(year_end) != Some(&b'-') {
        return None;
    }
    let month = ascii_two_digits(bytes, year_end + 1)?;
    (1..=12)
        .contains(&month)
        .then_some((year, month, year_end + 3))
}

fn parse_date_prefix(bytes: &[u8]) -> Option<(&[u8], usize)> {
    let (year, month, month_end) = parse_month_prefix(bytes)?;
    if bytes.get(month_end) != Some(&b'-') {
        return None;
    }
    let day = ascii_two_digits(bytes, month_end + 1)?;
    (day != 0 && day <= days_in_month(year, month)).then_some((year, month_end + 3))
}

struct ParsedTime<'a> {
    second: u8,
    fraction: &'a [u8],
}

fn parse_time(bytes: &[u8]) -> Option<ParsedTime<'_>> {
    let hour = ascii_two_digits(bytes, 0)?;
    if hour > 23 || bytes.get(2) != Some(&b':') {
        return None;
    }
    let minute = ascii_two_digits(bytes, 3)?;
    if minute > 59 {
        return None;
    }
    if bytes.len() == 5 {
        return Some(ParsedTime {
            second: 0,
            fraction: &[],
        });
    }
    if bytes.get(5) != Some(&b':') {
        return None;
    }
    let second = ascii_two_digits(bytes, 6)?;
    if second > 59 {
        return None;
    }
    if bytes.len() == 8 {
        return Some(ParsedTime {
            second,
            fraction: &[],
        });
    }
    if bytes.get(8) != Some(&b'.') {
        return None;
    }
    let fraction = bytes.get(9..)?;
    if !(1..=3).contains(&fraction.len()) || !fraction.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(ParsedTime { second, fraction })
}

fn ascii_two_digits(bytes: &[u8], index: usize) -> Option<u8> {
    let tens = *bytes.get(index)?;
    let ones = *bytes.get(index + 1)?;
    if !tens.is_ascii_digit() || !ones.is_ascii_digit() {
        return None;
    }
    Some((tens - b'0') * 10 + (ones - b'0'))
}

fn year_modulo(year: &[u8], divisor: u16) -> u16 {
    year.iter().fold(0, |remainder, digit| {
        (remainder * 10 + u16::from(*digit - b'0')) % divisor
    })
}

fn is_leap_year(year: &[u8]) -> bool {
    year_modulo(year, 400) == 0 || (year_modulo(year, 4) == 0 && year_modulo(year, 100) != 0)
}

fn days_in_month(year: &[u8], month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn weeks_in_year(year: &[u8]) -> u8 {
    // The Gregorian calendar repeats every 400 years, including its weekday alignment. Map a
    // multiple of 400 to year 400 so the positive-year weekday formula stays well-defined.
    let cycle_year = match year_modulo(year, 400) {
        0 => 400,
        year => year,
    };
    let previous = cycle_year - 1;
    let january_first = (cycle_year + previous / 4 - previous / 100 + previous / 400) % 7;
    if january_first == 4 || (january_first == 3 && is_leap_year(year)) {
        53
    } else {
        52
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

struct EditorSnapshot {
    raw_text: String,
    composing: bool,
    anchor: usize,
    focus: usize,
}

fn editor_snapshot(document: &BaseDocument, node_id: usize) -> Option<EditorSnapshot> {
    let editor = &document
        .get_node(node_id)?
        .element_data()?
        .text_input_data()?
        .editor;
    let selection = editor.raw_selection();
    Some(EditorSnapshot {
        raw_text: editor.raw_text().to_owned(),
        composing: editor.raw_compose().is_some(),
        anchor: selection.anchor().index(),
        focus: selection.focus().index(),
    })
}

fn selection_direction_from_editor(anchor: usize, focus: usize) -> TextControlSelectionDirection {
    match anchor.cmp(&focus) {
        std::cmp::Ordering::Less => TextControlSelectionDirection::Forward,
        std::cmp::Ordering::Equal => TextControlSelectionDirection::None,
        std::cmp::Ordering::Greater => TextControlSelectionDirection::Backward,
    }
}

#[derive(Clone, Copy)]
struct ProjectedCharacter {
    raw_start: usize,
    raw_end: usize,
    utf16_start: usize,
    utf16_end: usize,
}

/// Monotonic projection between Parley's exact raw buffer and the sanitized value on which HTML
/// defines selection offsets. The two differ only transiently while composition is active, but
/// selection APIs remain synchronous and observable during that interval.
struct SelectionProjection {
    characters: Vec<ProjectedCharacter>,
    utf16_len: usize,
}

impl SelectionProjection {
    fn new(kind: TextControlKind, raw_text: &str) -> Self {
        let raw_characters = raw_text
            .char_indices()
            .map(|(raw_start, character)| (raw_start, raw_start + character.len_utf8(), character))
            .collect::<Vec<_>>();
        let emitted = match kind {
            TextControlKind::InputText => raw_characters
                .into_iter()
                .filter(|(_, _, character)| !matches!(character, '\r' | '\n'))
                .collect::<Vec<_>>(),
            TextControlKind::InputUrl => {
                let filtered = raw_characters
                    .into_iter()
                    .filter(|(_, _, character)| !matches!(character, '\r' | '\n'))
                    .collect::<Vec<_>>();
                let first = filtered.iter().position(|(_, _, character)| {
                    !matches!(character, '\u{0009}' | '\u{000c}' | '\u{0020}')
                });
                let last = filtered.iter().rposition(|(_, _, character)| {
                    !matches!(character, '\u{0009}' | '\u{000c}' | '\u{0020}')
                });
                match (first, last) {
                    (Some(first), Some(last)) => filtered[first..=last].to_vec(),
                    _ => Vec::new(),
                }
            }
            TextControlKind::TextArea => {
                let mut emitted = Vec::with_capacity(raw_characters.len());
                let mut index = 0;
                while let Some(&(raw_start, mut raw_end, character)) = raw_characters.get(index) {
                    if character == '\r' {
                        if let Some(&(_, next_end, '\n')) = raw_characters.get(index + 1) {
                            raw_end = next_end;
                            index += 1;
                        }
                        emitted.push((raw_start, raw_end, '\n'));
                    } else {
                        emitted.push((raw_start, raw_end, character));
                    }
                    index += 1;
                }
                emitted
            }
            // Range properties do not apply to these states. Keeping an identity projection makes
            // this helper robust if another caller inspects their editor in the future.
            TextControlKind::InputEmail
            | TextControlKind::InputMultipleEmail
            | TextControlKind::InputNumber
            | TextControlKind::InputDate
            | TextControlKind::InputMonth
            | TextControlKind::InputWeek
            | TextControlKind::InputTime
            | TextControlKind::InputDateTimeLocal => raw_characters,
        };

        let mut utf16_len = 0;
        let characters = emitted
            .into_iter()
            .map(|(raw_start, raw_end, character)| {
                let utf16_start = utf16_len;
                utf16_len += character.len_utf16();
                ProjectedCharacter {
                    raw_start,
                    raw_end,
                    utf16_start,
                    utf16_end: utf16_len,
                }
            })
            .collect();
        Self {
            characters,
            utf16_len,
        }
    }

    fn utf16_for_raw_byte(&self, raw_offset: usize) -> usize {
        let mut offset = 0;
        for character in &self.characters {
            if raw_offset <= character.raw_start {
                return character.utf16_start;
            }
            if raw_offset < character.raw_end {
                return character.utf16_start;
            }
            offset = character.utf16_end;
        }
        offset
    }

    fn raw_byte_for_utf16(&self, utf16_offset: usize) -> usize {
        let utf16_offset = utf16_offset.min(self.utf16_len);
        for (index, character) in self.characters.iter().enumerate() {
            if utf16_offset <= character.utf16_start || utf16_offset < character.utf16_end {
                return character.raw_start;
            }
            if utf16_offset == character.utf16_end {
                return self
                    .characters
                    .get(index + 1)
                    .map_or(character.raw_end, |next| next.raw_start);
            }
        }
        0
    }
}

fn apply_value_to_editor(
    document: &mut BaseDocument,
    node_id: usize,
    value: &str,
    move_caret_to_end: bool,
    selection_projection_kind: TextControlKind,
) {
    document.with_text_input(node_id, |mut driver| {
        if driver.editor.raw_text() == value {
            return;
        }
        let old_text = driver.editor.raw_text().to_owned();
        let old_selection = driver.editor.raw_selection();
        let projection = SelectionProjection::new(selection_projection_kind, &old_text);
        let anchor_utf16 = projection.utf16_for_raw_byte(old_selection.anchor().index());
        let focus_utf16 = projection.utf16_for_raw_byte(old_selection.focus().index());
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
    use super::{
        CheckedControlStates, CheckedInputKind, SpecialElementData, TextControlSelection,
        TextControlSelectionDirection, TextControlStates, restore_text_editor,
    };
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

    fn checked_attribute() -> QualName {
        QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("checked"),
        }
    }

    fn name_attribute() -> QualName {
        QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("name"),
        }
    }

    fn form_attribute() -> QualName {
        QualName {
            prefix: None,
            ns: ns!(),
            local: local_name!("form"),
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

    fn raw_editor_selection(document: &BaseDocument, node_id: usize) -> (usize, usize) {
        let selection = document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::text_input_data)
            .expect("test node should have an editor")
            .editor
            .raw_selection();
        (selection.anchor().index(), selection.focus().index())
    }

    fn rendered_checked(document: &BaseDocument, node_id: usize) -> Option<bool> {
        document
            .get_node(node_id)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::checkbox_input_checked)
    }

    fn set_rendered_checked(document: &mut BaseDocument, node_id: usize, checked: bool) {
        let element = document
            .get_node_mut(node_id)
            .and_then(blitz_dom::Node::element_data_mut)
            .expect("test input should remain an element");
        element.special_data = SpecialElementData::CheckboxInput(checked);
    }

    #[test]
    fn checked_attribute_follows_current_state_only_while_clean() {
        let mut document =
            document("<input id='clean' type='checkbox'><input id='dirty' type='checkbox'>");
        let clean = element(&document, "clean");
        let dirty = element(&document, "dirty");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        document
            .mutate()
            .set_attribute(clean, checked_attribute(), "false");
        controls.reconcile_document(&mut document);
        assert!(controls.checked(&mut document, clean).unwrap());
        assert!(controls.state(clean).unwrap().default_checked);
        assert_eq!(rendered_checked(&document, clean), Some(true));

        document
            .mutate()
            .clear_attribute(clean, checked_attribute());
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, clean).unwrap());

        assert_eq!(
            controls.set_checked(&mut document, dirty, false),
            Some(false)
        );
        assert!(controls.state(dirty).unwrap().dirty_checkedness);
        document
            .mutate()
            .set_attribute(dirty, checked_attribute(), "");
        controls.reconcile_document(&mut document);
        let dirty_state = controls.state(dirty).unwrap();
        assert!(dirty_state.default_checked);
        assert!(!dirty_state.checked);
        assert_eq!(rendered_checked(&document, dirty), Some(false));

        document
            .mutate()
            .clear_attribute(dirty, checked_attribute());
        controls.reconcile_document(&mut document);
        assert!(!controls.state(dirty).unwrap().default_checked);
        assert!(!controls.state(dirty).unwrap().checked);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the CSS pixel widths are copied exactly in this regression"
    )]
    fn checkedness_restyles_sibling_selectors() {
        let mut document = document(
            "<style>\
               #label { display: block; width: 10px; height: 1px }\
               #check:checked + #label { width: 20px }\
             </style>\
             <input id='check' type='checkbox'>\
             <label id='label'></label>",
        );
        let check = element(&document, "check");
        let label = element(&document, "label");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);
        document.resolve(0.0);
        assert_eq!(
            document.get_node(label).unwrap().final_layout.size.width,
            10.0
        );

        assert_eq!(controls.set_checked(&mut document, check, true), Some(true));
        document.resolve(1.0);
        assert_eq!(
            document.get_node(label).unwrap().final_layout.size.width,
            20.0
        );
    }

    #[test]
    fn checkedness_and_dirty_state_survive_every_input_type_transition() {
        let mut document = document("<input id='field' checked>");
        let field = element(&document, "field");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        assert!(controls.checked(&mut document, field).unwrap());
        assert_eq!(
            controls.state(field).unwrap().descriptor.kind,
            CheckedInputKind::Other
        );
        assert!(!matches!(
            document
                .get_node(field)
                .unwrap()
                .element_data()
                .unwrap()
                .special_data,
            SpecialElementData::CheckboxInput(_)
        ));

        assert_eq!(
            controls.set_checked(&mut document, field, false),
            Some(false)
        );
        set_input_type(&mut document, field, "checkbox");
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, field).unwrap());
        assert_eq!(rendered_checked(&document, field), Some(false));

        set_input_type(&mut document, field, "text");
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, field).unwrap());
        assert!(!matches!(
            document
                .get_node(field)
                .unwrap()
                .element_data()
                .unwrap()
                .special_data,
            SpecialElementData::CheckboxInput(_)
        ));
        document
            .mutate()
            .set_attribute(field, checked_attribute(), "");
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, field).unwrap());

        set_input_type(&mut document, field, "radio");
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, field).unwrap());
        assert_eq!(rendered_checked(&document, field), Some(false));
        assert!(controls.state(field).unwrap().dirty_checkedness);
    }

    #[test]
    fn radio_groups_use_exact_name_tree_and_form_owner_without_dirtying_peers() {
        let mut document = document(
            "<form id='first'>\
               <input id='a' type='radio' name='group' checked disabled>\
               <input id='b' type='radio' name='group' checked>\
             </form>\
             <form id='second'><input id='other-form' type='radio' name='group' checked></form>\
             <input id='case' type='radio' name='Group' checked>\
             <input id='box' type='checkbox' name='group' checked>\
             <input id='nameless-a' type='radio' checked>\
             <input id='nameless-b' type='radio' checked>\
             <input id='empty-a' type='radio' name='' checked>\
             <input id='empty-b' type='radio' name='' checked>",
        );
        let [
            a,
            b,
            other_form,
            case,
            checkbox,
            nameless_a,
            nameless_b,
            empty_a,
            empty_b,
        ] = [
            "a",
            "b",
            "other-form",
            "case",
            "box",
            "nameless-a",
            "nameless-b",
            "empty-a",
            "empty-b",
        ]
        .map(|id| element(&document, id));
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        assert!(!controls.checked(&mut document, a).unwrap());
        assert!(controls.checked(&mut document, b).unwrap());
        assert!(controls.checked(&mut document, other_form).unwrap());
        assert!(controls.checked(&mut document, case).unwrap());
        assert!(controls.checked(&mut document, checkbox).unwrap());
        assert!(controls.checked(&mut document, nameless_a).unwrap());
        assert!(controls.checked(&mut document, nameless_b).unwrap());
        assert!(controls.checked(&mut document, empty_a).unwrap());
        assert!(controls.checked(&mut document, empty_b).unwrap());

        controls.set_checked(&mut document, a, true);
        assert!(controls.checked(&mut document, a).unwrap());
        assert!(!controls.checked(&mut document, b).unwrap());
        assert!(!controls.state(b).unwrap().dirty_checkedness);
        assert!(controls.checked(&mut document, other_form).unwrap());
        assert!(controls.checked(&mut document, case).unwrap());
        assert!(controls.checked(&mut document, checkbox).unwrap());

        controls.set_checked(&mut document, nameless_b, true);
        controls.set_checked(&mut document, empty_b, true);
        assert!(controls.checked(&mut document, nameless_a).unwrap());
        assert!(controls.checked(&mut document, nameless_b).unwrap());
        assert!(controls.checked(&mut document, empty_a).unwrap());
        assert!(controls.checked(&mut document, empty_b).unwrap());
    }

    #[test]
    fn connected_form_attributes_override_ancestors_only_when_the_id_resolves() {
        let mut document = document(
            "<form id='ancestor'>\
               <input id='missing' type='radio' name='group' checked>\
               <input id='empty' type='radio' name='group' form='' checked>\
               <input id='nonexistent' type='radio' name='group' form='missing-form' checked>\
               <input id='explicit' type='radio' name='group' form='sibling' checked>\
             </form>\
             <form id='sibling'>\
               <input id='sibling-member' type='radio' name='group' checked>\
             </form>",
        );
        let ancestor = element(&document, "ancestor");
        let sibling = element(&document, "sibling");
        let missing = element(&document, "missing");
        let empty = element(&document, "empty");
        let nonexistent = element(&document, "nonexistent");
        let explicit = element(&document, "explicit");
        let sibling_member = element(&document, "sibling-member");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        assert_eq!(
            controls.state(missing).unwrap().descriptor.form_owner,
            Some(ancestor)
        );
        assert_eq!(controls.state(empty).unwrap().descriptor.form_owner, None);
        assert_eq!(
            controls.state(nonexistent).unwrap().descriptor.form_owner,
            None
        );
        assert_eq!(
            controls.state(explicit).unwrap().descriptor.form_owner,
            Some(sibling)
        );
        assert_eq!(
            controls
                .state(sibling_member)
                .unwrap()
                .descriptor
                .form_owner,
            Some(sibling)
        );

        assert!(controls.checked(&mut document, missing).unwrap());
        assert!(!controls.checked(&mut document, empty).unwrap());
        assert!(controls.checked(&mut document, nonexistent).unwrap());
        assert!(!controls.checked(&mut document, explicit).unwrap());
        assert!(controls.checked(&mut document, sibling_member).unwrap());
    }

    #[test]
    fn disconnected_inputs_ignore_form_ids_and_fall_back_to_ancestor_forms() {
        let mut document = document(
            "<div id='detached-root'>\
               <form id='ancestor'>\
                 <input id='missing' type='radio' name='inside' checked>\
                 <input id='empty' type='radio' name='inside' form='' checked>\
                 <input id='nonexistent' type='radio' name='inside' form='missing-form' checked>\
                 <input id='explicit-sibling' type='radio' name='inside' form='sibling' checked>\
               </form>\
               <form id='sibling'><input id='sibling-member' type='radio' name='inside' checked></form>\
               <input id='outside-explicit' type='radio' name='outside' form='sibling' checked>\
               <input id='outside-missing' type='radio' name='outside' checked>\
             </div>",
        );
        let detached_root = element(&document, "detached-root");
        let ancestor = element(&document, "ancestor");
        let sibling = element(&document, "sibling");
        let missing = element(&document, "missing");
        let empty = element(&document, "empty");
        let nonexistent = element(&document, "nonexistent");
        let explicit_sibling = element(&document, "explicit-sibling");
        let sibling_member = element(&document, "sibling-member");
        let outside_explicit = element(&document, "outside-explicit");
        let outside_missing = element(&document, "outside-missing");
        document.mutate().remove_node(detached_root);
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        for input in [missing, empty, nonexistent, explicit_sibling] {
            assert_eq!(
                controls.state(input).unwrap().descriptor.form_owner,
                Some(ancestor),
                "every disconnected descendant falls back to its ancestor form",
            );
        }
        assert_eq!(
            controls
                .state(sibling_member)
                .unwrap()
                .descriptor
                .form_owner,
            Some(sibling)
        );
        assert_eq!(
            controls
                .state(outside_explicit)
                .unwrap()
                .descriptor
                .form_owner,
            None,
            "a detached sibling form cannot be selected through the form attribute",
        );
        assert_eq!(
            controls
                .state(outside_missing)
                .unwrap()
                .descriptor
                .form_owner,
            None
        );

        assert!(!controls.checked(&mut document, missing).unwrap());
        assert!(!controls.checked(&mut document, empty).unwrap());
        assert!(!controls.checked(&mut document, nonexistent).unwrap());
        assert!(controls.checked(&mut document, explicit_sibling).unwrap());
        assert!(controls.checked(&mut document, sibling_member).unwrap());
        assert!(!controls.checked(&mut document, outside_explicit).unwrap());
        assert!(controls.checked(&mut document, outside_missing).unwrap());
    }

    #[test]
    fn initial_radio_replay_uses_dom_preorder_after_inner_html_reuses_slots() {
        let mut document = document("<div id='host'><i></i><b></b></div>");
        let host = element(&document, "host");
        document.mutate().set_inner_html(
            host,
            "<input id='tree-first' type='radio' name='group' checked>\
             <input id='tree-last' type='radio' name='group' checked>",
        );
        let tree_first = element(&document, "tree-first");
        let tree_last = element(&document, "tree-last");
        {
            let mut mutator = document.mutate();
            mutator.remove_node(tree_last);
            mutator.remove_node(tree_first);
            mutator.append_children(host, &[tree_last, tree_first]);
        }
        assert_eq!(
            document.get_node(host).unwrap().children,
            [tree_last, tree_first],
        );
        let slab_order = document
            .tree()
            .iter()
            .filter_map(|(node_id, _)| {
                matches!(node_id, id if id == tree_first || id == tree_last).then_some(node_id)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            slab_order,
            [tree_first, tree_last],
            "the fixture must make raw slab order disagree with DOM child order",
        );

        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);
        assert!(!controls.checked(&mut document, tree_last).unwrap());
        assert!(controls.checked(&mut document, tree_first).unwrap());
    }

    #[test]
    fn checked_radios_reconcile_name_type_form_and_connection_changes() {
        let mut document = document(
            "<div id='host'>\
               <form id='first'><input id='a' type='radio' name='one' checked></form>\
               <form id='second'><input id='b' type='radio' name='two' checked></form>\
               <input id='external' type='radio' name='one' form='first'>\
               <input id='moving' type='radio' name='move' checked>\
               <input id='resident' type='radio' name='move' checked>\
             </div>",
        );
        let host = element(&document, "host");
        let a = element(&document, "a");
        let b = element(&document, "b");
        let external = element(&document, "external");
        let moving = element(&document, "moving");
        let resident = element(&document, "resident");
        document.mutate().remove_node(moving);
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        assert!(controls.checked(&mut document, moving).unwrap());
        assert!(controls.checked(&mut document, resident).unwrap());
        document.mutate().append_children(host, &[moving]);
        controls.reconcile_document(&mut document);
        assert!(controls.checked(&mut document, moving).unwrap());
        assert!(!controls.checked(&mut document, resident).unwrap());

        document.mutate().set_attribute(b, name_attribute(), "one");
        controls.reconcile_document(&mut document);
        // Different form owners prevent the renamed checked radio from affecting `a`.
        assert!(controls.checked(&mut document, a).unwrap());
        assert!(controls.checked(&mut document, b).unwrap());

        controls.set_checked(&mut document, external, true);
        assert!(controls.checked(&mut document, external).unwrap());
        assert!(!controls.checked(&mut document, a).unwrap());
        assert!(controls.checked(&mut document, b).unwrap());

        document
            .mutate()
            .set_attribute(external, form_attribute(), "second");
        controls.reconcile_document(&mut document);
        assert!(controls.checked(&mut document, external).unwrap());
        assert!(!controls.checked(&mut document, b).unwrap());

        set_input_type(&mut document, a, "text");
        controls.set_checked(&mut document, a, true);
        set_input_type(&mut document, a, "radio");
        controls.reconcile_document(&mut document);
        assert!(controls.checked(&mut document, a).unwrap());
    }

    #[test]
    fn detached_inputs_retain_state_and_group_only_with_their_current_tree() {
        let mut document = document(
            "<div id='detached'>\
               <input id='left' type='radio' name='choice'>\
               <input id='right' type='radio' name='choice'>\
             </div>\
             <input id='separate-a' type='radio' name='choice'>\
             <input id='separate-b' type='radio' name='choice'>",
        );
        let container = element(&document, "detached");
        let left = element(&document, "left");
        let right = element(&document, "right");
        let separate_a = element(&document, "separate-a");
        let separate_b = element(&document, "separate-b");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        document.mutate().remove_node(container);
        document.mutate().remove_node(separate_a);
        document.mutate().remove_node(separate_b);
        controls.reconcile_document(&mut document);
        controls.set_checked(&mut document, left, true);
        controls.set_checked(&mut document, right, true);
        assert!(!controls.checked(&mut document, left).unwrap());
        assert!(controls.checked(&mut document, right).unwrap());

        controls.set_checked(&mut document, separate_a, true);
        controls.set_checked(&mut document, separate_b, true);
        assert!(controls.checked(&mut document, separate_a).unwrap());
        assert!(controls.checked(&mut document, separate_b).unwrap());

        controls.invalidate_nodes([left]);
        assert!(controls.state(left).is_none());
        assert!(controls.state(right).is_some());
    }

    #[test]
    fn native_activation_imports_target_state_and_repairs_blitz_radio_damage() {
        let mut document = document(
            "<input id='check' type='checkbox'>\
             <form id='first'>\
               <input id='radio-a' type='radio' name='group' checked>\
               <input id='radio-b' type='radio' name='group'>\
             </form>\
             <form id='second'><input id='other-radio' type='radio' name='group' checked></form>\
             <input id='same-name-box' type='checkbox' name='group' checked>",
        );
        let check = element(&document, "check");
        let radio_a = element(&document, "radio-a");
        let radio_b = element(&document, "radio-b");
        let other_radio = element(&document, "other-radio");
        let same_name_box = element(&document, "same-name-box");
        let mut controls = CheckedControlStates::default();
        controls.reconcile_document(&mut document);

        set_rendered_checked(&mut document, check, true);
        controls.import_user_activation(&mut document, check);
        assert!(controls.checked(&mut document, check).unwrap());
        assert!(controls.state(check).unwrap().dirty_checkedness);

        // Model pinned Blitz's name-only radio sweep, including unrelated controls.
        set_rendered_checked(&mut document, radio_a, false);
        set_rendered_checked(&mut document, radio_b, true);
        set_rendered_checked(&mut document, other_radio, false);
        set_rendered_checked(&mut document, same_name_box, false);
        controls.import_user_activation(&mut document, radio_b);

        assert!(!controls.checked(&mut document, radio_a).unwrap());
        assert!(controls.checked(&mut document, radio_b).unwrap());
        assert!(controls.state(radio_b).unwrap().dirty_checkedness);
        assert!(!controls.state(radio_a).unwrap().dirty_checkedness);
        assert!(controls.checked(&mut document, other_radio).unwrap());
        assert!(controls.checked(&mut document, same_name_box).unwrap());
        assert_eq!(rendered_checked(&document, other_radio), Some(true));
        assert_eq!(rendered_checked(&document, same_name_box), Some(true));
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
    fn range_color_and_filename_modes_remain_explicitly_unsupported() {
        let mut document = document(
            "<input id='range' type='range' value='sentinel'>\
             <input id='color' type='color' value='sentinel'>\
             <input id='file' type='file' value='sentinel'>",
        );
        let inputs = ["range", "color", "file"].map(|id| element(&document, id));
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
    fn date_and_time_value_modes_apply_html_sanitizers() {
        let mut document = document("<input id='field'>");
        let field = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        let cases = [
            ("date", "2024-02-29", "2024-02-29"),
            ("date", "2023-02-29", ""),
            ("date", "2000-02-29", "2000-02-29"),
            ("date", "1900-02-29", ""),
            ("date", "2023-04-31", ""),
            ("date", "12345-12-31", "12345-12-31"),
            ("date", "0000-01-01", ""),
            ("month", "2024-12", "2024-12"),
            ("month", "2024-13", ""),
            ("week", "2020-W53", "2020-W53"),
            ("week", "2021-W53", ""),
            ("week", "2015-W53", "2015-W53"),
            ("week", "2014-W53", ""),
            ("week", "2020-W00", ""),
            ("week", "2020-W54", ""),
            ("week", "2020-w01", ""),
            ("time", "23:59", "23:59"),
            ("time", "12:34:00.000", "12:34:00.000"),
            ("time", "24:00", ""),
            ("time", "23:59:60", ""),
            ("time", "12:34:56.1234", ""),
            ("time", " 12:34", ""),
            (
                "datetime-local",
                "2024-02-29 12:34:00.000",
                "2024-02-29T12:34",
            ),
            (
                "datetime-local",
                "2024-02-29T12:34:56.120",
                "2024-02-29T12:34:56.12",
            ),
            ("datetime-local", "2023-02-29T12:34", ""),
            ("datetime-local", "2024-02-29T12:34Z", ""),
        ];

        for (input_type, value, expected) in cases {
            set_input_type(&mut document, field, input_type);
            controls.reconcile_document(&mut document);
            controls.set_value(&mut document, field, value);
            assert_eq!(
                controls.value(&mut document, field).as_deref(),
                Some(expected),
                "type={input_type} value={value}",
            );
            assert!(super::editor_value(&document, field).is_none());
        }
    }

    #[test]
    fn date_time_defaults_follow_only_while_the_live_value_is_clean() {
        let mut document = document("<input id='field' type='date' value='not-a-date'>");
        let field = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        assert_eq!(controls.value(&mut document, field).as_deref(), Some(""));
        assert_eq!(
            super::input_value_attribute(&document, field).as_deref(),
            Some("not-a-date"),
            "the raw default remains observable",
        );
        document
            .mutate()
            .set_attribute(field, value_attribute(), "2024-02-29");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, field).as_deref(),
            Some("2024-02-29")
        );

        assert_eq!(
            controls.set_value(&mut document, field, "2024-02-29"),
            Some(false),
            "an identical assignment still makes the value dirty",
        );
        assert!(controls.state(field).unwrap().dirty_value);
        document
            .mutate()
            .set_attribute(field, value_attribute(), "2025-03-01");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, field).as_deref(),
            Some("2024-02-29")
        );
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
    fn date_value_mode_preserves_dirty_state_across_type_and_default_changes() {
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
        assert!(controls.state(dirty).unwrap().active);
        assert!(super::editor_value(&document, dirty).is_none());
        assert_eq!(
            controls.value(&mut document, dirty).as_deref(),
            Some("2024-01-01")
        );

        document
            .mutate()
            .set_attribute(dirty, value_attribute(), "2026-03-03");
        document
            .mutate()
            .set_attribute(clean, value_attribute(), "2025-02-02");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, dirty).as_deref(),
            Some("2024-01-01")
        );
        assert_eq!(
            controls.value(&mut document, clean).as_deref(),
            Some("2025-02-02")
        );

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
    fn date_type_transition_captures_the_latest_editor_value_before_sanitizing() {
        let mut document = document("<input id='field' type='text' value='old'>");
        let field = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(field, |mut driver| {
            driver.editor.set_text("2024-02-29");
            driver.refresh_layout();
        });

        set_input_type(&mut document, field, "date");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, field).as_deref(),
            Some("2024-02-29")
        );
        assert!(controls.state(field).unwrap().dirty_value);
        assert!(super::editor_value(&document, field).is_none());
    }

    #[test]
    fn date_time_type_transitions_follow_value_mode_bookkeeping() {
        let mut document = document(
            "<input id='dirty' type='date' value='2024-02-29'>\
             <input id='from-default' type='checkbox' value='2025-03-01'>\
             <input id='valid-exit' type='date' value='2024-01-01'>\
             <input id='empty-exit' type='date' value='not-a-date'>",
        );
        let dirty = element(&document, "dirty");
        let from_default = element(&document, "from-default");
        let valid_exit = element(&document, "valid-exit");
        let empty_exit = element(&document, "empty-exit");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        controls.set_value(&mut document, dirty, "2024-02-29");
        set_input_type(&mut document, dirty, "time");
        controls.reconcile_document(&mut document);
        assert_eq!(controls.value(&mut document, dirty).as_deref(), Some(""));
        assert!(controls.state(dirty).unwrap().dirty_value);

        set_input_type(&mut document, from_default, "date");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, from_default).as_deref(),
            Some("2025-03-01")
        );
        assert!(!controls.state(from_default).unwrap().dirty_value);

        controls.set_value(&mut document, valid_exit, "2026-04-02");
        set_input_type(&mut document, valid_exit, "checkbox");
        controls.reconcile_document(&mut document);
        assert_eq!(
            super::input_value_attribute(&document, valid_exit).as_deref(),
            Some("2026-04-02")
        );

        set_input_type(&mut document, empty_exit, "checkbox");
        controls.reconcile_document(&mut document);
        assert_eq!(
            super::input_value_attribute(&document, empty_exit).as_deref(),
            Some("not-a-date"),
            "an empty sanitized live value must not overwrite the raw default",
        );
    }

    #[test]
    fn detached_date_values_survive_but_destroyed_state_does_not() {
        let mut document = document("<input id='field' type='date' value='2024-01-01'>");
        let body = document
            .tree()
            .iter()
            .find_map(|(node_id, node)| {
                node.element_data()
                    .is_some_and(|element| element.name.local.as_ref() == "body")
                    .then_some(node_id)
            })
            .expect("test document should have a body");
        let field = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_value(&mut document, field, "2025-02-02");

        document.mutate().remove_node(field);
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, field).as_deref(),
            Some("2025-02-02")
        );
        document.mutate().append_children(body, &[field]);
        assert_eq!(
            controls.value(&mut document, field).as_deref(),
            Some("2025-02-02")
        );

        controls.invalidate_nodes([field]);
        document.mutate().remove_and_drop_all_children(body);
        document.mutate().set_inner_html(
            body,
            "<input id='replacement' type='date' value='2026-03-03'>",
        );
        let replacement = element(&document, "replacement");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.value(&mut document, replacement).as_deref(),
            Some("2026-03-03")
        );
        assert!(!controls.state(replacement).unwrap().dirty_value);
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
    fn non_editor_value_modes_discard_an_obsolete_blitz_editor() {
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
        assert!(super::editor_value(&document, date).is_none());
    }

    #[test]
    fn range_selection_uses_html_applicability_utf16_offsets_and_direction() {
        let mut document = document(
            "<input id='text' value='A🙂B'><input id='search' type='search'>\
             <input id='tel' type='tel'><input id='url' type='url'>\
             <input id='password' type='password'><input id='email' type='email'>\
             <input id='number' type='number'><input id='date' type='date'>\
             <textarea id='area'>A🙂B</textarea>",
        );
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);

        for id in ["text", "search", "tel", "url", "password", "area"] {
            let node_id = element(&document, id);
            assert_eq!(
                controls.selection(&mut document, node_id),
                Some(TextControlSelection {
                    start: 0,
                    end: 0,
                    direction: TextControlSelectionDirection::None,
                }),
                "{id} should expose a range"
            );
        }
        for id in ["email", "number", "date"] {
            let node_id = element(&document, id);
            assert_eq!(controls.selection(&mut document, node_id), None);
            assert_eq!(
                controls.set_selection_range(
                    &mut document,
                    node_id,
                    0,
                    0,
                    TextControlSelectionDirection::None,
                ),
                None
            );
        }

        let text = element(&document, "text");
        assert_eq!(
            controls.set_selection_range(
                &mut document,
                text,
                1,
                3,
                TextControlSelectionDirection::None,
            ),
            Some(true)
        );
        assert_eq!(raw_editor_selection(&document, text), (1, 5));
        assert_eq!(
            controls.selection(&mut document, text),
            Some(TextControlSelection {
                start: 1,
                end: 3,
                direction: TextControlSelectionDirection::None,
            })
        );
        assert_eq!(
            controls.set_selection_range(
                &mut document,
                text,
                1,
                3,
                TextControlSelectionDirection::Backward,
            ),
            Some(true)
        );
        assert_eq!(raw_editor_selection(&document, text), (5, 1));
        assert_eq!(
            controls.selection(&mut document, text),
            Some(TextControlSelection {
                start: 1,
                end: 3,
                direction: TextControlSelectionDirection::Backward,
            })
        );

        // Parley cannot place a cursor inside a UTF-8 scalar (and may further snap to a shaped
        // cluster), so the middle UTF-16 unit of the emoji resolves to its preceding boundary.
        controls.set_selection_range(
            &mut document,
            text,
            2,
            3,
            TextControlSelectionDirection::Forward,
        );
        assert_eq!(controls.selection(&mut document, text).unwrap().start, 1);

        controls.set_selection_range(
            &mut document,
            text,
            usize::MAX,
            2,
            TextControlSelectionDirection::Forward,
        );
        assert_eq!(
            controls.selection(&mut document, text),
            Some(TextControlSelection {
                start: 1,
                end: 1,
                direction: TextControlSelectionDirection::Forward,
            })
        );
    }

    #[test]
    fn selection_projects_sanitized_composition_without_ending_it() {
        let mut document = document("<input id='url' type='url' value='abc'>");
        let url = element(&document, "url");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(url, |mut driver| {
            driver.move_to_text_start();
            driver.set_compose("  ", Some((2, 2)));
        });
        controls.sync_editor_value(&mut document, url);

        assert_eq!(controls.value(&mut document, url).as_deref(), Some("abc"));
        assert_eq!(
            super::editor_value(&document, url).as_deref(),
            Some("  abc")
        );
        assert_eq!(controls.selection(&mut document, url).unwrap().start, 0);

        assert_eq!(
            controls.set_selection_range(
                &mut document,
                url,
                0,
                3,
                TextControlSelectionDirection::Backward,
            ),
            Some(true)
        );
        let editor = document
            .get_node(url)
            .and_then(blitz_dom::Node::element_data)
            .and_then(blitz_dom::ElementData::text_input_data)
            .unwrap();
        assert_eq!(editor.editor.raw_text(), "  abc");
        assert_eq!(editor.editor.raw_compose().as_ref(), Some(&(0..2)));
        assert_eq!(raw_editor_selection(&document, url), (5, 2));
        assert_eq!(
            controls.selection(&mut document, url),
            Some(TextControlSelection {
                start: 0,
                end: 3,
                direction: TextControlSelectionDirection::Backward,
            })
        );

        document.with_text_input(url, |mut driver| driver.finish_compose());
        controls.sync_editor_value(&mut document, url);
        assert_eq!(super::editor_value(&document, url).as_deref(), Some("abc"));
        assert_eq!(raw_editor_selection(&document, url), (3, 0));
        assert_eq!(
            controls.selection(&mut document, url),
            Some(TextControlSelection {
                start: 0,
                end: 3,
                direction: TextControlSelectionDirection::Backward,
            })
        );

        document.with_text_input(url, |mut driver| {
            driver.move_to_text_start();
            driver.set_compose("  ", Some((2, 2)));
        });
        controls.sync_editor_value(&mut document, url);
        assert_eq!(controls.selection(&mut document, url).unwrap().start, 0);
        assert_eq!(
            controls.set_value(&mut document, url, "abc"),
            Some(true),
            "the editor still contains unsanitized preedit text"
        );
        assert_eq!(super::editor_value(&document, url).as_deref(), Some("abc"));
        assert_eq!(raw_editor_selection(&document, url), (0, 0));
        assert_eq!(controls.selection(&mut document, url).unwrap().start, 0);
    }

    #[test]
    fn sanitized_selection_reports_raw_caret_movement_for_repaint() {
        let mut document = document("<input id='url' type='url' value='abc'>");
        let url = element(&document, "url");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(url, |mut driver| {
            driver.move_to_text_start();
            driver.set_compose("  ", Some((0, 0)));
        });
        controls.sync_editor_value(&mut document, url);

        assert_eq!(raw_editor_selection(&document, url), (0, 0));
        assert_eq!(
            controls.selection(&mut document, url),
            Some(TextControlSelection {
                start: 0,
                end: 0,
                direction: TextControlSelectionDirection::None,
            })
        );
        assert_eq!(
            controls.set_selection_range(
                &mut document,
                url,
                0,
                0,
                TextControlSelectionDirection::None,
            ),
            Some(true),
            "the exposed range is unchanged, but the rendered raw caret moved"
        );
        assert_eq!(raw_editor_selection(&document, url), (2, 2));
        assert_eq!(
            controls.selection(&mut document, url),
            Some(TextControlSelection {
                start: 0,
                end: 0,
                direction: TextControlSelectionDirection::None,
            })
        );
        assert_eq!(
            controls.set_selection_range(
                &mut document,
                url,
                0,
                0,
                TextControlSelectionDirection::None,
            ),
            Some(false)
        );
    }

    #[test]
    fn value_type_and_detach_transitions_keep_selection_state_coherent() {
        let mut document = document("<input id='field' value='abcdef'>");
        let field = element(&document, "field");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        controls.set_selection_range(
            &mut document,
            field,
            1,
            4,
            TextControlSelectionDirection::Backward,
        );

        assert_eq!(
            controls.set_value(&mut document, field, "abcdef"),
            Some(false)
        );
        assert_eq!(
            controls.selection(&mut document, field).unwrap().direction,
            TextControlSelectionDirection::Backward
        );

        controls.set_value(&mut document, field, "x");
        assert_eq!(
            controls.selection(&mut document, field),
            Some(TextControlSelection {
                start: 1,
                end: 1,
                direction: TextControlSelectionDirection::None,
            })
        );

        controls.set_selection_range(
            &mut document,
            field,
            0,
            1,
            TextControlSelectionDirection::Backward,
        );
        document.mutate().remove_node(field);
        assert_eq!(
            controls.selection(&mut document, field),
            Some(TextControlSelection {
                start: 0,
                end: 1,
                direction: TextControlSelectionDirection::Backward,
            })
        );

        set_input_type(&mut document, field, "email");
        controls.reconcile_document(&mut document);
        assert_eq!(controls.selection(&mut document, field), None);
        set_input_type(&mut document, field, "text");
        controls.reconcile_document(&mut document);
        assert_eq!(
            controls.selection(&mut document, field),
            Some(TextControlSelection {
                start: 0,
                end: 0,
                direction: TextControlSelectionDirection::None,
            })
        );
    }

    #[test]
    fn select_all_includes_editor_backed_email_and_bad_number_text() {
        let mut document = document(
            "<input id='email' type='email' value='a@b.test'>\
             <input id='number' type='number'><input id='date' type='date'>",
        );
        let email = element(&document, "email");
        let number = element(&document, "number");
        let date = element(&document, "date");
        let mut controls = TextControlStates::default();
        controls.reconcile_document(&mut document);
        document.with_text_input(number, |mut driver| {
            driver.insert_or_replace_selection("-");
        });
        controls.sync_editor_value(&mut document, number);

        assert!(controls.select_all(&mut document, email));
        assert_eq!(raw_editor_selection(&document, email), (0, 8));
        assert!(controls.select_all(&mut document, number));
        assert_eq!(raw_editor_selection(&document, number), (0, 1));
        assert!(!controls.select_all(&mut document, date));
        assert!(!controls.select_all(&mut document, email));
    }
}
