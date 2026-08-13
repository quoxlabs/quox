import { ElementEventKind } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";
import { documentInternals } from "./internals.ts";
import { QuoxElement, type QuoxEvent, type QuoxEventHandler, type QuoxEventType } from "./node.ts";

type AnyEventHandler = QuoxEventHandler<QuoxEvent>;

type EventHandlerEntry = {
  readonly element: QuoxElement;
  readonly handler: AnyEventHandler;
};

export interface QuoxEventFrame {
  readonly token: number;
  readonly type: QuoxEventType;
  readonly path: readonly number[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly pageX?: number;
  readonly pageY?: number;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly pointerId?: number;
  readonly pointerType?: "mouse" | "pen" | "touch";
  readonly isPrimary?: boolean;
  readonly pressure?: number;
  readonly tangentialPressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly altitudeAngle?: number;
  readonly azimuthAngle?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: 0;
  readonly key?: string;
  readonly code?: string;
  readonly location?: number;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly value?: string;
}

export interface EventDispatchResult {
  readonly defaultPrevented: boolean;
  readonly errors: readonly unknown[];
}

const eventHandlers = new WeakMap<QuoxDocument, Map<number, Map<QuoxEventType, EventHandlerEntry>>>();

const EVENT_KINDS: Readonly<Record<QuoxEventType, ElementEventKind>> = {
  click: ElementEventKind.Click,
  dblclick: ElementEventKind.DoubleClick,
  contextmenu: ElementEventKind.ContextMenu,
  input: ElementEventKind.Input,
  focus: ElementEventKind.Focus,
  blur: ElementEventKind.Blur,
  scroll: ElementEventKind.Scroll,
  pointermove: ElementEventKind.PointerMove,
  pointerdown: ElementEventKind.PointerDown,
  pointerup: ElementEventKind.PointerUp,
  pointerover: ElementEventKind.PointerOver,
  pointerout: ElementEventKind.PointerOut,
  mousemove: ElementEventKind.MouseMove,
  mousedown: ElementEventKind.MouseDown,
  mouseup: ElementEventKind.MouseUp,
  mouseover: ElementEventKind.MouseOver,
  mouseout: ElementEventKind.MouseOut,
  wheel: ElementEventKind.Wheel,
  keydown: ElementEventKind.KeyDown,
  keyup: ElementEventKind.KeyUp,
};

export function getEventHandler<Event extends QuoxEvent = QuoxEvent>(
  element: QuoxElement,
  type: QuoxEventType,
): QuoxEventHandler<Event> | null {
  return eventHandlers.get(element.ownerDocument)?.get(element.nodeId)?.get(type)?.handler ?? null;
}

export function setEventHandler<Event extends QuoxEvent = QuoxEvent>(
  element: QuoxElement,
  type: QuoxEventType,
  handler: QuoxEventHandler<Event> | null,
): void {
  const documentHandlers = eventHandlers.get(element.ownerDocument);
  const elementHandlers = documentHandlers?.get(element.nodeId);
  const existing = elementHandlers?.get(type);

  if (typeof handler !== "function") {
    if (existing === undefined) return;
    elementHandlers!.delete(type);
    documentInternals(element.ownerDocument).renderer.set_event_handler(element.nodeId, EVENT_KINDS[type], false);
    if (elementHandlers!.size === 0) documentHandlers!.delete(element.nodeId);
    if (documentHandlers!.size === 0) eventHandlers.delete(element.ownerDocument);
    return;
  }

  const entry = { element, handler: handler as unknown as AnyEventHandler };
  if (elementHandlers !== undefined) {
    elementHandlers.set(type, entry);
  } else {
    const handlers = new Map<QuoxEventType, EventHandlerEntry>([[type, entry]]);
    if (documentHandlers !== undefined) {
      documentHandlers.set(element.nodeId, handlers);
    } else {
      eventHandlers.set(element.ownerDocument, new Map([[element.nodeId, handlers]]));
    }
  }

  if (existing === undefined) {
    documentInternals(element.ownerDocument).renderer.set_event_handler(element.nodeId, EVENT_KINDS[type], true);
  }
}

export function dispatchEventFrame(document: QuoxDocument, frame: QuoxEventFrame): EventDispatchResult {
  const documentHandlers = eventHandlers.get(document);
  const path = Object.freeze([...frame.path]);
  const targetId = path[0];
  if (targetId === undefined) return { defaultPrevented: false, errors: [] };

  const target = firstElementForNode(documentHandlers?.get(targetId)) ?? new QuoxElement(document, targetId);
  const event = new DispatchedQuoxEvent(frame, target);
  const errors: unknown[] = [];

  for (const nodeId of path) {
    const entry = documentHandlers?.get(nodeId)?.get(frame.type);
    if (entry !== undefined) {
      event.setCurrentTarget(entry.element);
      try {
        if (entry.handler.call(entry.element, event) === false) event.preventDefault();
      } catch (error) {
        errors.push(error);
      } finally {
        event.setCurrentTarget(null);
      }
    }
    if (event.propagationStopped) break;
  }

  event.setCurrentTarget(null);
  return { defaultPrevented: event.defaultPrevented, errors };
}

function firstElementForNode(handlers: Map<QuoxEventType, EventHandlerEntry> | undefined): QuoxElement | undefined {
  return handlers?.values().next().value?.element;
}

class DispatchedQuoxEvent implements QuoxEvent {
  readonly type: QuoxEventType;
  readonly target: QuoxElement;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly clientX: number;
  readonly clientY: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly button: number;
  readonly buttons: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly pointerId: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly isPrimary: boolean;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: 0;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly value: string;
  #currentTarget: QuoxElement | null = null;
  #defaultPrevented = false;
  #propagationStopped = false;

