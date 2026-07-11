import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  BufferedEventSource,
  collectInitializationCleanupErrors,
  INITIALIZATION_EVENT_POLL_INTERVAL_MS,
  InitializationEventPump,
  type OneShotTaskScheduler,
  type RepeatingTaskScheduler,
  WindowStartupGate,
} from "./initialization_pump.ts";

class ManualRepeatingScheduler {
  callback: (() => void) | undefined;
  intervalMs: number | undefined;
  cancelCount = 0;
  active = false;

  readonly schedule: RepeatingTaskScheduler = (callback, intervalMs) => {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.active = true;
    return () => {
      if (!this.active) return;
      this.active = false;
      this.cancelCount++;
    };
  };

  tick(): void {
    if (this.active) this.callback?.();
  }
}

class ManualOneShotScheduler {
  callback: (() => void) | undefined;
  cancelCount = 0;
  active = false;

  readonly schedule: OneShotTaskScheduler = (callback) => {
    this.callback = callback;
    this.active = true;
    return () => {
      if (!this.active) return;
      this.active = false;
      this.cancelCount++;
    };
  };

  run(): void {
    if (!this.active) return;
    this.active = false;
    this.callback?.();
  }
}

Deno.test("initialization pump services every await phase and transfers one exact FIFO", () => {
  type Event = { readonly type: string; readonly sequence: number };
  const scheduler = new ManualRepeatingScheduler();
  const pending: Event[] = [];
  let reads = 0;
  let finalDrain = false;
  const pump = new InitializationEventPump(() => {
    reads++;
    if (finalDrain) assertEquals(scheduler.active, false);
    return pending.shift();
  }, scheduler.schedule);

  pump.start();
  assertEquals(scheduler.intervalMs, INITIALIZATION_EVENT_POLL_INTERVAL_MS);
  assertEquals(reads, 1); // An empty immediate drain still services protocol-only callbacks.

  pending.push({ type: "resize", sequence: 1 }, { type: "resize", sequence: 2 });
  scheduler.tick(); // Renderer await.
  pump.checkpoint();
  assertEquals(reads, 4); // Both events and the terminating undefined were consumed.

  pending.push({ type: "keydown", sequence: 3 });
  scheduler.tick(); // Async head mount.
  pump.checkpoint();
  pending.push({ type: "ime", sequence: 4 });
  scheduler.tick(); // Async body mount.
  pump.checkpoint();

  pending.push({ type: "visibilitychange", sequence: 5 });
  finalDrain = true;
  const events = pump.finish(); // Final drain closes the handoff race.
  assertEquals(events, [
    { type: "resize", sequence: 1 },
    { type: "resize", sequence: 2 },
    { type: "keydown", sequence: 3 },
    { type: "ime", sequence: 4 },
    { type: "visibilitychange", sequence: 5 },
  ]);
  assertEquals(scheduler.cancelCount, 1);

  const readsAfterFinish = reads;
  scheduler.tick();
  assertEquals(reads, readsAfterFinish);
  assertThrows(() => pump.finish(), Error, "cannot be finished");
});

Deno.test("initialization pump contains timer failures and cancels before cleanup", () => {
  const scheduler = new ManualRepeatingScheduler();
  const nativeFailure = new Error("native event pump failed");
  let shouldFail = false;
  let reads = 0;
  const pump = new InitializationEventPump(() => {
    reads++;
    if (shouldFail) throw nativeFailure;
    return undefined;
  }, scheduler.schedule);

  pump.start();
  shouldFail = true;
  scheduler.tick(); // A timer callback must retain, rather than throw, this error.
  assertEquals(scheduler.active, false);
  assertEquals(scheduler.cancelCount, 1);

  const checkpointError = assertThrows(() => pump.checkpoint());
  assertStrictEquals(checkpointError, nativeFailure);
  const order: string[] = [];
  pump.cancel();
  order.push("native-cleanup");
  assertEquals(order, ["native-cleanup"]);

  const readsAfterFailure = reads;
  scheduler.tick();
  assertEquals(reads, readsAfterFailure);
});

Deno.test("concurrent await and pump failures are both retained without duplication", () => {
  const scheduler = new ManualRepeatingScheduler();
  const awaitFailure = new Error("renderer initialization failed");
  const pumpFailure = new Error("native event polling failed");
  let shouldFail = false;
  const pump = new InitializationEventPump(() => {
    if (shouldFail) throw pumpFailure;
    return undefined;
  }, scheduler.schedule);
  pump.start();
  shouldFail = true;
  scheduler.tick();

  const order: string[] = [];
  const observedPump = {
    checkpoint: () => {
      order.push("pump-checkpoint");
      pump.checkpoint();
    },
    cancel: () => {
      order.push("pump-cancel");
      pump.cancel();
    },
  };
  const errors: unknown[] = [awaitFailure];
  collectInitializationCleanupErrors(errors, observedPump, [
    () => order.push("renderer-free"),
    () => order.push("window-close"),
    () => order.push("library-close"),
  ]);
  assertEquals(errors, [awaitFailure, pumpFailure]);
  assertEquals(order, [
    "pump-checkpoint",
    "pump-cancel",
    "renderer-free",
    "window-close",
    "library-close",
  ]);

  const deduplicated: unknown[] = [pumpFailure];
  collectInitializationCleanupErrors(deduplicated, observedPump, []);
  assertEquals(deduplicated, [pumpFailure]);
});

