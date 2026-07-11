export const INITIALIZATION_EVENT_POLL_INTERVAL_MS = 16;

type CancelScheduledTask = () => void;

export type RepeatingTaskScheduler = (
  callback: () => void,
  intervalMs: number,
) => CancelScheduledTask;

export type OneShotTaskScheduler = (callback: () => void) => CancelScheduledTask;

const scheduleRepeatingTask: RepeatingTaskScheduler = (callback, intervalMs) => {
  const id = setInterval(callback, intervalMs);
  return () => clearInterval(id);
};

const scheduleOneShotTask: OneShotTaskScheduler = (callback) => {
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
};

type PumpState = "idle" | "running" | "failed" | "finished" | "cancelled";

/**
 * Services a non-blocking native event source while asynchronous window setup
 * is pending. Native events are retained in exact dequeue order for a later,
 * single-consumer handoff.
 */
export class InitializationEventPump<Event> {
  readonly #read: () => Event | undefined;
  readonly #schedule: RepeatingTaskScheduler;
  #state: PumpState = "idle";
  #cancelScheduledTask: CancelScheduledTask | null = null;
  #failure: { readonly error: unknown } | undefined;
  #events: Event[] = [];

  constructor(
    read: () => Event | undefined,
    schedule: RepeatingTaskScheduler = scheduleRepeatingTask,
  ) {
    this.#read = read;
    this.#schedule = schedule;
  }

  /** Begin same-isolate polling and perform an immediate first drain. */
  start(): void {
    if (this.#state !== "idle") throw new Error("initialization event pump has already started");
    this.#state = "running";
    try {
      this.#cancelScheduledTask = this.#schedule(
        () => this.#tick(),
        INITIALIZATION_EVENT_POLL_INTERVAL_MS,
      );
    } catch (error) {
      this.#fail(error);
      return;
    }
    // An injected scheduler may invoke synchronously. If that callback failed,
    // cancel the task handle that only became available when scheduling returned.
    if (this.#state !== "running") {
      this.#cancelTimer();
      return;
    }
    this.#tick();
  }

  /** Surface a native polling failure at a safe asynchronous boundary. */
  checkpoint(): void {
    if (this.#failure !== undefined) throw this.#failure.error;
  }

  /**
   * Stop initialization polling, drain once more, and transfer the complete
   * FIFO to its only normal-loop consumer.
   */
  finish(): Event[] {
    if (this.#state !== "running" && this.#state !== "failed") {
      throw new Error("initialization event pump cannot be finished in its current state");
    }

    this.#cancelTimer();
    if (this.#state === "running") {
      try {
        this.#drain();
      } catch (error) {
        this.#fail(error);
      }
    }
    this.checkpoint();

    this.#state = "finished";
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** Stop polling without touching the native source again. Safe during cleanup. */
  cancel(): void {
    if (this.#state === "cancelled" || this.#state === "finished") return;
    this.#cancelTimer();
    this.#state = "cancelled";
    this.#events = [];
  }

  #tick(): void {
    if (this.#state !== "running") return;
    try {
      this.#drain();
    } catch (error) {
      this.#fail(error);
    }
  }

  #drain(): void {
    let event: Event | undefined;
    while ((event = this.#read()) !== undefined) this.#events.push(event);
  }

  #fail(error: unknown): void {
    if (this.#failure === undefined) this.#failure = { error };
    this.#state = "failed";
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    const cancel = this.#cancelScheduledTask;
    this.#cancelScheduledTask = null;
    if (cancel !== null) cancel();
  }
}

export interface InitializationPumpCleanup {
  checkpoint(): void;
  cancel(): void;
}

/**
 * Preserve a retained pump failure before cancellation, then run every native
 * cleanup even when cancellation or an earlier cleanup also fails.
 */
export function collectInitializationCleanupErrors(
  errors: unknown[],
  pump: InitializationPumpCleanup | undefined,
  cleanupOperations: readonly (() => void)[],
): void {
  if (pump !== undefined) {
    captureRetainedPumpError(errors, () => pump.checkpoint());
    captureError(errors, () => pump.cancel());
  }
  for (const operation of cleanupOperations) captureError(errors, operation);
}

function captureRetainedPumpError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (errors.length === 0 || !Object.is(errors[0], error)) errors.push(error);
  }
}

function captureError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

/** Reads one initialization FIFO before continuing with the live native source. */
export class BufferedEventSource<Event> {
  readonly #readLive: () => Event | undefined;
  #buffer: Event[] = [];
  #index = 0;
  #handedOff = false;

  constructor(readLive: () => Event | undefined) {
    this.#readLive = readLive;
  }

  handoff(events: Event[]): void {
    if (this.#handedOff) throw new Error("initialization events have already been handed off");
    this.#handedOff = true;
    this.#buffer = events;
  }

  read(): Event | undefined {
    if (this.#index < this.#buffer.length) return this.#buffer[this.#index++];
    if (this.#buffer.length > 0) {
      this.#buffer = [];
      this.#index = 0;
    }
    return this.#readLive();
  }

  discardBuffered(): void {
    this.#buffer = [];
    this.#index = 0;
  }
}

/**
 * Defers the first native poll to a task so promise continuations can attach
 * listeners, then requests the first render only after replay is complete.
 */
export class WindowStartupGate {
  readonly #schedule: OneShotTaskScheduler;
  #state: "idle" | "scheduled" | "ready" | "cancelled" = "idle";
  #cancelScheduledTask: CancelScheduledTask | null = null;

  constructor(schedule: OneShotTaskScheduler = scheduleOneShotTask) {
    this.#schedule = schedule;
  }

  get started(): boolean {
    return this.#state !== "idle";
  }

  get renderingEnabled(): boolean {
    return this.#state === "ready";
  }

  start(pollEvents: () => void, requestRender: () => void): boolean {
    if (this.#state !== "idle") return false;
    this.#state = "scheduled";
    try {
      this.#cancelScheduledTask = this.#schedule(() => {
        this.#cancelScheduledTask = null;
        pollEvents();
        // Polling a buffered close disposes the window and cancels this gate.
        if (this.#state !== "scheduled") return;
        this.#state = "ready";
        requestRender();
      });
    } catch (error) {
      this.#state = "idle";
      throw error;
    }
    return true;
  }

  cancel(): void {
    const cancel = this.#cancelScheduledTask;
    this.#cancelScheduledTask = null;
    if (cancel !== null) cancel();
    if (this.#state === "scheduled") this.#state = "cancelled";
  }
}
