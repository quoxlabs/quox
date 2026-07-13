import type { QuoxElement, QuoxNode } from "./node.ts";
import type { QuoxEventListener } from "./event_target.ts";
import type { DomDispatchEventType } from "./renderer_port.ts";

export type QuoxFunctionProp = (...args: unknown[]) => unknown;
export type QuoxFunctionPropMap = Map<string, QuoxFunctionProp>;

const functionProps = new WeakMap<QuoxNode, QuoxFunctionPropMap>();
const eventSlots = new WeakMap<QuoxElement, Map<string, JsxEventSlot>>();

type JsxEventSlot = {
  callback: QuoxFunctionProp;
  readonly listener: QuoxEventListener;
};

type JsxEventBinding = {
  readonly type: DomDispatchEventType;
  readonly capture: boolean;
};

/**
 * Keep one canonical JSX spelling for every event the staged renderer can emit. The
 * `satisfies` clause makes adding another renderer event a compile-time update here rather than
 * another silently dead JSX prop.
 */
const EVENT_TYPE_TO_PROP = Object.freeze(
  {
    pointermove: "onPointerMove",
    pointerdown: "onPointerDown",
    pointerup: "onPointerUp",
    pointercancel: "onPointerCancel",
    pointerenter: "onPointerEnter",
    pointerleave: "onPointerLeave",
    pointerover: "onPointerOver",
    pointerout: "onPointerOut",
    mousemove: "onMouseMove",
    mousedown: "onMouseDown",
    mouseup: "onMouseUp",
    mouseenter: "onMouseEnter",
    mouseleave: "onMouseLeave",
    mouseover: "onMouseOver",
    mouseout: "onMouseOut",
    scroll: "onScroll",
    wheel: "onWheel",
    click: "onClick",
    auxclick: "onAuxClick",
    contextmenu: "onContextMenu",
    dblclick: "onDoubleClick",
    keypress: "onKeyPress",
    keydown: "onKeyDown",
    keyup: "onKeyUp",
    input: "onInput",
    focus: "onFocus",
    blur: "onBlur",
    focusin: "onFocusIn",
    focusout: "onFocusOut",
  } as const satisfies Record<DomDispatchEventType, string>,
);

const EVENT_PROP_TO_TYPE: ReadonlyMap<string, DomDispatchEventType> = new Map([
  ...Object.entries(EVENT_TYPE_TO_PROP).map(
    ([type, prop]) => [prop, type as DomDispatchEventType] as const,
  ),
  // Preact uses `onDblClick`; React and Quox's original API use `onDoubleClick`.
  ["onDblClick", "dblclick"],
]);
const CAPTURE_SUFFIX = "Capture";

export function setElementFunctionProp(element: QuoxElement, name: string, handler: QuoxFunctionProp): void {
  const eventBinding = jsxEventBinding(name);

  let handlers = functionProps.get(element);
  if (handlers === undefined) {
    handlers = new Map();
    functionProps.set(element, handlers);
  }

  handlers.set(name, handler);

  if (eventBinding !== undefined) {
    let slots = eventSlots.get(element);
    if (slots === undefined) {
      slots = new Map();
      eventSlots.set(element, slots);
    }

    const slotKey = `${eventBinding.type}:${eventBinding.capture ? "capture" : "bubble"}`;
    const existing = slots.get(slotKey);
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
    slots.set(slotKey, slot);
    element.addEventListener(eventBinding.type, listener, eventBinding.capture);
  }
}

function jsxEventBinding(name: string): JsxEventBinding | undefined {
  const capture = name.endsWith(CAPTURE_SUFFIX);
  const baseName = capture ? name.slice(0, -CAPTURE_SUFFIX.length) : name;
  const type = EVENT_PROP_TO_TYPE.get(baseName);
  if (type !== undefined) return { type, capture };

  if (name.startsWith("on") && name.length > 2) {
    throw new TypeError(`quox: JSX event prop "${name}" is not supported`);
  }
  return undefined;
}

/**
 * Return function-valued props stored during JSX mounting for a node. Accepts any `QuoxNode`
 * (not just elements) since a dispatched DOM event's target isn't always known to be an
 * element ahead of time.
 */
export function getElementFunctionProps(node: QuoxNode): ReadonlyMap<string, QuoxFunctionProp> | undefined {
  return functionProps.get(node);
}
