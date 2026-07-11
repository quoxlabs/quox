import { eventDispatchInternals, QuoxEvent, type QuoxEventPhase } from "./event.ts";

export interface QuoxEventListener {
  (this: QuoxEventTarget, event: QuoxEvent): unknown;
}

export interface QuoxEventListenerObject {
  handleEvent(event: QuoxEvent): unknown;
}

export type QuoxEventListenerOrEventListenerObject = QuoxEventListener | QuoxEventListenerObject;

export interface QuoxEventListenerOptions {
  capture?: boolean;
}

export interface QuoxAddEventListenerOptions extends QuoxEventListenerOptions {
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

export type QuoxEventListenerPhase = "capturing" | "at-target" | "bubbling";
export type ReportEventListenerException = (error: unknown) => void;
export type QuoxEventHandler = (this: QuoxEventTarget, event: QuoxEvent) => unknown;

/** Internal listener-list entry point used by the staged renderer bridge. */
export const invokeEventListeners: unique symbol = Symbol("QuoxEventTarget.invokeEventListeners");

/** Internal target-first propagation path used by synthetic `dispatchEvent()` calls. */
export const eventTargetPath: unique symbol = Symbol("QuoxEventTarget.eventTargetPath");

/** Internal accessors used to implement one stable listener slot for each `on*` property. */
export const getEventHandler: unique symbol = Symbol("QuoxEventTarget.getEventHandler");
export const setEventHandler: unique symbol = Symbol("QuoxEventTarget.setEventHandler");

type ListenerRecord = {
  readonly type: string;
  readonly callback: QuoxEventListenerOrEventListenerObject;
  readonly capture: boolean;
  readonly once: boolean;
  readonly passive: boolean;
  removed: boolean;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type EventHandlerSlot = {
  callback: QuoxEventHandler;
  readonly listener: QuoxEventListener;
};

function toEventType(type: string): string {
  return `${type}`;
}

function validateListener(
  callback: QuoxEventListenerOrEventListenerObject | null | undefined,
): QuoxEventListenerOrEventListenerObject | null {
  if (callback == null) return null;
  if (typeof callback !== "function" && typeof callback !== "object") {
    throw new TypeError("an event listener must be a function, an object, or null");
  }
  return callback;
}

function flattenAddOptions(options: boolean | QuoxAddEventListenerOptions | null): {
  capture: boolean;
  once: boolean;
  passive: boolean;
  signal: AbortSignal | undefined;
} {
  if (typeof options === "boolean") {
    return { capture: options, once: false, passive: false, signal: undefined };
  }
  return {
    capture: Boolean(options?.capture),
    passive: Boolean(options?.passive),
    once: Boolean(options?.once),
    signal: options?.signal,
  };
}

function flattenCapture(options: boolean | QuoxEventListenerOptions | null): boolean {
  return typeof options === "boolean" ? options : Boolean(options?.capture);
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal.aborted;
}

function callListener(
  callback: QuoxEventListenerOrEventListenerObject,
  target: QuoxEventTarget,
  event: QuoxEvent,
): void {
  if (typeof callback === "function") {
    Reflect.apply(callback, target, [event]);
    return;
  }

  Reflect.apply(callback.handleEvent, callback, [event]);
}

export function reportEventListenerException(error: unknown): void {
  const reporter = Reflect.get(globalThis, "reportError");
  if (typeof reporter === "function") {
    try {
      Reflect.apply(reporter, globalThis, [error]);
    } catch (reportingError) {
      queueMicrotask(() => {
        throw reportingError;
      });
    }
    return;
  }

  queueMicrotask(() => {
    throw error;
  });
}

export class QuoxEventTarget {
  readonly #listeners = new Map<string, ListenerRecord[]>();
  readonly #eventHandlers = new Map<string, EventHandlerSlot>();

  addEventListener(
    type: string,
    callback: QuoxEventListenerOrEventListenerObject | null = null,
    options: boolean | QuoxAddEventListenerOptions | null = false,
  ): void {
    const eventType = toEventType(type);
    const listener = validateListener(callback);
    const { capture, once, passive, signal } = flattenAddOptions(options);
    const aborted = signalIsAborted(signal);
    if (listener === null || aborted) return;

    const records = this.#listeners.get(eventType) ?? [];
    if (records.some((record) => !record.removed && record.callback === listener && record.capture === capture)) return;

    const record: ListenerRecord = {
      type: eventType,
      callback: listener,
      capture,
      once,
      passive,
      removed: false,
      signal,
    };
    records.push(record);
    this.#listeners.set(eventType, records);

    if (signal !== undefined) {
      record.abortHandler = () => this.#removeListenerRecord(record);
      signal.addEventListener("abort", record.abortHandler, { once: true });
    }
  }

  removeEventListener(
    type: string,
    callback: QuoxEventListenerOrEventListenerObject | null = null,
    options: boolean | QuoxEventListenerOptions | null = false,
  ): void {
    const eventType = toEventType(type);
    const listener = validateListener(callback);
    const capture = flattenCapture(options);
    if (listener === null) return;

    const record = this.#listeners.get(eventType)?.find((candidate) =>
      !candidate.removed && candidate.callback === listener && candidate.capture === capture
    );
    if (record !== undefined) this.#removeListenerRecord(record);
  }

  dispatchEvent(event: QuoxEvent): boolean {
    if (!(event instanceof QuoxEvent)) {
      throw new TypeError("dispatchEvent expects a QuoxEvent");
    }

    const dispatch = event[eventDispatchInternals];
    if (dispatch.dispatching) {
      throw new DOMException("The event is already being dispatched.", "InvalidStateError");
    }
    const path = Array.from(this[eventTargetPath](event));
    if (path.some((target) => !(target instanceof QuoxEventTarget))) {
      throw new TypeError("an event path must contain only QuoxEventTarget objects");
    }
    dispatch.begin(this, path, false);
    let allowed = true;
    try {
      let reachesTarget = true;
      for (let index = path.length - 1; index > 0; index -= 1) {
        path[index][invokeEventListeners](event, "capturing", QuoxEvent.CAPTURING_PHASE);
        if (dispatch.propagationStopped) {
          reachesTarget = false;
          break;
        }
      }

      if (reachesTarget) {
        this[invokeEventListeners](event, "at-target", QuoxEvent.AT_TARGET);
        if (event.bubbles && !dispatch.propagationStopped) {
          for (let index = 1; index < path.length; index += 1) {
            path[index][invokeEventListeners](event, "bubbling", QuoxEvent.BUBBLING_PHASE);
            if (dispatch.propagationStopped) break;
          }
        }
      }
    } finally {
      allowed = dispatch.end();
    }
    return allowed;
  }

  [eventTargetPath](_event: QuoxEvent): readonly QuoxEventTarget[] {
    return [this];
  }

  [invokeEventListeners](
    event: QuoxEvent,
    phase: QuoxEventListenerPhase,
    eventPhase: Exclude<QuoxEventPhase, 0>,
    reportException: ReportEventListenerException = reportEventListenerException,
  ): void {
    const dispatch = event[eventDispatchInternals];
    if (!dispatch.dispatching) {
      throw new DOMException("The event is not being dispatched.", "InvalidStateError");
    }
    if (dispatch.immediatePropagationStopped) return;

    dispatch.enter(this, eventPhase);
    const records = this.#listeners.get(event.type)?.slice() ?? [];
    const captureGroups = phase === "at-target" ? [true, false] : [phase === "capturing"];
    listenerGroups:
    for (const capture of captureGroups) {
      for (const record of records) {
        if (record.removed || record.capture !== capture) continue;

        if (record.once) this.#removeListenerRecord(record);
        dispatch.setPassiveListener(record.passive);
        try {
          callListener(record.callback, this, event);
        } catch (error) {
          try {
            reportException(error);
          } catch (reportingError) {
            reportEventListenerException(reportingError);
          }
        } finally {
          dispatch.setPassiveListener(false);
        }

        if (dispatch.immediatePropagationStopped) break listenerGroups;
      }
    }
  }

  [getEventHandler](type: string): QuoxEventHandler | null {
    return this.#eventHandlers.get(toEventType(type))?.callback ?? null;
  }

  [setEventHandler](type: string, callback: QuoxEventHandler | null): void {
    const eventType = toEventType(type);
    if (callback !== null && typeof callback !== "function") {
      throw new TypeError("an event handler must be a function or null");
    }

    const existing = this.#eventHandlers.get(eventType);
    if (callback === null) {
      if (existing !== undefined) {
        this.removeEventListener(eventType, existing.listener);
        this.#eventHandlers.delete(eventType);
      }
      return;
    }

    if (existing !== undefined) {
      existing.callback = callback;
      return;
    }

    const slot = {} as EventHandlerSlot;
    const listener: QuoxEventListener = function (event) {
      if (Reflect.apply(slot.callback, this, [event]) === false) event.preventDefault();
    };
    Object.assign(slot, { callback, listener });
    this.#eventHandlers.set(eventType, slot);
    this.addEventListener(eventType, listener);
  }

  #removeListenerRecord(record: ListenerRecord): void {
    if (record.removed) return;
    record.removed = true;

    const records = this.#listeners.get(record.type);
    const index = records?.indexOf(record) ?? -1;
    if (records !== undefined && index !== -1) {
      records.splice(index, 1);
      if (records.length === 0) this.#listeners.delete(record.type);
    }

    if (record.signal !== undefined && record.abortHandler !== undefined) {
      record.signal.removeEventListener("abort", record.abortHandler);
    }
  }
}
