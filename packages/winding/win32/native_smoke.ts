import type { Library, TextInputEvent, Window } from "../types.ts";
import { UNICODE_NOCHAR, WM } from "./ffi.ts";
import { load } from "./mod.ts";

// CI invokes this file explicitly on Windows. Its name intentionally avoids
// Deno's *_test.ts discovery for ordinary, platform-independent test runs.
const testUser32Functions = {
  ShowWindow: {
    parameters: ["pointer", "i32"],
    result: "bool",
  },
  SendMessageW: {
    parameters: ["pointer", "u32", "usize", "isize"],
    result: "isize",
  },
  PostMessageW: {
    parameters: ["pointer", "u32", "usize", "isize"],
    result: "bool",
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
      for (let iteration = 0; iteration < 2; iteration++) runLifecycle(user32);
    } finally {
      user32.close();
    }
  },
});

function runLifecycle(user32: Deno.DynamicLibrary<typeof testUser32Functions>): void {
  const library = load();
  try {
    const window = library.openWindow(0, 0, 64, 48) as NativeWin32Window;
    try {
      // Keep hosted CI independent of foreground-window and desktop behavior.
      user32.symbols.ShowWindow(window.hwnd, 0);
      drainEvents(library);

      const probe = user32.symbols.SendMessageW(
        window.hwnd,
        WM.UNICHAR,
        BigInt(UNICODE_NOCHAR),
        0n,
      );
      if (probe !== 1n) throw new Error(`WM_UNICHAR capability probe returned ${probe}`);

      if (!user32.symbols.PostMessageW(window.hwnd, WM.UNICHAR, 0x41n, 1n)) {
        throw new Error("PostMessageW rejected the synthetic Unicode character");
      }

      const commit = nextTextInput(library, window);
      if (commit?.text !== "A") {
        throw new Error("Expected Win32 committed text containing A");
      }
    } finally {
      window.close();
    }
  } finally {
    library.close();
  }
}

function drainEvents(library: Library): void {
  for (let count = 0; count < 64 && library.event() !== undefined; count++);
}

function nextTextInput(library: Library, window: Window): TextInputEvent | undefined {
  for (let count = 0; count < 128; count++) {
    const event = library.event();
    if (event === undefined) return undefined;
    if (
      event.type === "textinput" && event.window === window
    ) return event;
  }
  throw new Error("Win32 smoke test exceeded its event limit");
}
