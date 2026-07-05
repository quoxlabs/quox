import type { QuoxDocument } from "./document.ts";
import type { QuoxElement, QuoxNode } from "./node.ts";

export type QuoxFunctionProp = (...args: unknown[]) => unknown;
export type QuoxFunctionPropMap = Map<string, QuoxFunctionProp>;

const functionProps = new WeakMap<QuoxDocument, Map<number, QuoxFunctionPropMap>>();

function documentFunctionProps(document: QuoxDocument): Map<number, QuoxFunctionPropMap> {
  let registry = functionProps.get(document);
  if (registry === undefined) {
    registry = new Map();
    functionProps.set(document, registry);
  }

  return registry;
}

export function setElementFunctionProp(element: QuoxElement, name: string, handler: QuoxFunctionProp): void {
  const registry = documentFunctionProps(element.ownerDocument);
  let handlers = registry.get(element.nodeId);
  if (handlers === undefined) {
    handlers = new Map();
    registry.set(element.nodeId, handlers);
  }

  handlers.set(name, handler);
}

/**
 * Return function-valued props stored during JSX mounting for a node. Accepts any `QuoxNode`
 * (not just elements) since a dispatched DOM event's target isn't always known to be an
 * element ahead of time.
 */
export function getElementFunctionProps(node: QuoxNode): ReadonlyMap<string, QuoxFunctionProp> | undefined {
  return functionProps.get(node.ownerDocument)?.get(node.nodeId);
}

/** Return all function-valued JSX props for a document, keyed by Quox node id. */
export function getDocumentFunctionProps(
  document: QuoxDocument,
): ReadonlyMap<number, QuoxFunctionPropMap> | undefined {
  return functionProps.get(document);
}
