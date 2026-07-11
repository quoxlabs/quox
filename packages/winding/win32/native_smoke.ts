import type { ImeEvent, Library, Window } from "../types.ts";
import { PM_REMOVE, UNICODE_NOCHAR, WM } from "./ffi.ts";
import { decodeWin32QueuedMessage, win32QuitExitCode } from "./input.ts";
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
  PeekMessageW: {
    parameters: ["pointer", "pointer", "u32", "u32", "u32"],
    result: "i32",
  },
  PostQuitMessage: {
    parameters: ["i32"],
    result: "void",
  },
  DestroyWindow: {
    parameters: ["pointer"],
    result: "i32",
  },
  GetWindowRect: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  InvalidateRect: {
    parameters: ["pointer", "pointer", "i32"],
    result: "i32",
  },
  UpdateWindow: {
    parameters: ["pointer"],
    result: "i32",
  },
  GetDC: {
    parameters: ["pointer"],
    result: "pointer",
  },
  ReleaseDC: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
} as const satisfies Deno.ForeignLibraryInterface;

const testGdi32Functions = {
  GetPixel: {
    parameters: ["pointer", "i32", "i32"],
    result: "u32",
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
      const gdi32 = Deno.dlopen("gdi32", testGdi32Functions);
      try {
        // A second pass verifies that close destroys the HWND and unregisters
        // the class before its callback and DLL handles are released.
        for (let iteration = 0; iteration < 2; iteration++) runLifecycle(user32, gdi32, iteration === 1);
      } finally {
        gdi32.close();
      }
    } finally {
      user32.close();
    }
  },
});

function runLifecycle(
  user32: Deno.DynamicLibrary<typeof testUser32Functions>,
  gdi32: Deno.DynamicLibrary<typeof testGdi32Functions>,
  destroyExternally: boolean,
): void {
  const library = load();
  try {
    assertConcurrentLibraryRejected();
    const window = library.openWindow(0, 0, 320, 240) as NativeWin32Window;
    try {
      assertWindowGeometry(user32, window, 0, 0, 320, 240);
      const size = assertSingleInitialResize(library, window);
      assertRepaintPixel(user32, gdi32, window, 0x000000);
      const rgba = new Uint8Array(size.width * size.height * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) {
        rgba[offset] = 0x12;
        rgba[offset + 1] = 0x34;
        rgba[offset + 2] = 0x56;
        rgba[offset + 3] = 0xff;
      }
      window.blit(rgba, size.width, size.height);
      assertRepaintPixel(user32, gdi32, window, 0x563412);
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

      assertThreadQueuePreservation(user32, library, window);
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

function assertThreadQueuePreservation(
  user32: Deno.DynamicLibrary<typeof testUser32Functions>,
  library: Library,
  window: NativeWin32Window,
): void {
  const customMessage = 0x8007; // WM_APP + 7
  const customWParam = 0x1234abcden;
  const customLParam = -77n;
  const messageBuffer = new ArrayBuffer(48);
  const messagePointer = Deno.UnsafePointer.of(messageBuffer);
  drainEvents(library);

  if (user32.symbols.PostMessageW(null, customMessage, customWParam, customLParam) === 0) {
    throw new Error("PostMessageW rejected the custom thread message");
  }
  if (user32.symbols.PostMessageW(window.hwnd, WM.UNICHAR, 0x42n, 1n) === 0) {
    throw new Error("PostMessageW rejected the queued Winding message");
  }
  if (library.event() !== undefined) {
    throw new Error("Winding crossed a host-owned thread-message queue boundary");
  }

  if (user32.symbols.PeekMessageW(messagePointer, null, 0, 0, PM_REMOVE) === 0) {
    throw new Error("Winding swallowed the custom thread message");
  }
  const custom = decodeWin32QueuedMessage(messageBuffer);
  if (
    custom.windowId !== 0n || custom.message !== customMessage ||
    custom.wParam !== customWParam || custom.lParam !== customLParam
  ) {
    throw new Error("Winding changed or reordered the custom thread message");
  }

  const commit = nextImeEdit(library, window);
  if (commit?.kind !== "commit" || commit.text !== "B") {
    throw new Error("Winding did not resume pumping its HWND after the host message");
  }
  drainEvents(library);

  const exitCode = -123;
  user32.symbols.PostQuitMessage(exitCode);
  if (library.event() !== undefined) throw new Error("Winding surfaced an event after WM_QUIT");
  if (user32.symbols.PeekMessageW(messagePointer, null, 0, 0, PM_REMOVE) === 0) {
    throw new Error("Winding swallowed WM_QUIT");
  }
  const quit = decodeWin32QueuedMessage(messageBuffer);
  if (quit.windowId !== 0n || quit.message !== WM.QUIT || win32QuitExitCode(quit.wParam) !== exitCode) {
    throw new Error("Winding did not preserve WM_QUIT and its exit code");
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

function assertSingleInitialResize(library: Library, window: Window): { width: number; height: number } {
  let resizeCount = 0;
  let size: { width: number; height: number } | undefined;
  for (let count = 0; count < 64; count++) {
    const event = library.event();
    if (event === undefined) break;
    if (event.type === "resize" && event.window === window) {
      resizeCount++;
      size = { width: event.width, height: event.height };
    }
  }
  if (resizeCount !== 1) throw new Error(`Expected one initial Win32 resize event, received ${resizeCount}`);
  if (size === undefined || size.width <= 0 || size.height <= 0) {
    throw new Error("Expected positive initial Win32 client dimensions");
  }
  return size;
}

function assertRepaintPixel(
  user32: Deno.DynamicLibrary<typeof testUser32Functions>,
  gdi32: Deno.DynamicLibrary<typeof testGdi32Functions>,
  window: NativeWin32Window,
  expected: number,
): void {
  if (user32.symbols.InvalidateRect(window.hwnd, null, 0) === 0) {
    throw new Error("InvalidateRect rejected the Win32 repaint test");
  }
  if (user32.symbols.UpdateWindow(window.hwnd) === 0) {
    throw new Error("UpdateWindow did not dispatch the Win32 repaint test");
  }
  const hdc = user32.symbols.GetDC(window.hwnd);
  if (hdc === null) throw new Error("GetDC rejected the Win32 repaint test");
  try {
    const actual = gdi32.symbols.GetPixel(hdc, 0, 0);
    if (actual !== expected) {
      throw new Error(`Expected Win32 repaint pixel ${expected.toString(16)}, received ${actual.toString(16)}`);
    }
  } finally {
    user32.symbols.ReleaseDC(window.hwnd, hdc);
  }
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
