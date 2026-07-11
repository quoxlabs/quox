import type { QuoxElement, QuoxNode } from "./node.ts";
import type { QuoxEventListener } from "./event_target.ts";

export type QuoxFunctionProp = (...args: unknown[]) => unknown;
export type QuoxFunctionPropMap = Map<string, QuoxFunctionProp>;

const functionProps = new WeakMap<QuoxNode, QuoxFunctionPropMap>();
const eventSlots = new WeakMap<QuoxElement, Map<string, JsxEventSlot>>();

type JsxEventSlot = {
  callback: QuoxFunctionProp;
  readonly listener: QuoxEventListener;
};

const EVENT_PROP_TO_TYPE = Object.freeze(
  {
    onClick: "click",
    onDoubleClick: "dblclick",
    onContextMenu: "contextmenu",
    onInput: "input",
    onFocus: "focus",
    onBlur: "blur",
    onScroll: "scroll",
  } as const,
);

export function setElementFunctionProp(element: QuoxElement, name: string, handler: QuoxFunctionProp): void {
  let handlers = functionProps.get(element);
  if (handlers === undefined) {
    handlers = new Map();
    functionProps.set(element, handlers);
  }

  handlers.set(name, handler);

  const eventType = EVENT_PROP_TO_TYPE[name as keyof typeof EVENT_PROP_TO_TYPE];
  if (eventType !== undefined) {
    let slots = eventSlots.get(element);
    if (slots === undefined) {
      slots = new Map();
      eventSlots.set(element, slots);
    }

    const existing = slots.get(eventType);
    if (existing !== undefined) {
      existing.callback = handler;
      return;
    }

    const slot = {} as JsxEventSlot;
    const listener: QuoxEventListener = function (event) {
      // JSX runtimes install event listeners, not inline HTML attributes: callback return values
      // are ignored, including `false`. Cancellation must use `event.preventDefault()`.
      Reflect.apply(slot.callback, this, [event]);
    };
    Object.assign(slot, { callback: handler, listener });
    slots.set(eventType, slot);
    element.addEventListener(eventType, listener);
  }
}

/**
 * Return function-valued props stored during JSX mounting for a node. Accepts any `QuoxNode`
 * (not just elements) since a dispatched DOM event's target isn't always known to be an
 * element ahead of time.
 */
export function getElementFunctionProps(node: QuoxNode): ReadonlyMap<string, QuoxFunctionProp> | undefined {
  return functionProps.get(node);
}
