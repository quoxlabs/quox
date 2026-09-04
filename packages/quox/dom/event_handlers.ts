import type { QuoxDocument } from "./document.ts";
import {
  QuoxElement,
  type QuoxEvent,
  type QuoxEventHandler,
  type QuoxEventType,
  type QuoxFullscreenEvent,
  type QuoxFullscreenEventHandler,
  type QuoxFullscreenEventType,
} from "./node.ts";

type ElementEventType = QuoxEventType | QuoxFullscreenEventType;
type ElementListener = QuoxEventHandler | QuoxFullscreenEventHandler;

type ElementEventEntry = {
  handlerElement: QuoxElement;
  handler: ElementListener | null;
  readonly listeners: Map<ElementListener, QuoxElement>;
};

type DocumentFullscreenHandler = (this: QuoxDocument, event: QuoxFullscreenEvent) => unknown;
type DocumentEventEntry = {
  handler: DocumentFullscreenHandler | null;
  readonly listeners: Set<DocumentFullscreenHandler>;
};

const elementEvents = new WeakMap<QuoxDocument, Map<number, Map<ElementEventType, ElementEventEntry>>>();
const documentEvents = new WeakMap<QuoxDocument, Map<QuoxFullscreenEventType, DocumentEventEntry>>();

function elementEntry(element: QuoxElement, type: ElementEventType, create: boolean): ElementEventEntry | undefined {
  let byNode = elementEvents.get(element.ownerDocument);
  let byType = byNode?.get(element.nodeId);
  let entry = byType?.get(type);
  if (entry !== undefined || !create) return entry;

  entry = { handlerElement: element, handler: null, listeners: new Map() };
  if (byType === undefined) {
    byType = new Map();
    if (byNode === undefined) {
      byNode = new Map();
      elementEvents.set(element.ownerDocument, byNode);
    }
    byNode.set(element.nodeId, byType);
  }
  byType.set(type, entry);
  return entry;
}

function pruneElementEntry(element: QuoxElement, type: ElementEventType, entry: ElementEventEntry): void {
  if (entry.handler !== null || entry.listeners.size > 0) return;
  const byNode = elementEvents.get(element.ownerDocument);
  const byType = byNode?.get(element.nodeId);
  byType?.delete(type);
  if (byType?.size === 0) byNode?.delete(element.nodeId);
  if (byNode?.size === 0) elementEvents.delete(element.ownerDocument);
}

export function getEventHandler(element: QuoxElement, type: QuoxEventType): QuoxEventHandler | null;
export function getEventHandler(
  element: QuoxElement,
  type: QuoxFullscreenEventType,
): QuoxFullscreenEventHandler | null;
export function getEventHandler(element: QuoxElement, type: ElementEventType): ElementListener | null {
  return elementEntry(element, type, false)?.handler ?? null;
}

export function setEventHandler(element: QuoxElement, type: ElementEventType, handler: ElementListener | null): void {
  const entry = elementEntry(element, type, typeof handler === "function");
  if (entry === undefined) return;
  entry.handlerElement = element;
  entry.handler = typeof handler === "function" ? handler : null;
  pruneElementEntry(element, type, entry);
}

export function addElementEventListener(element: QuoxElement, type: ElementEventType, listener: ElementListener): void {
  if (typeof listener !== "function") return;
  elementEntry(element, type, true)!.listeners.set(listener, element);
}

export function removeElementEventListener(
  element: QuoxElement,
  type: ElementEventType,
  listener: ElementListener,
): void {
  const entry = elementEntry(element, type, false);
  if (entry === undefined) return;
  entry.listeners.delete(listener);
  pruneElementEntry(element, type, entry);
}

function documentEntry(
  document: QuoxDocument,
  type: QuoxFullscreenEventType,
  create: boolean,
): DocumentEventEntry | undefined {
  let entries = documentEvents.get(document);
  let entry = entries?.get(type);
  if (entry !== undefined || !create) return entry;
  entry = { handler: null, listeners: new Set() };
  if (entries === undefined) {
    entries = new Map();
    documentEvents.set(document, entries);
  }
  entries.set(type, entry);
  return entry;
}