Deno.test("initialization cleanup retains A+B+C+D+E+F failures in exact order", () => {
  const awaitFailure = new Error("A: mount failed");
  const pumpFailure = new Error("B: native event polling failed");
  const sharedCleanupFailure = new Error("C/D: shared cleanup failure");
  const windowFailure = new Error("E: window close failed");
  const libraryFailure = new Error("F: library close failed");
  const errors: unknown[] = [awaitFailure];
  const order: string[] = [];

  collectInitializationCleanupErrors(
    errors,
    {
      checkpoint: () => {
        order.push("pump-checkpoint");
        throw pumpFailure;
      },
      cancel: () => {
        order.push("pump-cancel");
        throw sharedCleanupFailure;
      },
    },
    [
      () => {
        order.push("renderer-free");
        throw sharedCleanupFailure;
      },
      () => {
        order.push("window-close");
        throw windowFailure;
      },
      () => {
        order.push("library-close");
        throw libraryFailure;
      },
    ],
  );

  assertEquals(errors, [
    awaitFailure,
    pumpFailure,
    sharedCleanupFailure,
    sharedCleanupFailure,
    windowFailure,
    libraryFailure,
  ]);
  assertEquals(order, [
    "pump-checkpoint",
    "pump-cancel",
    "renderer-free",
    "window-close",
    "library-close",
  ]);
});

Deno.test("a final-drain failure is surfaced without restarting the timer", () => {
  const scheduler = new ManualRepeatingScheduler();
  const nativeFailure = new Error("final drain failed");
  let shouldFail = false;
  let reads = 0;
  const pump = new InitializationEventPump(() => {
    reads++;
    if (shouldFail) throw nativeFailure;
    return undefined;
  }, scheduler.schedule);

  pump.start();
  shouldFail = true;
  const finishError = assertThrows(() => pump.finish());
  assertStrictEquals(finishError, nativeFailure);
  assertEquals(scheduler.active, false);
  assertEquals(scheduler.cancelCount, 1);
  pump.cancel();
  assertEquals(reads, 2);
});

Deno.test("cancelling initialization never performs a final native read", () => {
  const scheduler = new ManualRepeatingScheduler();
  let reads = 0;
  const pump = new InitializationEventPump(() => {
    reads++;
    return undefined;
  }, scheduler.schedule);

  pump.start();
  assertEquals(reads, 1);
  pump.cancel();
  assertEquals(reads, 1);
  assertEquals(scheduler.cancelCount, 1);
  assertThrows(() => pump.finish(), Error, "current state");
});

Deno.test("buffered initialization events precede live events and hand off once", () => {
  const live = ["live-4", "live-5"];
  const source = new BufferedEventSource(() => live.shift());
  source.handoff(["initial-1", "initial-2", "initial-3"]);

  assertEquals(
    [source.read(), source.read(), source.read(), source.read(), source.read(), source.read()],
    ["initial-1", "initial-2", "initial-3", "live-4", "live-5", undefined],
  );
  assertThrows(() => source.handoff([]), Error, "already been handed off");
});

Deno.test("startup gate replays resize state before the first render task", () => {
  type Event =
    | { readonly type: "resize"; readonly width: number; readonly frameToken: number }
    | { readonly type: "focus" };
  const task = new ManualOneShotScheduler();
  const live: Event[] = [{ type: "focus" }];
  const source = new BufferedEventSource<Event>(() => live.shift());
  source.handoff([{ type: "resize", width: 1200, frameToken: 7 }]);
  const startup = new WindowStartupGate(task.schedule);
  const order: string[] = [];
  let width = 800;
  let frameToken: number | undefined;
  let renderRequested = false;

  // Mount/title mutations request rendering before start, but the real window
  // only records that need while this gate is closed.
  const requestRender = () => {
    renderRequested = true;
    if (startup.renderingEnabled) order.push(`render:${width}:${frameToken}`);
  };
  requestRender();
  assertEquals(order, []);

  startup.start(
    () => {
      let event: Event | undefined;
      while ((event = source.read()) !== undefined) {
        order.push(`event:${event.type}`);
        if (event.type === "resize") {
          width = event.width;
          frameToken = event.frameToken;
        }
      }
    },
    requestRender,
  );
  order.push("listener-attached"); // Promise continuation runs before the zero-delay task.
  requestRender(); // A user mutation after openWindow resolves remains gated until replay.
  assertEquals(renderRequested, true);
  assertEquals(order, ["listener-attached"]);

  task.run();
  assertEquals(order, [
    "listener-attached",
    "event:resize",
    "event:focus",
    "render:1200:7",
  ]);
  assertEquals(startup.start(() => {}, () => {}), false);
});

Deno.test("startup replay preserves close notification order and suppresses rendering", () => {
  const task = new ManualOneShotScheduler();
  const source = new BufferedEventSource<"resize" | "close" | "late">(() => "late");
  source.handoff(["resize", "close", "late"]);
  const startup = new WindowStartupGate(task.schedule);
  const order: string[] = [];
  let disposed = false;

  startup.start(
    () => {
      let event: "resize" | "close" | "late" | undefined;
      while ((event = source.read()) !== undefined) {
        order.push(`route:${event}`, `listener:${event}`);
        if (event === "close") {
          disposed = true;
          source.discardBuffered();
          startup.cancel();
          return;
        }
      }
    },
    () => {
      if (!disposed) order.push("render");
    },
  );
  order.push("listener-attached");
  task.run();

  assertEquals(order, [
    "listener-attached",
    "route:resize",
    "listener:resize",
    "route:close",
    "listener:close",
  ]);
});

Deno.test("cancelled startup tasks never poll or render", () => {
  const task = new ManualOneShotScheduler();
  const startup = new WindowStartupGate(task.schedule);
  const order: string[] = [];
  startup.start(() => order.push("poll"), () => order.push("render"));
  startup.cancel();
  task.run();
  assertEquals(order, []);
  assertEquals(task.cancelCount, 1);
});
