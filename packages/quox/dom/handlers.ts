import type { QuoxElement, QuoxNode } from "./node.ts";

export type QuoxFunctionProp = (...args: unknown[]) => unknown;
export type QuoxFunctionPropMap = Map<string, QuoxFunctionProp>;

const functionProps = new WeakMap<QuoxNode, QuoxFunctionPropMap>();

export function setElementFunctionProp(element: QuoxElement, name: string, handler: QuoxFunctionProp): void {
  let handlers = functionProps.get(element);
  if (handlers === undefined) {
    handlers = new Map();
    functionProps.set(element, handlers);
  }

  handlers.set(name, handler);
}

/**
 * Return function-valued props stored during JSX mounting for a node. Accepts any `QuoxNode`
 * (not just elements) since a dispatched DOM event's target isn't always known to be an
 * element ahead of time.
 */
export function getElementFunctionProps(node: QuoxNode): ReadonlyMap<string, QuoxFunctionProp> | undefined {
  return functionProps.get(node);
}
