import type { Window, WindowEvent } from "../types.ts";

/**
 * FIFO for semantic events produced by native callbacks.
 *
 * Closing the queue discards pending events and makes later callback pushes a
 * no-op. This is important during native teardown, where a protocol can invoke
 * one final callback after the public library has begun closing.
 */
export class EventQueue<Event extends WindowEvent> {
  readonly #events: Event[] = [];
  #closed = false;

  get length(): number {
    return this.#events.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: Event): void {
    if (!this.#closed) this.#events.push(event);
  }

  /** Put a causative event ahead of callbacks queued synchronously while translating it. */
  prepend(event: Event): void {
    if (!this.#closed) this.#events.unshift(event);
  }

  pushBatch(events: Iterable<Event>): void {
    if (this.#closed) return;
    for (const event of events) this.#events.push(event);
  }

  shift(): Event | undefined {
    return this.#events.shift();
  }

  /** Remove events that still reference a window whose native resources are closing. */
  purgeWindow(window: Window): void {
    let write = 0;
    for (const event of this.#events) {
      if (event.window !== window) this.#events[write++] = event;
    }
    this.#events.length = write;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.length = 0;
  }
}
