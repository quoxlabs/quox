import type { QuoxDocument } from "./document.ts";
import type { QuoxElement } from "./node.ts";

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

/** Return function-valued props stored during JSX mounting. Quox does not dispatch these yet. */
export function getElementFunctionProps(element: QuoxElement): ReadonlyMap<string, QuoxFunctionProp> | undefined {
  return functionProps.get(element.ownerDocument)?.get(element.nodeId);
}

/** Return all function-valued JSX props for a document, keyed by Quox node id. */
export function getDocumentFunctionProps(
  document: QuoxDocument,
): ReadonlyMap<number, QuoxFunctionPropMap> | undefined {
  return functionProps.get(document);
}