  constructor(frame: QuoxEventFrame, target: QuoxElement) {
    this.type = frame.type;
    this.target = target;
    this.bubbles = frame.bubbles;
    this.cancelable = frame.cancelable;
    this.clientX = frame.clientX ?? 0;
    this.clientY = frame.clientY ?? 0;
    this.pageX = frame.pageX ?? 0;
    this.pageY = frame.pageY ?? 0;
    this.screenX = frame.screenX ?? 0;
    this.screenY = frame.screenY ?? 0;
    this.offsetX = frame.offsetX ?? 0;
    this.offsetY = frame.offsetY ?? 0;
    this.button = frame.button ?? 0;
    this.buttons = frame.buttons ?? 0;
    this.shiftKey = frame.shiftKey ?? false;
    this.ctrlKey = frame.ctrlKey ?? false;
    this.altKey = frame.altKey ?? false;
    this.metaKey = frame.metaKey ?? false;
    this.pointerId = frame.pointerId ?? 0;
    this.pointerType = frame.pointerType ?? "mouse";
    this.isPrimary = frame.isPrimary ?? false;
    this.pressure = frame.pressure ?? 0;
    this.tangentialPressure = frame.tangentialPressure ?? 0;
    this.tiltX = frame.tiltX ?? 0;
    this.tiltY = frame.tiltY ?? 0;
    this.twist = frame.twist ?? 0;
    this.altitudeAngle = frame.altitudeAngle ?? 0;
    this.azimuthAngle = frame.azimuthAngle ?? 0;
    this.deltaX = frame.deltaX ?? 0;
    this.deltaY = frame.deltaY ?? 0;
    this.deltaMode = 0;
    this.key = frame.key ?? "";
    this.code = frame.code ?? "";
    this.location = frame.location ?? 0;
    this.repeat = frame.repeat ?? false;
    this.isComposing = frame.isComposing ?? false;
    this.value = frame.value ?? "";
  }

  get currentTarget(): QuoxElement | null {
    return this.#currentTarget;
  }

  get defaultPrevented(): boolean {
    return this.#defaultPrevented;
  }

  get propagationStopped(): boolean {
    return this.#propagationStopped;
  }

  preventDefault(): void {
    if (this.cancelable) this.#defaultPrevented = true;
  }

  stopPropagation(): void {
    this.#propagationStopped = true;
  }

  setCurrentTarget(target: QuoxElement | null): void {
    this.#currentTarget = target;
  }
}
