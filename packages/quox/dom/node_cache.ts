import type { QuoxDocument } from "./document.ts";
import { assertUint32 } from "./ffi_numbers.ts";
import { QuoxElement, QuoxNode, QuoxText } from "./node.ts";

// Match the browser `Node.nodeType` constants returned by the Rust boundary.
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/**
 * Owns the one JavaScript wrapper for each live public node handle in a document.
 *
 * Quox handles never change which Blitz node they identify, so a conflicting kind indicates a
 * broken boundary contract rather than a wrapper that can safely be upgraded in place.
 */
export class QuoxNodeCache {
  readonly #document: QuoxDocument;
  readonly #nodes = new Map<number, QuoxNode>();

  constructor(document: QuoxDocument) {
    this.#document = document;
  }

  get(nodeHandle: number, nodeKind: typeof ELEMENT_NODE): QuoxElement;
  get(nodeHandle: number, nodeKind: typeof TEXT_NODE): QuoxText;
  get(nodeHandle: number, nodeKind: number): QuoxNode;
  get(nodeHandle: number, nodeKind: number): QuoxNode {
    nodeHandle = assertUint32(nodeHandle, "nodeHandle");
    const cached = this.#nodes.get(nodeHandle);
    if (cached !== undefined) {
      assertWrapperKind(cached, nodeKind);
      return cached;
    }

    const node = nodeKind === ELEMENT_NODE
      ? new QuoxElement(this.#document, nodeHandle)
      : nodeKind === TEXT_NODE
      ? new QuoxText(this.#document, nodeHandle)
      : new QuoxNode(this.#document, nodeHandle);
    this.#nodes.set(nodeHandle, node);
    return node;
  }

  /** Stop retaining wrappers whose Rust nodes were destroyed by a child replacement. */
  invalidate(nodeHandles: Iterable<number>): void {
    for (const nodeHandle of nodeHandles) this.#nodes.delete(nodeHandle);
  }
}

function assertWrapperKind(node: QuoxNode, nodeKind: number): void {
  if (
    (nodeKind === ELEMENT_NODE && !(node instanceof QuoxElement)) ||
    (nodeKind === TEXT_NODE && !(node instanceof QuoxText))
  ) {
    throw new TypeError(`Quox node handle ${node.nodeId} changed node kind`);
  }
}
