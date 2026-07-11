import { assert, assertEquals, assertFalse, assertStrictEquals, assertThrows } from "@std/assert";
import { eventDispatchInternals, QuoxEvent } from "./event.ts";
import {
  getEventHandler,
  invokeEventListeners,
  QuoxEventTarget,
  type ReportEventListenerException,
  setEventHandler,
} from "./event_target.ts";

function dispatchPath(
  event: QuoxEvent,
  target: QuoxEventTarget,
  ancestors: readonly QuoxEventTarget[],
  reportException?: ReportEventListenerException,
): boolean {
  const dispatch = event[eventDispatchInternals];
  dispatch.begin(target, [target, ...ancestors], true);
  let allowed = true;
  try {
    for (const ancestor of ancestors.toReversed()) {
      ancestor[invokeEventListeners](event, "capturing", QuoxEvent.CAPTURING_PHASE, reportException);
      if (dispatch.propagationStopped) return !dispatch.canceled;
    }
    target[invokeEventListeners](event, "at-target", QuoxEvent.AT_TARGET, reportException);
    if (event.bubbles && !dispatch.propagationStopped) {
      for (const ancestor of ancestors) {
        ancestor[invokeEventListeners](event, "bubbling", QuoxEvent.BUBBLING_PHASE, reportException);
        if (dispatch.propagationStopped) break;
      }
    }
  } finally {
    allowed = dispatch.end();
  }
  return allowed;
}

Deno.test("staged listener invocation follows capture, target, and bubble order", () => {
  const target = new QuoxEventTarget();
  const parent = new QuoxEventTarget();
  const root = new QuoxEventTarget();
  const calls: string[] = [];

  root.addEventListener("ping", (event) => {
    calls.push("root capture");
    assertStrictEquals(event.target, target);
    assertStrictEquals(event.currentTarget, root);
    assertEquals(event.eventPhase, QuoxEvent.CAPTURING_PHASE);
    assertEquals(event.composedPath(), [target, parent, root]);
  }, true);
  parent.addEventListener("ping", () => calls.push("parent capture"), true);
  target.addEventListener("ping", () => calls.push("target capture"), true);
  target.addEventListener("ping", () => calls.push("target bubble"));
  parent.addEventListener("ping", () => calls.push("parent bubble"));
  root.addEventListener("ping", () => calls.push("root bubble"));

  assert(dispatchPath(new QuoxEvent("ping", { bubbles: true }), target, [parent, root]));
  assertEquals(calls, [
    "root capture",
    "parent capture",
    "target capture",
    "target bubble",
    "parent bubble",
    "root bubble",
  ]);
});

Deno.test("listener identity includes type, callback, and capture only", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  const listener = () => calls.push("called");

  target.addEventListener("one", listener, { once: false, passive: false });
  target.addEventListener("one", listener, { once: true, passive: true });
  target.addEventListener("one", listener, true);
  target.addEventListener("two", listener);

  target.dispatchEvent(new QuoxEvent("one"));
  target.dispatchEvent(new QuoxEvent("one"));
  target.dispatchEvent(new QuoxEvent("two"));
  assertEquals(calls, ["called", "called", "called", "called", "called"]);

  target.removeEventListener("one", listener, { capture: true });
  target.dispatchEvent(new QuoxEvent("one"));
  assertEquals(calls.length, 6);
});

Deno.test("listener removal applies to a snapshot while additions wait for a later invocation", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  const added = () => calls.push("added");
  const removed = () => calls.push("removed");

  target.addEventListener("change", () => {
    calls.push("first");
    target.removeEventListener("change", removed);
    target.addEventListener("change", added);
  });
  target.addEventListener("change", removed);

  target.dispatchEvent(new QuoxEvent("change"));
  assertEquals(calls, ["first"]);

  target.dispatchEvent(new QuoxEvent("change"));
  assertEquals(calls, ["first", "first", "added"]);
});

Deno.test("at-target capture and bubble listeners share one snapshot", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  const removed = () => calls.push("removed bubble");
  const added = () => calls.push("added bubble");

  target.addEventListener("target", () => {
    calls.push("capture");
    target.removeEventListener("target", removed);
    target.addEventListener("target", added);
  }, true);
  target.addEventListener("target", removed);

  target.dispatchEvent(new QuoxEvent("target"));
  assertEquals(calls, ["capture"]);

  target.dispatchEvent(new QuoxEvent("target"));
  assertEquals(calls, ["capture", "capture", "added bubble"]);
});

Deno.test("once listeners are removed before callback-driven nested dispatch", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];

  target.addEventListener("outer", () => {
    calls.push("once");
    target.dispatchEvent(new QuoxEvent("outer"));
  }, { once: true });
  target.addEventListener("outer", () => calls.push("regular"));

  target.dispatchEvent(new QuoxEvent("outer"));
  assertEquals(calls, ["once", "regular", "regular"]);
});

Deno.test("AbortSignal prevents or removes its exact listener record", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  const listener = () => calls.push("called");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();

  target.addEventListener("abortable", listener, { signal: alreadyAborted.signal });
  target.dispatchEvent(new QuoxEvent("abortable"));

  const controller = new AbortController();
  target.addEventListener("abortable", listener, { signal: controller.signal });
  controller.abort();
  target.addEventListener("abortable", listener);
  target.dispatchEvent(new QuoxEvent("abortable"));

  assertEquals(calls, ["called"]);
});

