import { validateWaylandShmFrame } from "./shm_buffer.ts";

export const WAYLAND_PRESENTATION_DISABLED_MESSAGE = "winding(wayland): presentation pacing is unavailable";

export interface WaylandOwnedFrame {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly frameToken: number | undefined;
}

/** Validate first, then take an owned snapshot so callers cannot mutate a queued frame. */
export function copyWaylandFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  frameToken: number | undefined,
): WaylandOwnedFrame {
  validateWaylandShmFrame(width, height, rgba.byteLength);
  return { rgba: rgba.slice(), width, height, frameToken };
}

/** Keeps only the newest valid owned frame while presentation is gated. */
export class WaylandPendingFrameState {
  #pending: WaylandOwnedFrame | undefined;
  #disabled = false;

  get pending(): WaylandOwnedFrame | undefined {
    return this.#pending;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  replace(frame: WaylandOwnedFrame): boolean {
    if (this.#disabled) return false;
    this.#pending = frame;
    return true;
  }

  assertAvailable(): void {
    if (this.#disabled) throw new Error(WAYLAND_PRESENTATION_DISABLED_MESSAGE);
  }

  take(): WaylandOwnedFrame | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    return pending;
  }

  discardUnless(matches: (frame: WaylandOwnedFrame) => boolean): boolean {
    if (this.#pending === undefined || matches(this.#pending)) return false;
    this.#pending = undefined;
    return true;
  }

  disable(): void {
    this.#disabled = true;
    this.#pending = undefined;
  }

  close(): void {
    this.disable();
  }
}

export type WaylandPendingFrameDrainResult = "disabled" | "blocked" | "idle" | "stale" | "busy" | "presented";

/** Coalesce native callback retries and run them only through a post-dispatch scheduler. */
export class WaylandDeferredFrameRetry {
  #scheduled = false;
  #closed = false;

  constructor(
    readonly retry: () => void,
    readonly scheduleAfterCallback: (retry: () => void) => void,
  ) {}

  request(): boolean {
    if (this.#closed || this.#scheduled) return false;
    this.#scheduled = true;
    try {
      this.scheduleAfterCallback(() => {
        if (this.#closed) return;
        this.#scheduled = false;
        this.retry();
      });
    } catch (error) {
      this.#scheduled = false;
      throw error;
    }
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#scheduled = false;
  }
}

/** Library-owned queue drained only after libwayland returns from dispatch. */
export class WaylandPostDispatchQueue {
  readonly #actions: Array<() => void> = [];
  #closed = false;

  defer(action: () => void): boolean {
    if (this.#closed) return false;
    this.#actions.push(action);
    return true;
  }

  drain(): void {
    while (!this.#closed && this.#actions.length > 0) {
      const actions = this.#actions.splice(0);
      for (const action of actions) action();
    }
  }

  close(): void {
    this.#closed = true;
    this.#actions.length = 0;
  }
}

/** Shared drain transaction used by frame-done and wl_buffer.release retries. */
export function drainWaylandPendingFrame(
  pending: WaylandPendingFrameState,
  blocked: boolean,
  matches: (frame: WaylandOwnedFrame) => boolean,
  present: (frame: WaylandOwnedFrame) => boolean,
): WaylandPendingFrameDrainResult {
  if (pending.disabled) return "disabled";
  if (blocked) return "blocked";
  const frame = pending.take();
  if (frame === undefined) return "idle";
  if (!matches(frame)) return "stale";
  try {
    if (present(frame)) return "presented";
    pending.replace(frame);
    return "busy";
  } catch (error) {
    if (!pending.disabled) pending.replace(frame);
    throw error;
  }
}

/** Couple listener installation to the rollback that zombifies a failed constructor request. */
export function addWaylandFrameCallbackListenerOrRollback(
  addListener: () => number,
  rollback: (error: unknown) => never,
): void {
  try {
    if (addListener() !== 0) throw new Error("winding failed to listen to a Wayland frame callback");
  } catch (error) {
    rollback(error);
  }
}

export interface WaylandFrameCallbackRegistration<Proxy, GenerationToken> {
  readonly proxy: Proxy;
  readonly address: bigint;
  readonly generation: number;
  readonly generationToken: GenerationToken;
}

export interface WaylandFrameCallbackActions<Proxy, Callback, Owner extends object> {
  readonly destroyProxy: (proxy: Proxy) => void;
  readonly closeListener: (callback: Callback) => void;
  readonly retainListener: (callback: Callback) => void;
  readonly retainOwner: (owner: Owner) => void;
  readonly reportError: (error: unknown) => void;
}

export type WaylandFrameCallbackCompletion<Proxy, GenerationToken> =
  | { readonly kind: "ignored" }
  | {
    readonly kind: "completed" | "stranded";
    readonly registration: WaylandFrameCallbackRegistration<Proxy, GenerationToken>;
  };

/**
 * Owns one long-lived listener and at most one one-shot wl_callback proxy.
 * A failed local proxy destruction strands the graph instead of risking reuse.
 */
export class WaylandFrameCallbackOwnership<Proxy, Callback, Vtable, GenerationToken, Owner extends object> {
  #listener: Callback | null = null;
  #vtable: Vtable | undefined;
  #registration: WaylandFrameCallbackRegistration<Proxy, GenerationToken> | undefined;
  #nextGeneration = 0;
  #closed = false;
  #inert = false;
  #retained = false;

  constructor(readonly owner: Owner) {}

  get listener(): Callback | null {
    return this.#listener;
  }

  get vtable(): Vtable | undefined {
    return this.#vtable;
  }

  get registration(): WaylandFrameCallbackRegistration<Proxy, GenerationToken> | undefined {
    return this.#registration;
  }

  get outstanding(): boolean {
    return this.#registration !== undefined;
  }

  installListener(listener: Callback): void {
    if (this.#closed || this.#listener !== null) {
      throw new Error("winding Wayland frame listener is already initialized or closed");
    }
    this.#listener = listener;
  }

  installVtable(vtable: Vtable): void {
    if (this.#closed || this.#vtable !== undefined) {
      throw new Error("winding Wayland frame vtable is already initialized or closed");
    }
    this.#vtable = vtable;
  }

  arm(
    proxy: Proxy,
    address: bigint,
    generationToken: GenerationToken,
  ): WaylandFrameCallbackRegistration<Proxy, GenerationToken> {
    if (this.#closed || this.#inert || this.#registration !== undefined) {
      throw new Error("winding Wayland frame callback is already outstanding or closed");
    }
    this.#nextGeneration = this.#nextGeneration === Number.MAX_SAFE_INTEGER ? 1 : this.#nextGeneration + 1;
    const generation = this.#nextGeneration;
    const registration = {
      proxy,
      address,
      generation,
      generationToken,
    };
    this.#registration = registration;
    return registration;
  }

  matches(
    address: bigint,
    generation: number,
  ): WaylandFrameCallbackRegistration<Proxy, GenerationToken> | undefined {
    const registration = this.#registration;
    return !this.#closed && !this.#inert && registration !== undefined &&
        registration.address === address && registration.generation === generation
      ? registration
      : undefined;
  }

  complete(
    address: bigint,
    generation: number,
    actions: WaylandFrameCallbackActions<Proxy, Callback, Owner>,
  ): WaylandFrameCallbackCompletion<Proxy, GenerationToken> {
    const registration = this.matches(address, generation);
    if (registration === undefined) return { kind: "ignored" };
    if (!this.#destroy(registration, actions)) return { kind: "stranded", registration };
    return { kind: "completed", registration };
  }

  /** Roll back a callback whose listener or surface commit did not complete. */
  abort(
    registration: WaylandFrameCallbackRegistration<Proxy, GenerationToken>,
    actions: WaylandFrameCallbackActions<Proxy, Callback, Owner>,
  ): boolean {
    if (registration !== this.#registration || this.#inert) return false;
    return this.#destroy(registration, actions);
  }

  /** Drop the active proxy before closing the listener that may still receive its done event. */
  close(actions: WaylandFrameCallbackActions<Proxy, Callback, Owner>): boolean {
    if (this.#closed) return this.#registration === undefined;
    this.#closed = true;
    const registration = this.#registration;
    if (registration !== undefined && !this.#inert) this.#destroy(registration, actions);
    if (this.#registration !== undefined) {
      this.#strand(actions);
      return false;
    }

    const listener = this.#listener;
    this.#listener = null;
    this.#vtable = undefined;
    if (listener !== null) {
      try {
        actions.closeListener(listener);
      } catch (error) {
        actions.reportError(error);
      }
    }
    return true;
  }

  #destroy(
    registration: WaylandFrameCallbackRegistration<Proxy, GenerationToken>,
    actions: WaylandFrameCallbackActions<Proxy, Callback, Owner>,
  ): boolean {
    try {
      actions.destroyProxy(registration.proxy);
    } catch (error) {
      actions.reportError(error);
      this.#strand(actions);
      return false;
    }
    if (this.#registration === registration) this.#registration = undefined;
    return true;
  }

  #strand(actions: WaylandFrameCallbackActions<Proxy, Callback, Owner>): void {
    this.#inert = true;
    if (this.#retained) return;
    this.#retained = true;
    if (this.#listener !== null) actions.retainListener(this.#listener);
    actions.retainOwner(this.owner);
  }
}
