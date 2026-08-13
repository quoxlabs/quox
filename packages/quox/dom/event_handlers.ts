import type { QuoxDocument } from "./document.ts";
import { QuoxElement, type QuoxEvent, type QuoxEventHandler, type QuoxEventType } from "./node.ts";

type EventHandlerEntry = {
  readonly element: QuoxElement;
  readonly handler: QuoxEventHandler;
};

const eventHandlers = new WeakMap<QuoxDocument, Map<number, Map<QuoxEventType, EventHandlerEntry>>>();

export function getEventHandler(element: QuoxElement, type: QuoxEventType): QuoxEventHandler | null {
  return eventHandlers.get(element.ownerDocument)?.get(element.nodeId)?.get(type)?.handler ?? null;
}

export function setEventHandler(element: QuoxElement, type: QuoxEventType, handler: QuoxEventHandler | null): void {
  const documentHandlers = eventHandlers.get(element.ownerDocument);
  const elementHandlers = documentHandlers?.get(element.nodeId);

  if (typeof handler !== "function") {
    elementHandlers?.delete(type);
    if (elementHandlers?.size === 0) documentHandlers?.delete(element.nodeId);
    if (documentHandlers?.size === 0) eventHandlers.delete(element.ownerDocument);
    return;
  }

  const entry = { element, handler };
  if (elementHandlers !== undefined) {
    elementHandlers.set(type, entry);
    return;
  }

  const handlers = new Map([[type, entry]]);
  if (documentHandlers !== undefined) {
    documentHandlers.set(element.nodeId, handlers);
  } else {
    eventHandlers.set(element.ownerDocument, new Map([[element.nodeId, handlers]]));
  }
}

export function invokeEventHandlers(document: QuoxDocument, path: Iterable<number>, type: QuoxEventType): void {
  const frozenPath = Object.freeze([...path]);
  const targetId = frozenPath[0];
  if (targetId === undefined) return;

  const documentHandlers = eventHandlers.get(document);
  const target = documentHandlers?.get(targetId)?.values().next().value?.element ??
    new QuoxElement(document, targetId);
  const event = new BubblingQuoxEvent(type, target, !["focus", "blur", "scroll"].includes(type));

  for (const nodeId of frozenPath) {
    const entry = documentHandlers?.get(nodeId)?.get(type);
    if (entry !== undefined) {
      event.setCurrentTarget(entry.element);
      entry.handler.call(entry.element, event);
      event.setCurrentTarget(null);
    }
    if (event.propagationStopped) break;
  }

  event.setCurrentTarget(null);
}

class BubblingQuoxEvent implements QuoxEvent {
  #currentTarget: QuoxElement | null = null;
  #propagationStopped = false;

  constructor(
    readonly type: QuoxEventType,
    readonly target: QuoxElement,
    readonly bubbles: boolean,
  ) {}

  get currentTarget(): QuoxElement | null {
    return this.#currentTarget;
  }

  get propagationStopped(): boolean {
    return this.#propagationStopped;
  }

  stopPropagation(): void {
    this.#propagationStopped = true;
  }

  setCurrentTarget(element: QuoxElement | null): void {
    this.#currentTarget = element;
  }
}
