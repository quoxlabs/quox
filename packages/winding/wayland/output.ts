/** Pure core-output scale, membership, and frame-request state. */

import {
  calculateWaylandFractionalFramebufferSize,
  isValidWaylandFractionalScaleNumerator,
} from "./fractional_scale.ts";
import { validateWaylandShmLayout } from "./shm_buffer.ts";

const MAX_WAYLAND_SCALE = 0x7fffffff;

export type WaylandOutputGeneration = symbol;

export interface WaylandOutputScaleSnapshot {
  readonly generation: WaylandOutputGeneration;
  readonly scale: number;
}

export interface WaylandOutputBinding<Binding> {
  readonly name: number;
  readonly offeredVersion: number;
  readonly binding: Binding;
}

/** Owns every wl_output registry name independently, including replacements. */
export class WaylandOutputRegistry<Binding> {
  readonly #outputs = new Map<number, WaylandOutputBinding<Binding>>();

  constructor(
    readonly bind: (name: number, offeredVersion: number) => Binding | null,
    readonly release: (output: WaylandOutputBinding<Binding>) => void,
  ) {}

  announce(name: number, offeredVersion: number): WaylandOutputBinding<Binding> | undefined {
    const existing = this.#outputs.get(name);
    if (existing !== undefined) return existing;
    const binding = this.bind(name, offeredVersion);
    if (binding === null) return undefined;
    const output = { name, offeredVersion, binding };
    this.#outputs.set(name, output);
    return output;
  }

  get(name: number): WaylandOutputBinding<Binding> | undefined {
    return this.#outputs.get(name);
  }

  remove(name: number): void {
    const output = this.#outputs.get(name);
    if (output === undefined) return;
    this.#outputs.delete(name);
    this.release(output);
  }

  close(): void {
    const outputs = [...this.#outputs.values()].reverse();
    this.#outputs.clear();
    const errors: unknown[] = [];
    for (const output of outputs) {
      try {
        this.release(output);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "failed to release Wayland outputs");
  }
}

/** Batches wl_output.scale until wl_output.done and rejects stale generations. */
export class WaylandOutputScaleState {
  #scale = 1;
  #pendingScale: number | undefined;

  constructor(
    readonly generation: WaylandOutputGeneration,
    readonly version: number,
  ) {}

  get scale(): number {
    return this.#scale;
  }

  stage(generation: WaylandOutputGeneration, scale: number): boolean {
    if (generation !== this.generation || this.version < 2 || !isValidWaylandScale(scale)) return false;
    this.#pendingScale = scale;
    return true;
  }

  done(generation: WaylandOutputGeneration): number | undefined {
    if (generation !== this.generation || this.version < 2 || this.#pendingScale === undefined) return undefined;
    const scale = this.#pendingScale;
    this.#pendingScale = undefined;
    if (scale === this.#scale) return undefined;
    this.#scale = scale;
    return scale;
  }
}

/** Tracks the outputs entered by one surface and selects a deterministic integer scale. */
export class WaylandSurfaceOutputScaleState {
  readonly #entered = new Map<WaylandOutputGeneration, number>();
  #preferredScale = 1;

  constructor(readonly surfaceVersion: number) {}

  enter(generation: WaylandOutputGeneration, scale: number): boolean {
    if (!isValidWaylandScale(scale) || this.#entered.get(generation) === scale) return false;
    this.#entered.set(generation, scale);
    return true;
  }

  leave(generation: WaylandOutputGeneration): boolean {
    return this.#entered.delete(generation);
  }

  update(generation: WaylandOutputGeneration, scale: number): boolean {
    if (!this.#entered.has(generation) || !isValidWaylandScale(scale)) return false;
    if (this.#entered.get(generation) === scale) return false;
    this.#entered.set(generation, scale);
    return true;
  }

  prefer(scale: number): boolean {
    if (this.surfaceVersion < 6 || !isValidWaylandScale(scale) || scale === this.#preferredScale) return false;
    this.#preferredScale = scale;
    return true;
  }

  effectiveScale(canUse: (scale: number) => boolean = () => true): number {
    if (this.surfaceVersion < 3) return 1;
    if (this.surfaceVersion >= 6) return canUse(this.#preferredScale) ? this.#preferredScale : 1;
    const scales = [...new Set(this.#entered.values())].sort((left, right) => right - left);
    for (const scale of scales) {
      if (canUse(scale)) return scale;
    }
    return 1;
  }
}

export class WaylandConfigureAckState {
  #serial: number | undefined;

  ack(serial: number, send: (serial: number) => void): boolean {
    const normalized = serial >>> 0;
    if (normalized === this.#serial) return false;
    send(normalized);
    this.#serial = normalized;
    return true;
  }
}

export type WaylandSurfaceFrameRequest =
  | { readonly kind: "set-buffer-scale"; readonly scale: number }
  | { readonly kind: "set-viewport-destination"; readonly width: number; readonly height: number }
  | { readonly kind: "attach" }
  | { readonly kind: "damage-buffer" | "damage-surface"; readonly width: number; readonly height: number }
  | { readonly kind: "commit" };

export interface WaylandSurfaceFrameOptions {
  readonly viewportAvailable?: boolean;
  readonly fractionalScaleNumerator?: number;
}

export function planWaylandSurfaceFrame(
  surfaceVersion: number,
  scale: number,
  logicalWidth: number,
  logicalHeight: number,
  framebufferWidth: number,
  framebufferHeight: number,
  options: WaylandSurfaceFrameOptions = {},
): readonly WaylandSurfaceFrameRequest[] {
  let useFractionalScale = false;
  if (
    options.viewportAvailable === true &&
    options.fractionalScaleNumerator !== undefined &&
    isValidWaylandFractionalScaleNumerator(options.fractionalScaleNumerator)
  ) {
    const selected = calculateWaylandFractionalFramebufferSize(
      logicalWidth,
      logicalHeight,
      options.fractionalScaleNumerator,
    );
    if (selected?.width === framebufferWidth && selected.height === framebufferHeight) {
      try {
        validateWaylandShmLayout(selected.width, selected.height);
        useFractionalScale = true;
      } catch {
        // A syntactically valid preference is not selected when its buffer cannot be represented.
      }
    }
  }
  const effectiveScale = useFractionalScale ? 1 : surfaceVersion >= 3 && isValidWaylandScale(scale) ? scale : 1;
  const requests: WaylandSurfaceFrameRequest[] = [];
  if (surfaceVersion >= 3) requests.push({ kind: "set-buffer-scale", scale: effectiveScale });
  if (options.viewportAvailable) {
    requests.push({
      kind: "set-viewport-destination",
      width: useFractionalScale ? logicalWidth : -1,
      height: useFractionalScale ? logicalHeight : -1,
    });
  }
  requests.push({ kind: "attach" });
  requests.push(
    surfaceVersion >= 4
      ? { kind: "damage-buffer", width: framebufferWidth, height: framebufferHeight }
      : { kind: "damage-surface", width: logicalWidth, height: logicalHeight },
  );
  requests.push({ kind: "commit" });
  return requests;
}

export function outputReleaseStrategy(version: number): "release" | "proxy-destroy" {
  return version >= 3 ? "release" : "proxy-destroy";
}

export function isValidWaylandScale(scale: number): boolean {
  return Number.isSafeInteger(scale) && scale > 0 && scale <= MAX_WAYLAND_SCALE;
}
