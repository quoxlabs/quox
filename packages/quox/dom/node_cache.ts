import type { QuoxDocument } from "./document.ts";
import { assertUint32 } from "./ffi_numbers.ts";
import { QuoxElement, QuoxInputElement, QuoxNode, QuoxText, QuoxTextAreaElement } from "./node.ts";

// Match the browser `Node.nodeType` constants returned by the Rust boundary.
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const GENERIC_ELEMENT_INTERFACE = 0;
export const INPUT_ELEMENT_INTERFACE = 1;
export const TEXTAREA_ELEMENT_INTERFACE = 2;

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

  get(
    nodeHandle: number,
    nodeKind: typeof ELEMENT_NODE,
    elementInterface: typeof INPUT_ELEMENT_INTERFACE,
  ): QuoxInputElement;
  get(
    nodeHandle: number,
    nodeKind: typeof ELEMENT_NODE,
    elementInterface: typeof TEXTAREA_ELEMENT_INTERFACE,
  ): QuoxTextAreaElement;
  get(
    nodeHandle: number,
    nodeKind: typeof ELEMENT_NODE,
    elementInterface?: typeof GENERIC_ELEMENT_INTERFACE,
  ): QuoxElement;
  get(nodeHandle: number, nodeKind: typeof ELEMENT_NODE, elementInterface: number): QuoxElement;
  get(nodeHandle: number, nodeKind: typeof TEXT_NODE): QuoxText;
  get(nodeHandle: number, nodeKind: number, elementInterface?: number): QuoxNode;
  get(nodeHandle: number, nodeKind: number, elementInterface = GENERIC_ELEMENT_INTERFACE): QuoxNode {
    nodeHandle = assertUint32(nodeHandle, "nodeHandle");
    const cached = this.#nodes.get(nodeHandle);
    if (cached !== undefined) {
      assertWrapperKind(cached, nodeKind, elementInterface);
      return cached;
    }

    const node = nodeKind === ELEMENT_NODE
      ? createElementWrapper(this.#document, nodeHandle, elementInterface)
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

  /** Whether a retained wrapper still has a live Rust node behind its stable handle. */
  isCurrent(node: QuoxNode): boolean {
    return this.#nodes.get(node.nodeId) === node;
  }
}

function createElementWrapper(
  document: QuoxDocument,
  nodeHandle: number,
  elementInterface: number,
): QuoxElement {
  switch (elementInterface) {
    case GENERIC_ELEMENT_INTERFACE:
      return new QuoxElement(document, nodeHandle);
    case INPUT_ELEMENT_INTERFACE:
      return new QuoxInputElement(document, nodeHandle);
    case TEXTAREA_ELEMENT_INTERFACE:
      return new QuoxTextAreaElement(document, nodeHandle);
    default:
      throw new TypeError(`Quox element handle ${nodeHandle} has unknown interface ${elementInterface}`);
  }
}

function assertWrapperKind(node: QuoxNode, nodeKind: number, elementInterface: number): void {
  if (
    (nodeKind === ELEMENT_NODE && !(node instanceof QuoxElement)) ||
    (nodeKind === TEXT_NODE && !(node instanceof QuoxText))
  ) {
    throw new TypeError(`Quox node handle ${node.nodeId} changed node kind`);
  }
  if (nodeKind === ELEMENT_NODE) {
    const matchesInterface = (elementInterface === GENERIC_ELEMENT_INTERFACE && node.constructor === QuoxElement) ||
      (elementInterface === INPUT_ELEMENT_INTERFACE && node.constructor === QuoxInputElement) ||
      (elementInterface === TEXTAREA_ELEMENT_INTERFACE &&
        node.constructor === QuoxTextAreaElement);
    if (!matchesInterface) {
      throw new TypeError(`Quox element handle ${node.nodeId} changed element interface`);
    }
  }
}
