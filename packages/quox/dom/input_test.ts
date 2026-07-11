import { assertEquals } from "@std/assert";
import type { Window as WindingWindow } from "@quoxlabs/winding";
import {
  applyImeRequestSnapshot,
  encodeKeyEvent,
  mapWindingEvent,
  notifyInputListeners,
  type QuoxInputEvent,
  QuoxInputRouter,
} from "./input.ts";

class FakeWindow implements WindingWindow {
  readonly calls: Array<[string, ...number[]]> = [];

  [Symbol.dispose](): void {}
  close(): void {}
  setTitle(_title: string): void {}
  blit(_rgba: Uint8Array, _width: number, _height: number): void {}
  setImeEnabled(enabled: boolean): void {
    this.calls.push(["enabled", Number(enabled)]);
  }
  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.calls.push(["area", x, y, width, height]);
  }
}

const window = new FakeWindow();
const pointer = {
  x: 7,
  y: 9,
  buttons: 5,
  timeStamp: 12,
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: true,
};

Deno.test("wheel adapter preserves browser units and translates Blitz scroll direction", () => {
  const calls: number[][] = [];
  const router = new QuoxInputRouter(
    {
      pointerMove() {},
      pointerDown() {},
      pointerUp() {},
      wheel: (...values) => calls.push(values),
      key() {},
      ime() {},
      appleCommand() {},
      clearHover() {},
      resize() {},
      visibility() {},
    },
    800,
    600,
  );

  const precise = mapWindingEvent({
    type: "wheel",
    window,
    deltaX: 2.25,
    deltaY: -3.5,
    deltaMode: 0,
    ...pointer,
  });
  assertEquals(precise, {
    type: "wheel",
    deltaX: 2.25,
    deltaY: -3.5,
    deltaMode: 0,
    ...pointer,
  });
  router.route(precise);
  router.route({ type: "wheel", deltaX: 1, deltaY: -2, deltaMode: 1, ...pointer });
  router.route({ type: "wheel", deltaX: 0.5, deltaY: -1, deltaMode: 2, ...pointer });

  assertEquals(calls, [
    [7, 9, -2.25, 3.5, 5, 9],
    [7, 9, -40, 80, 5, 9],
    [7, 9, -400, 600, 5, 9],
  ]);
});

Deno.test("resize adapter preserves logical and framebuffer dimensions", () => {
  assertEquals(
    mapWindingEvent({
      type: "resize",
      width: 800,
      height: 600,
      framebufferWidth: 1600,
      framebufferHeight: 1200,
      devicePixelRatio: 2,
      frameToken: 7,
      window,
    }),
    {
      type: "resize",
      width: 800,
      height: 600,
      framebufferWidth: 1600,
      framebufferHeight: 1200,
      devicePixelRatio: 2,
      frameToken: 7,
    },
  );
});

Deno.test("canonical key adapter preserves public fields and encodes editor policy", () => {
  const mapped = mapWindingEvent({
    type: "keydown",
    window,
    keycode: 44,
    code: "KeyZ",
    key: "y",
    location: 0,
    repeat: true,
    isComposing: true,
    editDisposition: "text-input",
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: true,
    accelKey: true,
    capsLock: false,
    altGraphKey: false,
  });

  if (mapped.type !== "keydown") throw new TypeError("expected keydown");
  assertEquals(mapped.key, "y");
  assertEquals(mapped.editDisposition, "text-input");
  assertEquals(encodeKeyEvent(mapped), {
    code: "KeyZ",
    key: "y",
    // Shift | Meta | runtime accelerator.
    modifierBits: 37,
    location: 0,
    // Pressed | Repeat | Composing | PreventDefault.
    eventFlags: 15,
  });
});

Deno.test("AltGraph preserves raw Ctrl publicly but omits it from the editor projection", () => {
  const mapped = mapWindingEvent({
    type: "keydown",
    window,
    keycode: 16,
    code: "KeyQ",
    key: "@",
    location: 0,
    repeat: false,
    isComposing: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: true,
    altKey: true,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: true,
  });

  if (mapped.type !== "keydown") throw new TypeError("expected keydown");
  const encoded = encodeKeyEvent(mapped);
  assertEquals(mapped.ctrlKey, true);
  assertEquals(encoded.modifierBits, 18); // Alt | AltGraph
  assertEquals(encoded.eventFlags, 9); // Pressed | PreventDefault
});

