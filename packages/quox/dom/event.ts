import type { QuoxEventTarget } from "./event_target.ts";

export type QuoxEventPhase = 0 | 1 | 2 | 3;

export interface QuoxEventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

export interface QuoxEventDispatchInternals {
  readonly dispatching: boolean;
  readonly propagationStopped: boolean;
  readonly immediatePropagationStopped: boolean;
  readonly canceled: boolean;

  begin(
    target: QuoxEventTarget,
    path: readonly QuoxEventTarget[],
    trusted?: boolean,
    timeStamp?: number,
  ): void;
  enter(currentTarget: QuoxEventTarget, phase: Exclude<QuoxEventPhase, 0>): void;
  setPassiveListener(passive: boolean): void;
  end(): boolean;
}

/** Internal capability used by the staged renderer bridge while dispatching an event. */
export const eventDispatchInternals: unique symbol = Symbol("QuoxEvent.dispatchInternals");

function timestamp(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export class QuoxEvent {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;

  readonly NONE = QuoxEvent.NONE;
  readonly CAPTURING_PHASE = QuoxEvent.CAPTURING_PHASE;
  readonly AT_TARGET = QuoxEvent.AT_TARGET;
  readonly BUBBLING_PHASE = QuoxEvent.BUBBLING_PHASE;

  #type: string;
  #target: QuoxEventTarget | null = null;
  #currentTarget: QuoxEventTarget | null = null;
  #path: QuoxEventTarget[] = [];
  #phase: QuoxEventPhase = QuoxEvent.NONE;
  #bubbles: boolean;
  #cancelable: boolean;
  #composed: boolean;
  #trusted = false;
  #dispatching = false;
  #propagationStopped = false;
  #immediatePropagationStopped = false;
  #inPassiveListener = false;
  #canceled = false;
  #timeStamp = timestamp();

  readonly #dispatchInternals: QuoxEventDispatchInternals;

  constructor(type: string, eventInit: QuoxEventInit = {}) {
    this.#type = `${type}`;
    this.#bubbles = Boolean(eventInit?.bubbles);
    this.#cancelable = Boolean(eventInit?.cancelable);
    this.#composed = Boolean(eventInit?.composed);
    const dispatching = () => this.#dispatching;
    const propagationStopped = () => this.#propagationStopped;
    const immediatePropagationStopped = () => this.#immediatePropagationStopped;
    const canceled = () => this.#canceled;
    this.#dispatchInternals = {
      get dispatching() {
        return dispatching();
      },
      get propagationStopped() {
        return propagationStopped();
      },
      get immediatePropagationStopped() {
        return immediatePropagationStopped();
      },
      get canceled() {
        return canceled();
      },
      begin: (target, path, trusted = false, dispatchTimeStamp) => {
        if (this.#dispatching) {
          throw new DOMException("The event is already being dispatched.", "InvalidStateError");
        }
        if (path.length === 0 || path[0] !== target) {
          throw new TypeError("an event path must start with its target");
        }
        if (dispatchTimeStamp !== undefined) {
          if (!Number.isFinite(dispatchTimeStamp) || dispatchTimeStamp < 0) {
            throw new RangeError("an event timestamp must be a finite nonnegative number");
          }
          this.#timeStamp = dispatchTimeStamp;
        }

        this.#target = target;
        this.#currentTarget = null;
        this.#path = Array.from(path);
        this.#phase = QuoxEvent.NONE;
        this.#trusted = trusted;
        this.#dispatching = true;
        this.#propagationStopped = false;
        this.#immediatePropagationStopped = false;
        this.#inPassiveListener = false;
      },
      enter: (currentTarget, phase) => {
        if (!this.#dispatching) {
          throw new DOMException("The event is not being dispatched.", "InvalidStateError");
        }
        this.#currentTarget = currentTarget;
        this.#phase = phase;
      },
      setPassiveListener: (passive) => {
        this.#inPassiveListener = passive;
      },
      end: () => {
        if (!this.#dispatching) {
          throw new DOMException("The event is not being dispatched.", "InvalidStateError");
        }

        const allowed = !this.#canceled;
        this.#currentTarget = null;
        this.#path = [];
        this.#phase = QuoxEvent.NONE;
        this.#dispatching = false;
        this.#propagationStopped = false;
        this.#immediatePropagationStopped = false;
        this.#inPassiveListener = false;
        return allowed;
      },
    };
  }

  get type(): string {
    return this.#type;
  }

  get target(): QuoxEventTarget | null {
    return this.#target;
  }

  get srcElement(): QuoxEventTarget | null {
    return this.#target;
  }

  get currentTarget(): QuoxEventTarget | null {
    return this.#currentTarget;
  }

  composedPath(): QuoxEventTarget[] {
    return this.#path.slice();
  }

  get eventPhase(): QuoxEventPhase {
    return this.#phase;
  }

  stopPropagation(): void {
    this.#propagationStopped = true;
  }

  get cancelBubble(): boolean {
    return this.#propagationStopped;
  }

  set cancelBubble(value: boolean) {
    if (value) this.stopPropagation();
  }

  stopImmediatePropagation(): void {
    this.#propagationStopped = true;
    this.#immediatePropagationStopped = true;
  }

  get bubbles(): boolean {
    return this.#bubbles;
  }

  get cancelable(): boolean {
    return this.#cancelable;
  }

  get returnValue(): boolean {
    return !this.#canceled;
  }

  set returnValue(value: boolean) {
    if (!value) this.preventDefault();
  }

  preventDefault(): void {
    if (this.#cancelable && !this.#inPassiveListener) this.#canceled = true;
  }

  get defaultPrevented(): boolean {
    return this.#canceled;
  }

  get composed(): boolean {
    return this.#composed;
  }

  get isTrusted(): boolean {
    return this.#trusted;
  }

  get timeStamp(): number {
    return this.#timeStamp;
  }

  initEvent(type: string, bubbles = false, cancelable = false): void {
    if (this.#dispatching) return;

    this.#type = `${type}`;
    this.#target = null;
    this.#bubbles = Boolean(bubbles);
    this.#cancelable = Boolean(cancelable);
    this.#trusted = false;
    this.#canceled = false;
    this.#propagationStopped = false;
    this.#immediatePropagationStopped = false;
  }

  get [eventDispatchInternals](): QuoxEventDispatchInternals {
    return this.#dispatchInternals;
  }
}
