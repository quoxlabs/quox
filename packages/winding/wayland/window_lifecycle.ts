import type { Window } from "../types.ts";

export const WAYLAND_WINDOW_CLOSED_MESSAGE = "winding(wayland): window is closed";

export type WaylandWindowMutationName = Exclude<keyof Window, "close" | typeof Symbol.dispose>;

function exhaustiveMutationNames<Names extends readonly WaylandWindowMutationName[]>(
  names: Names & (WaylandWindowMutationName extends Names[number] ? unknown : never),
): Names {
  return names;
}

/** Keep the lifecycle boundary in sync when the shared Window contract grows. */
export const WAYLAND_WINDOW_MUTATION_NAMES = exhaustiveMutationNames(
  [
    "setTitle",
    "blit",
    "setImeEnabled",
    "setImeSurroundingText",
    "setImeCursorArea",
  ] as const,
);

/** Pure lifecycle boundary shared by every public Wayland window mutation. */
export class WaylandWindowLifecycleGate {
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Reject before the guarded operation can validate, allocate, mutate, or call native code. */
  mutate<Name extends WaylandWindowMutationName, Result>(
    _name: Name,
    operation: () => Result,
  ): Result {
    if (this.#closed) throw new Error(WAYLAND_WINDOW_CLOSED_MESSAGE);
    return operation();
  }

  /** Mark closed before cleanup so reentrant mutations reject and cleanup is attempted once. */
  close(cleanup: () => void): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    cleanup();
    return true;
  }
}