Deno.test("only key-default disposition keeps the Blitz editor default", () => {
  const base = {
    type: "keydown" as const,
    window,
    keycode: 37,
    code: "ArrowLeft",
    key: "ArrowLeft",
    location: 0 as const,
    repeat: false,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };

  const keyDefault = mapWindingEvent({ ...base, editDisposition: "key-default" });
  const platform = mapWindingEvent({ ...base, editDisposition: "platform" });
  if (keyDefault.type !== "keydown" || platform.type !== "keydown") {
    throw new TypeError("expected keydowns");
  }
  assertEquals(encodeKeyEvent(keyDefault).eventFlags, 1); // Pressed
  assertEquals(encodeKeyEvent(platform).eventFlags, 9); // Pressed | PreventDefault
});

Deno.test("keyup has no text or default-cancellation policy", () => {
  const mapped = mapWindingEvent({
    type: "keyup",
    window,
    keycode: 30,
    code: "KeyA",
    key: "a",
    location: 0,
    repeat: false,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });

  if (mapped.type !== "keyup") throw new TypeError("expected keyup");
  assertEquals(encodeKeyEvent(mapped).eventFlags, 0);
  assertEquals("text" in mapped, false);
});

Deno.test("IME adapter preserves nullable UTF-8 ranges and byte-counted edits", () => {
  assertEquals(
    mapWindingEvent({
      type: "ime",
      kind: "preedit",
      window,
      text: "日本",
      cursorRange: null,
    }),
    { type: "ime", kind: "preedit", text: "日本", cursorRange: null },
  );
  assertEquals(
    mapWindingEvent({
      type: "ime",
      kind: "deleteSurrounding",
      window,
      beforeBytes: 4,
      afterBytes: 2,
    }),
    { type: "ime", kind: "deleteSurrounding", beforeBytes: 4, afterBytes: 2 },
  );
  assertEquals(
    mapWindingEvent({
      type: "ime",
      kind: "replace",
      window,
      startBytes: 1,
      endBytes: 5,
      text: "x",
    }),
    { type: "ime", kind: "replace", startBytes: 1, endBytes: 5, text: "x" },
  );
});

Deno.test("listener errors are reported without preventing later observers", () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const event: QuoxInputEvent = { type: "focus" };

  notifyInputListeners(
    [
      () => {
        calls.push("first");
        throw new Error("listener failed");
      },
      () => calls.push("second"),
    ],
    event,
    (error) => errors.push(error),
  );

  assertEquals(calls, ["first", "second"]);
  assertEquals(errors.length, 1);
});

Deno.test("atomic IME snapshot applies cursor geometry before enable", () => {
  const target = new FakeWindow();
  applyImeRequestSnapshot(target, new Float64Array([1, 3, 1, 2, 3, 4, 1]));
  assertEquals(target.calls, [
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
  ]);
});

Deno.test("pure router preserves key listener then commit and DOM-input ordering", () => {
  const order: string[] = [];
  const router = new QuoxInputRouter({
    pointerMove() {},
    pointerDown() {},
    pointerUp() {},
    wheel() {},
    key: () => order.push("keydown-dispatch"),
    ime: (event) => {
      if (event.kind === "commit") order.push("commit-dispatch", "dom-input");
    },
    appleCommand() {},
    clearHover() {},
    resize() {},
    visibility() {},
  });
  const key = mapWindingEvent({
    type: "keydown",
    window,
    keycode: 30,
    code: "KeyA",
    key: "a",
    location: 0,
    repeat: false,
    isComposing: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });
  const commit = mapWindingEvent({ type: "ime", kind: "commit", text: "a", window });

  router.route(key);
  order.push("keydown-listener");
  router.route(commit);
  order.push("commit-listener");

  assertEquals(order, [
    "keydown-dispatch",
    "keydown-listener",
    "commit-dispatch",
    "dom-input",
    "commit-listener",
  ]);
});
