import type { KeyDownEvent, Library, UIEvent, Window } from "../types.ts";
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
    drainEvents(library);

    window.setImeCursorArea(8, 12, 2, 18);
    window.setImeEnabled(true);
    focusWindow(window);
    const focus = nextEvent(library, (event) => event.type === "focus");
    if (focus?.type !== "focus" || focus.window !== window) {
      throw new Error("Expected the X11 window to receive keyboard focus");
    }
    assertImeKind(nextEvent(library, (event) => event.type === "ime"), "enabled");

    window.setImeEnabled(false);
    assertImeKind(nextEvent(library, (event) => event.type === "ime"), "disabled");

    sendKeyPress(window, "a");
    const event = nextEvent(library, (candidate) => candidate.type === "keydown");
    if (event?.type !== "keydown") throw new Error("Expected an X11 keydown event");
    assertKey(event, { code: "KeyA", key: "a", editDisposition: "text-input" });
    if (event.window !== window) throw new Error("X11 keydown was routed to the wrong window");
    const commit = nextEvent(
      library,
      (candidate) => candidate.type === "ime" && candidate.kind === "commit",
    );
    if (commit?.type !== "ime" || commit.kind !== "commit" || commit.text !== "a") {
      throw new Error("Expected an X11 IME commit for the basic keypress");
    }
  } finally {
    library.close();
  }
});

function focusWindow(window: NativeX11Window): void {
  // Xvfb runs without a window manager, so mapping a window does not give it
  // keyboard focus. IME activation is intentionally conditional on native
  // focus; establish it explicitly and let the resulting FocusIn event drive
  // the public `focus → enabled` lifecycle.
  const REVERT_TO_PARENT = 2;
  const CURRENT_TIME = 0n;
  window.lib.X11.symbols.XSetInputFocus(
    window.lib.display,
    window.id,
    REVERT_TO_PARENT,
    CURRENT_TIME,
  );
  window.lib.X11.symbols.XSync(window.lib.display, 0);
}

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
  event: KeyDownEvent,
  expected: Pick<KeyDownEvent, "code" | "key" | "editDisposition">,
): void {
  for (const field of ["code", "key", "editDisposition"] as const) {
    if (event[field] !== expected[field]) {
      throw new Error(`Expected ${field} ${expected[field]}, got ${event[field]}`);
    }
  }
}
