import { assert, assertEquals, assertFalse, assertStrictEquals, assertThrows } from "@std/assert";
import { eventDispatchInternals, QuoxEvent } from "./event.ts";
import { QuoxEventTarget } from "./event_target.ts";

Deno.test("QuoxEvent exposes browser-compatible initialization state", () => {
  const event = new QuoxEvent("ready", { bubbles: true, cancelable: true, composed: true });

  assertEquals(event.type, "ready");
  assert(event.bubbles);
  assert(event.cancelable);
  assert(event.composed);
  assertFalse(event.defaultPrevented);
  assertFalse(event.isTrusted);
  assertStrictEquals(event.target, null);
  assertStrictEquals(event.srcElement, null);
  assertStrictEquals(event.currentTarget, null);
  assertEquals(event.eventPhase, QuoxEvent.NONE);
  assertEquals(event.composedPath(), []);
  assert(Number.isFinite(event.timeStamp));
  assertEquals(event.NONE, QuoxEvent.NONE);
  assertEquals(event.CAPTURING_PHASE, QuoxEvent.CAPTURING_PHASE);
  assertEquals(event.AT_TARGET, QuoxEvent.AT_TARGET);
  assertEquals(event.BUBBLING_PHASE, QuoxEvent.BUBBLING_PHASE);
});

Deno.test("event dispatch internals expose and then clear a frozen path", () => {
  const target = new QuoxEventTarget();
  const parent = new QuoxEventTarget();
  const event = new QuoxEvent("click", { cancelable: true });
  const dispatch = event[eventDispatchInternals];

  dispatch.begin(target, [target, parent], true);
  dispatch.enter(parent, QuoxEvent.CAPTURING_PHASE);

  assertStrictEquals(event.target, target);
  assertStrictEquals(event.srcElement, target);
  assertStrictEquals(event.currentTarget, parent);
  assertEquals(event.eventPhase, QuoxEvent.CAPTURING_PHASE);
  assertEquals(event.composedPath(), [target, parent]);
  assert(event.isTrusted);

  event.preventDefault();
  event.stopImmediatePropagation();
  assert(dispatch.canceled);
  assert(dispatch.propagationStopped);
  assert(dispatch.immediatePropagationStopped);
  assertFalse(dispatch.end());

  assertStrictEquals(event.target, target);
  assertStrictEquals(event.currentTarget, null);
  assertEquals(event.eventPhase, QuoxEvent.NONE);
  assertEquals(event.composedPath(), []);
  assert(event.defaultPrevented);
  assertFalse(dispatch.propagationStopped);
  assertFalse(dispatch.immediatePropagationStopped);
});

Deno.test("initEvent resets legacy initialization fields but is ignored during dispatch", () => {
  const target = new QuoxEventTarget();
  const event = new QuoxEvent("before", { composed: true });
  const dispatch = event[eventDispatchInternals];

  dispatch.begin(target, [target], true);
  event.initEvent("ignored", true, true);
  assertEquals(event.type, "before");
  assertFalse(event.bubbles);
  assertFalse(event.cancelable);
  assert(event.isTrusted);
  dispatch.end();

  event.initEvent("after", true, true);
  assertEquals(event.type, "after");
  assert(event.bubbles);
  assert(event.cancelable);
  assert(event.composed);
  assertFalse(event.isTrusted);
  assertStrictEquals(event.target, null);
});

Deno.test("the same event cannot be dispatched while it is already in flight", () => {
  const target = new QuoxEventTarget();
  const event = new QuoxEvent("nested");
  const dispatch = event[eventDispatchInternals];

  dispatch.begin(target, [target]);
  try {
    const error = assertThrows(() => target.dispatchEvent(event), DOMException);
    assertEquals(error.name, "InvalidStateError");
  } finally {
    dispatch.end();
  }
});
