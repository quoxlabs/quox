import { assert, assertEquals, assertFalse, assertStrictEquals } from "@std/assert";
import { QuoxEvent } from "./event.ts";
import { QuoxEventTarget } from "./event_target.ts";
import { QuoxFocusEvent } from "./ui_event.ts";
import { dispatchNativeWindowFocusEvent } from "./window_focus.ts";

Deno.test("native window focus transitions are trusted browser-style FocusEvents", () => {
  for (const type of ["focus", "blur"] as const) {
    const window = new QuoxEventTarget();
    let received: QuoxFocusEvent | undefined;

    window.addEventListener(type, function (event) {
      assert(event instanceof QuoxFocusEvent);
      assertStrictEquals(this, window);
      assertStrictEquals(event.target, window);
      assertStrictEquals(event.currentTarget, window);
      assertEquals(event.eventPhase, QuoxEvent.AT_TARGET);
      assertEquals(event.composedPath(), [window]);
      assert(event.isTrusted);
      assertFalse(event.bubbles);
      assertFalse(event.cancelable);
      assert(event.composed);
      assertFalse(event.defaultPrevented);
      assertStrictEquals(event.view, window);
      assertEquals(event.detail, 0);
      assertEquals(event.which, 0);
      assertStrictEquals(event.relatedTarget, null);
      event.preventDefault();
      assertFalse(event.defaultPrevented);
      received = event;
    });

    dispatchNativeWindowFocusEvent(window, type);

    assert(received instanceof QuoxFocusEvent);
    assertStrictEquals(received.currentTarget, null);
    assertEquals(received.eventPhase, QuoxEvent.NONE);
    assertEquals(received.composedPath(), []);
  }
});

Deno.test("synthetic window focus events remain untrusted", () => {
  const window = new QuoxEventTarget();
  let trusted: boolean | undefined;
  window.addEventListener("focus", (event) => trusted = event.isTrusted);

  window.dispatchEvent(new QuoxFocusEvent("focus", { composed: true, view: window }));

  assertFalse(trusted);
});
