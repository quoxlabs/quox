import { selectBackend } from "./mod.ts";
import type { PointerCancelEvent, UIEvent, Window } from "./mod.ts";

Deno.test("backend selection recognizes both Linux Wayland launch signals", () => {
  assertEquals(selectBackend("linux", "wayland-0", undefined), "wayland");
  assertEquals(selectBackend("linux", undefined, "7"), "wayland");
  assertEquals(selectBackend("linux", "wayland-0", "7"), "wayland");
});

Deno.test("backend selection treats empty or unreadable Wayland signals as absent", () => {
  assertEquals(selectBackend("linux", "", ""), "x11");
  assertEquals(selectBackend("linux", undefined, undefined), "x11");
  assertEquals(selectBackend("linux", "", undefined), "x11");
  assertEquals(selectBackend("linux", undefined, ""), "x11");
});

Deno.test("backend selection never chooses Wayland outside Linux", () => {
  assertEquals(selectBackend("windows", "wayland-0", "7"), "win32");
  assertEquals(selectBackend("darwin", "wayland-0", "7"), "darwin");
  assertEquals(selectBackend("freebsd", "wayland-0", "7"), "x11");
});

Deno.test("public event types expose an interrupted pointer chord separately from current buttons", () => {
  const event = {
    type: "pointercancel",
    window: {} as Window,
    x: 12,
    y: 34,
    screenX: null,
    screenY: null,
    buttons: 0,
    canceledButtons: 9,
    timeStamp: 56,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    capsLock: false,
    altGraphKey: false,
    fnKey: false,
    numLock: false,
    scrollLock: false,
  } satisfies PointerCancelEvent;
  const uiEvent: UIEvent = event;

  assertEquals(uiEvent.type, "pointercancel");
  if (uiEvent.buttons !== 0 || uiEvent.canceledButtons !== 9) {
    throw new Error("pointer cancellation must preserve only the abandoned native chord");
  }
});

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
