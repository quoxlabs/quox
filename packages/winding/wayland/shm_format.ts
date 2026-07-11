import { WlShmFormat } from "./ffi.ts";

export type WaylandShmFormatGeneration = symbol;

export const MISSING_ARGB8888_SHM_FORMAT =
  "winding Wayland compositor did not advertise the required ARGB8888 shared-memory format";

/** Tracks format events for exactly the currently selected wl_shm binding. */
export class WaylandShmFormatState {
  #generation: WaylandShmFormatGeneration | undefined;
  #hasArgb8888 = false;

  beginBinding(): WaylandShmFormatGeneration {
    const generation = Symbol("wl_shm binding");
    this.#generation = generation;
    this.#hasArgb8888 = false;
    return generation;
  }

  advertise(generation: WaylandShmFormatGeneration, format: number): boolean {
    if (generation !== this.#generation || format !== WlShmFormat.ARGB8888) return false;
    const newlySupported = !this.#hasArgb8888;
    this.#hasArgb8888 = true;
    return newlySupported;
  }

  releaseBinding(generation: WaylandShmFormatGeneration): void {
    if (generation !== this.#generation) return;
    this.#generation = undefined;
    this.#hasArgb8888 = false;
  }

  get hasArgb8888(): boolean {
    return this.#generation !== undefined && this.#hasArgb8888;
  }

  requireArgb8888(): void {
    if (!this.hasArgb8888) throw new Error(MISSING_ARGB8888_SHM_FORMAT);
  }
}
