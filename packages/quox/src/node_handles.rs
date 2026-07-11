use std::collections::HashMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

/// Assigns non-reused public handles to Blitz's reusable slab indices.
///
/// Handle zero is deliberately left invalid. Once the `u32` space is exhausted, allocation
/// fails instead of wrapping and making an old JavaScript wrapper refer to a different node.
pub(super) struct NodeHandles {
    next_handle: Option<u32>,
    handle_to_node: HashMap<u32, usize>,
    node_to_handle: HashMap<usize, u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NodeHandleExhausted;

impl Display for NodeHandleExhausted {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Quox DOM node handle space exhausted")
    }
}

impl Error for NodeHandleExhausted {}

impl Default for NodeHandles {
    fn default() -> Self {
        Self {
            next_handle: Some(1),
            handle_to_node: HashMap::new(),
            node_to_handle: HashMap::new(),
        }
    }
}

impl NodeHandles {
    /// Return the existing handle for a node, or assign the next never-before-used handle.
    pub(super) fn expose(&mut self, node_id: usize) -> Result<u32, NodeHandleExhausted> {
        if let Some(handle) = self.node_to_handle.get(&node_id) {
            return Ok(*handle);
        }

        let handle = self.next_handle.ok_or(NodeHandleExhausted)?;
        self.next_handle = handle.checked_add(1);
        self.handle_to_node.insert(handle, node_id);
        self.node_to_handle.insert(node_id, handle);
        Ok(handle)
    }

    pub(super) fn resolve(&self, handle: u32) -> Option<usize> {
        self.handle_to_node.get(&handle).copied()
    }

    /// Forget a node that Blitz is about to drop. Its handle is intentionally never recycled.
    pub(super) fn invalidate_node(&mut self, node_id: usize) -> Option<u32> {
        if let Some(handle) = self.node_to_handle.remove(&node_id) {
            self.handle_to_node.remove(&handle);
            Some(handle)
        } else {
            None
        }
    }

    pub(super) fn invalidate_nodes(
        &mut self,
        node_ids: impl IntoIterator<Item = usize>,
    ) -> Vec<u32> {
        node_ids
            .into_iter()
            .filter_map(|node_id| self.invalidate_node(node_id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::NodeHandles;

    #[test]
    fn never_reuses_a_handle_when_a_raw_node_id_is_reused() {
        let mut handles = NodeHandles::default();
        let old_handle = handles.expose(7).expect("first handle should fit");

        assert_eq!(handles.invalidate_node(7), Some(old_handle));
        let replacement_handle = handles.expose(7).expect("replacement handle should fit");

        assert_ne!(replacement_handle, old_handle);
        assert_eq!(handles.resolve(old_handle), None);
        assert_eq!(handles.resolve(replacement_handle), Some(7));
    }

    #[test]
    fn preserves_a_handle_while_a_raw_node_remains_live() {
        let mut handles = NodeHandles::default();
        let first = handles.expose(9).expect("first handle should fit");
        let second = handles
            .expose(9)
            .expect("existing handle should remain available");

        assert_eq!(first, second);
        assert_eq!(handles.resolve(first), Some(9));
    }
}
