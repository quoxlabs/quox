import { assertEquals } from "@std/assert";
import type { Window as WindingWindow } from "@quoxlabs/winding";
import { encodeKeyEvent, isFullscreenExitKey, mapWindingEvent, QuoxInputRouter } from "./input.ts";

const window = {} as WindingWindow;
const base = {
  window,
  keycode: 44,
  code: "KeyZ",
  key: "y",
  location: 0 as const,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  accelKey: false,
  capsLock: false,
  altGraphKey: false,
};

Deno.test("key adapter preserves layout-aware key and editor ownership", () => {
  const mapped = mapWindingEvent({
    ...base,
    type: "keydown",
    repeat: true,
    editDisposition: "text-input",
  });
  if (mapped.type !== "keydown") throw new TypeError("expected keydown");
  assertEquals(encodeKeyEvent(mapped), {
    code: "KeyZ",
    key: "y",
    modifierBits: 0,
    location: 0,
    eventFlags: 7,
  });
});

Deno.test("AltGraph excludes synthetic Control from the editor projection", () => {
  const mapped = mapWindingEvent({
    ...base,
    type: "keydown",
    code: "KeyQ",
    key: "@",
    ctrlKey: true,
    altKey: true,
    altGraphKey: true,
    repeat: false,
    editDisposition: "text-input",
  });
  if (mapped.type !== "keydown") throw new TypeError("expected keydown");
  assertEquals(mapped.ctrlKey, true);
  assertEquals(encodeKeyEvent(mapped).modifierBits, 18);
});

Deno.test("router preserves keydown, textinput, then keyup order", () => {
  const order: string[] = [];
  const router = new QuoxInputRouter({
    pointerMove() {},
    pointerDown() {},
    pointerUp() {},
    wheel() {},
    key: (event) => order.push(event.type),
    textInput: (event) => order.push(`text:${event.text}`),
    appleCommand() {},
    clearHover() {},
    resize() {},
    visibility() {},
    fullscreenChange() {},
    fullscreenError() {},
  });
  router.route(mapWindingEvent({ ...base, type: "keydown", repeat: false, editDisposition: "text-input" }));
  router.route(mapWindingEvent({ type: "textinput", text: "y", window }));
  router.route(mapWindingEvent({ ...base, type: "keyup", repeat: false }));
  assertEquals(order, ["keydown", "text:y", "keyup"]);
});

Deno.test("router translates browser-style wheel deltas to Blitz's scroll direction", () => {
  const calls: unknown[][] = [];
  const router = new QuoxInputRouter({
    pointerMove() {},
    pointerDown() {},
    pointerUp() {},
    wheel: (...args) => calls.push(args),
    key() {},
    textInput() {},
    appleCommand() {},
    clearHover() {},
    resize() {},
    visibility() {},
    fullscreenChange() {},
    fullscreenError() {},
  });

  router.route({ type: "mousemove", x: 12, y: 34 });
  router.route({ type: "wheel", deltaX: 2, deltaY: -3 });

  assertEquals(calls, [[12, 34, -80, 120, 0]]);
});

Deno.test("native fullscreen notifications map to typed Quox window events", () => {
  assertEquals(mapWindingEvent({ type: "fullscreenchange", fullscreen: true, window }), {
    type: "fullscreenchange",
    fullscreen: true,
  });
  assertEquals(
    mapWindingEvent({
      type: "fullscreenerror",
      requestedFullscreen: false,
      message: "denied",
      window,
    }),
    { type: "fullscreenerror", requestedFullscreen: false, message: "denied" },
  );
});

Deno.test("only unmodified Escape and F11 keydowns request fullscreen exit", () => {
  const keydown = mapWindingEvent({
    ...base,
    type: "keydown",
    key: "Escape",
    repeat: false,
    editDisposition: "platform",
  });
  if (keydown.type !== "keydown") throw new TypeError("expected keydown");
  assertEquals(isFullscreenExitKey(keydown), true);
  assertEquals(isFullscreenExitKey({ ...keydown, key: "F11" }), true);
  assertEquals(isFullscreenExitKey({ ...keydown, repeat: true }), false);
  assertEquals(isFullscreenExitKey({ ...keydown, shiftKey: true }), false);
  assertEquals(isFullscreenExitKey({ ...keydown, type: "keyup", repeat: false }), false);
});
