import type { KeyEvent, Library, UIEvent, Window } from "../types.ts";
import { utf8CString as cString } from "../text_encoding.ts";
import { x11functions, XEventMask, XEventType } from "./ffi.ts";
import { load } from "./mod.ts";

// CI invokes this file explicitly under Xvfb. Its name intentionally avoids
// Deno's *_test.ts discovery for ordinary, display-independent test runs.
interface NativeX11Window extends Window {
  readonly id: bigint;
  readonly lib: {
    readonly display: Deno.PointerObject;
    readonly X11: Deno.DynamicLibrary<typeof x11functions>;
  };
}

Deno.test("X11 opens a window, configures XIM, and translates a basic keypress", () => {
  const library = load();
  try {
    const window = library.openWindow(0, 0, 64, 64) as NativeX11Window;
    if (window.setImeCursorArea === undefined || window.setImeEnabled === undefined) {
      throw new Error("X11 IME hooks are unavailable");
    }
    drainEvents(library);

    window.setImeCursorArea(8, 12, 2, 18);
    window.setImeEnabled(true);
    assertImeKind(nextEvent(library, (event) => event.type === "ime"), "enabled");

    window.setImeEnabled(false);
    assertImeKind(nextEvent(library, (event) => event.type === "ime"), "disabled");

    sendKeyPress(window, "a");
    const event = nextEvent(library, (candidate) => candidate.type === "keydown");
    if (event?.type !== "keydown") throw new Error("Expected an X11 keydown event");
    assertKey(event, { code: "KeyA", key: "a", text: "a" });
    if (event.window !== window) throw new Error("X11 keydown was routed to the wrong window");
  } finally {
    library.close();
  }
});

function drainEvents(library: Library): void {
  for (let count = 0; count < 64 && library.event() !== undefined; count++);
}

function nextEvent(
  library: Library,
  predicate: (event: UIEvent) => boolean,
): UIEvent | undefined {
  for (let count = 0; count < 64; count++) {
    const event = library.event();
    if (event === undefined) return undefined;
    if (predicate(event)) return event;
  }
  throw new Error("X11 smoke test exceeded its event limit");
}

function sendKeyPress(window: NativeX11Window, name: string): void {
  const { display, X11 } = window.lib;
  const keysym = X11.symbols.XStringToKeysym(cString(name));
  const keycode = X11.symbols.XKeysymToKeycode(display, keysym);
  if (keycode === 0) throw new Error(`X11 has no keycode for ${name}`);

  // XKeyEvent is 96 bytes on the LP64 ABI supported by this backend. Keep an
  // XEvent-sized buffer because XSendEvent accepts the enclosing union.
  const buffer = new ArrayBuffer(192);
  const event = new DataView(buffer);
  event.setInt32(0, XEventType.KeyPress, true);
  event.setInt32(16, 1, true);
  event.setBigUint64(24, Deno.UnsafePointer.value(display), true);
  event.setBigUint64(32, window.id, true);
  event.setUint32(84, keycode, true);
  event.setInt32(88, 1, true);

  const accepted = X11.symbols.XSendEvent(
    display,
    window.id,
    0,
    BigInt(XEventMask.KeyPressMask),
    Deno.UnsafePointer.of(buffer),
  );
  if (accepted === 0) throw new Error("XSendEvent rejected the synthetic keypress");
  X11.symbols.XSync(display, 0);
}

function assertImeKind(event: UIEvent | undefined, expected: "enabled" | "disabled"): void {
  if (event?.type === "ime" && event.kind === expected) return;
  const actual = event?.type === "ime" ? event.kind : event?.type ?? "no event";
  throw new Error(`Expected IME ${expected}, got ${actual}`);
}

function assertKey(
  event: KeyEvent,
  expected: Pick<KeyEvent, "code" | "key" | "text">,
): void {
  for (const field of ["code", "key", "text"] as const) {
    if (event[field] !== expected[field]) {
      throw new Error(`Expected ${field} ${expected[field]}, got ${event[field]}`);
    }
  }
}