Deno.test("passive listeners cannot cancel while non-passive listeners can", () => {
  const passiveTarget = new QuoxEventTarget();
  passiveTarget.addEventListener("wheel", (event) => event.preventDefault(), { passive: true });
  const passiveEvent = new QuoxEvent("wheel", { cancelable: true });
  assert(passiveTarget.dispatchEvent(passiveEvent));
  assertFalse(passiveEvent.defaultPrevented);

  const activeTarget = new QuoxEventTarget();
  activeTarget.addEventListener("wheel", (event) => event.preventDefault());
  const activeEvent = new QuoxEvent("wheel", { cancelable: true });
  assertFalse(activeTarget.dispatchEvent(activeEvent));
  assert(activeEvent.defaultPrevented);
});

Deno.test("stop flags preserve later listeners on the same invocation only", () => {
  const target = new QuoxEventTarget();
  const parent = new QuoxEventTarget();
  const calls: string[] = [];

  target.addEventListener("stop", (event) => {
    calls.push("first capture");
    event.stopPropagation();
  }, true);
  target.addEventListener("stop", () => calls.push("second capture"), true);
  target.addEventListener("stop", () => calls.push("target bubble"));
  parent.addEventListener("stop", () => calls.push("parent bubble"));

  dispatchPath(new QuoxEvent("stop", { bubbles: true }), target, [parent]);
  assertEquals(calls, ["first capture", "second capture", "target bubble"]);

  const immediate = new QuoxEventTarget();
  immediate.addEventListener("stop", (event) => {
    calls.push("immediate");
    event.stopImmediatePropagation();
  });
  immediate.addEventListener("stop", () => calls.push("skipped"));
  immediate.dispatchEvent(new QuoxEvent("stop"));
  assertEquals(calls.at(-1), "immediate");
});

Deno.test("listener exceptions are reported and do not interrupt the snapshot", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  const thrown = new Error("listener failed");
  const errors: unknown[] = [];

  target.addEventListener("unsafe", () => {
    calls.push("throws");
    throw thrown;
  });
  target.addEventListener("unsafe", () => calls.push("continues"));

  assert(dispatchPath(new QuoxEvent("unsafe"), target, [], (error) => errors.push(error)));
  assertEquals(calls, ["throws", "continues"]);
  assertEquals(errors, [thrown]);
});

Deno.test("function and object listeners receive browser-compatible this values", () => {
  const target = new QuoxEventTarget();
  let functionThis: unknown;
  const objectListener = {
    receivedThis: undefined as unknown,
    handleEvent() {
      this.receivedThis = this;
    },
  };

  target.addEventListener("this", function () {
    functionThis = this;
  });
  target.addEventListener("this", objectListener);
  target.dispatchEvent(new QuoxEvent("this"));

  assertStrictEquals(functionThis, target);
  assertStrictEquals(objectListener.receivedThis, objectListener);
});

Deno.test("attribute handlers retain their listener position until cleared", () => {
  const target = new QuoxEventTarget();
  const calls: string[] = [];
  target.addEventListener("click", () => calls.push("before"));
  target[setEventHandler]("click", () => calls.push("handler one"));
  target.addEventListener("click", () => calls.push("after"));

  target.dispatchEvent(new QuoxEvent("click"));
  target[setEventHandler]("click", () => calls.push("handler two"));
  target.dispatchEvent(new QuoxEvent("click"));
  assertEquals(calls, [
    "before",
    "handler one",
    "after",
    "before",
    "handler two",
    "after",
  ]);

  target[setEventHandler]("click", null);
  assertStrictEquals(target[getEventHandler]("click"), null);
  target[setEventHandler]("click", () => calls.push("handler three"));
  target.dispatchEvent(new QuoxEvent("click"));
  assertEquals(calls.slice(-3), ["before", "after", "handler three"]);
});

Deno.test("an attribute handler returning false cancels a cancelable event", () => {
  const target = new QuoxEventTarget();
  const handler = () => false;
  target[setEventHandler]("submit", handler);

  assertStrictEquals(target[getEventHandler]("submit"), handler);
  assertFalse(target.dispatchEvent(new QuoxEvent("submit", { cancelable: true })));
});

Deno.test("invalid listeners and non-Quox events are rejected", () => {
  const target = new QuoxEventTarget();
  let calls = 0;
  const listener = () => calls++;

  assertThrows(() => target.addEventListener("bad", 1 as never), TypeError);
  assertThrows(() => target.removeEventListener("bad", false as never), TypeError);
  assertThrows(() => target.dispatchEvent(new Event("native") as never), TypeError);
  target.addEventListener("missing");
  target.removeEventListener("missing");
  assertThrows(
    () => target.addEventListener("bad-signal", listener, { signal: {} as AbortSignal }),
    TypeError,
  );
  target.dispatchEvent(new QuoxEvent("bad-signal"));
  assertEquals(calls, 0);
});