export function getDocumentEventHandler(
  document: QuoxDocument,
  type: QuoxFullscreenEventType,
): DocumentFullscreenHandler | null {
  return documentEntry(document, type, false)?.handler ?? null;
}

export function setDocumentEventHandler(
  document: QuoxDocument,
  type: QuoxFullscreenEventType,
  handler: DocumentFullscreenHandler | null,
): void {
  const entry = documentEntry(document, type, typeof handler === "function");
  if (entry === undefined) return;
  entry.handler = typeof handler === "function" ? handler : null;
  if (entry.handler === null && entry.listeners.size === 0) documentEvents.get(document)?.delete(type);
}

export function addDocumentEventListener(
  document: QuoxDocument,
  type: QuoxFullscreenEventType,
  listener: DocumentFullscreenHandler,
): void {
  if (typeof listener !== "function") return;
  documentEntry(document, type, true)!.listeners.add(listener);
}

export function removeDocumentEventListener(
  document: QuoxDocument,
  type: QuoxFullscreenEventType,
  listener: DocumentFullscreenHandler,
): void {
  const entry = documentEntry(document, type, false);
  if (entry === undefined) return;
  entry.listeners.delete(listener);
  if (entry.handler === null && entry.listeners.size === 0) documentEvents.get(document)?.delete(type);
}

export function invokeEventHandlers(document: QuoxDocument, path: Iterable<number>, type: QuoxEventType): void {
  const frozenPath = Object.freeze([...path]);
  const targetId = frozenPath[0];
  if (targetId === undefined) return;

  const handlers = elementEvents.get(document);
  const target = handlers?.get(targetId)?.values().next().value?.handlerElement ?? new QuoxElement(document, targetId);
  const event = new BubblingQuoxEvent(type, target, !["focus", "blur", "scroll"].includes(type));

  for (const nodeId of frozenPath) {
    const entry = handlers?.get(nodeId)?.get(type);
    if (entry !== undefined) invokeElementEntry(entry, event);
    if (event.propagationStopped) break;
  }
  event.setCurrentTarget(null);
}

export function dispatchFullscreenEvent(
  document: QuoxDocument,
  target: QuoxElement | null,
  path: Iterable<number>,
  type: QuoxFullscreenEventType,
): void {
  const event = new BubblingFullscreenEvent(type, target ?? document);
  const handlers = elementEvents.get(document);
  if (target !== null) {
    for (const nodeId of path) {
      const entry = handlers?.get(nodeId)?.get(type);
      if (entry !== undefined) invokeElementEntry(entry, event);
      if (event.propagationStopped) break;
    }
  }

  if (!event.propagationStopped) {
    const entry = documentEvents.get(document)?.get(type);
    if (entry !== undefined) {
      event.setCurrentTarget(document);
      entry.handler?.call(document, event);
      for (const listener of [...entry.listeners]) listener.call(document, event);
    }
  }
  event.setCurrentTarget(null);
}

type InternalBubblingEvent = BubblingQuoxEvent | BubblingFullscreenEvent;

function invokeElementEntry(entry: ElementEventEntry, event: InternalBubblingEvent): void {
  event.setCurrentTarget(entry.handlerElement);
  const handler = entry.handler as ((this: QuoxElement, event: InternalBubblingEvent) => unknown) | null;
  handler?.call(entry.handlerElement, event);
  for (const [listener, element] of [...entry.listeners]) {
    event.setCurrentTarget(element);
    (listener as (this: QuoxElement, event: InternalBubblingEvent) => unknown).call(element, event);
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

class BubblingFullscreenEvent implements QuoxFullscreenEvent {
  #currentTarget: QuoxElement | QuoxDocument | null = null;
  #propagationStopped = false;
  readonly bubbles = true;

  constructor(
    readonly type: QuoxFullscreenEventType,
    readonly target: QuoxElement | QuoxDocument,
  ) {}

  get currentTarget(): QuoxElement | QuoxDocument | null {
    return this.#currentTarget;
  }

  get propagationStopped(): boolean {
    return this.#propagationStopped;
  }

  stopPropagation(): void {
    this.#propagationStopped = true;
  }

  setCurrentTarget(target: QuoxElement | QuoxDocument | null): void {
    this.#currentTarget = target;
  }
}
