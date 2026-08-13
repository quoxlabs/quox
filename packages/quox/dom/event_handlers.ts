import type { QuoxDocument } from "./document.ts";
import type { QuoxElement, QuoxEvent, QuoxEventHandler, QuoxEventType } from "./node.ts";

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

export function invokeEventHandler(document: QuoxDocument, nodeId: number, type: QuoxEventType): void {
  const entry = eventHandlers.get(document)?.get(nodeId)?.get(type);
  if (entry === undefined) return;

  const event: QuoxEvent = { type, target: entry.element, currentTarget: entry.element };
  entry.handler.call(entry.element, event);
}
