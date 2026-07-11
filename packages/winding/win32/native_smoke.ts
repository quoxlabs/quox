import type { ImeEvent, Library, Window } from "../types.ts";
import { UNICODE_NOCHAR, WM } from "./ffi.ts";
import { load } from "./mod.ts";

// CI invokes this file explicitly on Windows. Its name intentionally avoids
// Deno's *_test.ts discovery for ordinary, platform-independent test runs.
const testUser32Functions = {
  ShowWindow: {
    parameters: ["pointer", "i32"],
    result: "i32",
  },
  SendMessageW: {
    parameters: ["pointer", "u32", "usize", "isize"],
    result: "isize",
  },
  PostMessageW: {
    parameters: ["pointer", "u32", "usize", "isize"],
    result: "i32",
  },
  DestroyWindow: {
    parameters: ["pointer"],
    result: "i32",
  },
  GetWindowRect: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
} as const satisfies Deno.ForeignLibraryInterface;

interface NativeWin32Window extends Window {
  readonly hwnd: Deno.PointerObject;
}

Deno.test({
  name: "Win32 loads native libraries and survives basic input lifecycles",
  ignore: Deno.build.os !== "windows",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const user32 = Deno.dlopen("user32", testUser32Functions);
    try {
      // A second pass verifies that close destroys the HWND and unregisters
      // the class before its callback and DLL handles are released.
      for (let iteration = 0; iteration < 2; iteration++) runLifecycle(user32, iteration === 1);
    } finally {
      user32.close();
    }
  },
});

function runLifecycle(user32: Deno.DynamicLibrary<typeof testUser32Functions>, destroyExternally: boolean): void {
  const library = load();
  try {
    assertConcurrentLibraryRejected();
    const window = library.openWindow(0, 0, 64, 48) as NativeWin32Window;
    try {
      assertWindowGeometry(user32, window, 0, 0, 64, 48);
      assertSingleInitialResize(library, window);
      // Keep hosted CI independent of foreground-window and desktop behavior.
      user32.symbols.ShowWindow(window.hwnd, 0);
      window.setImeCursorArea(4, 8, 2, 16);
      window.setImeEnabled(true);
      window.setImeEnabled(false);
      drainEvents(library);

      const probe = user32.symbols.SendMessageW(
        window.hwnd,
        WM.UNICHAR,
        BigInt(UNICODE_NOCHAR),
        0n,
      );
      if (probe !== 1n) throw new Error(`WM_UNICHAR capability probe returned ${probe}`);

      if (user32.symbols.PostMessageW(window.hwnd, WM.UNICHAR, 0x41n, 1n) === 0) {
        throw new Error("PostMessageW rejected the synthetic Unicode character");
      }

      const commit = nextImeEdit(library, window);
      if (commit?.kind !== "commit" || commit.text !== "A") {
        throw new Error("Expected a Win32 commit containing A");
      }
    } finally {
      if (destroyExternally && user32.symbols.DestroyWindow(window.hwnd) === 0) {
        throw new Error("DestroyWindow rejected the externally driven lifetime test");
      }
      // An external destroy reaches WM_NCDESTROY first; close must then be a
      // harmless no-op, and library teardown must still unregister the class.
      window.close();
    }
  } finally {
    library.close();
  }
}

function assertConcurrentLibraryRejected(): void {
  try {
    const unexpected = load();
    unexpected.close();
  } catch (error) {
    if (error instanceof Error && error.message.includes("only one library instance")) return;
    throw error;
  }
  throw new Error("A second live Win32 library was unexpectedly accepted");
}

function drainEvents(library: Library): void {
  for (let count = 0; count < 64 && library.event() !== undefined; count++);
}

function assertWindowGeometry(
  user32: Deno.DynamicLibrary<typeof testUser32Functions>,
  window: NativeWin32Window,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const rectangle = new ArrayBuffer(16);
  if (user32.symbols.GetWindowRect(window.hwnd, rectangle) === 0) {
    throw new Error("GetWindowRect rejected the Win32 geometry test");
  }
  const view = new DataView(rectangle);
  const actual = [
    view.getInt32(0, true),
    view.getInt32(4, true),
    view.getInt32(8, true) - view.getInt32(0, true),
    view.getInt32(12, true) - view.getInt32(4, true),
  ];
  const expected = [x, y, width, height];
  if (actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Expected Win32 outer geometry ${expected.join(",")}, received ${actual.join(",")}`);
  }
}

function assertSingleInitialResize(library: Library, window: Window): void {
  let resizeCount = 0;
  for (let count = 0; count < 64; count++) {
    const event = library.event();
    if (event === undefined) break;
    if (event.type === "resize" && event.window === window) resizeCount++;
  }
  if (resizeCount !== 1) throw new Error(`Expected one initial Win32 resize event, received ${resizeCount}`);
}

function nextImeEdit(library: Library, window: Window): ImeEvent | undefined {
  for (let count = 0; count < 128; count++) {
    const event = library.event();
    if (event === undefined) return undefined;
    if (
      event.type === "ime" && event.window === window &&
      (event.kind === "preedit" || event.kind === "commit")
    ) return event;
  }
  throw new Error("Win32 smoke test exceeded its event limit");
}
