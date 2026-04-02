import type { Library, LoadLibrary, UIEvent, Window } from "../types.ts";

const kernel32functions = {
  GetModuleHandleW: { parameters: ["pointer"], result: "usize" },
  GetLastError: { parameters: [], result: "u32" },
  FormatMessageW: {
    parameters: ["u32", "pointer", "u32", "u32", "pointer", "u32", "pointer"],
    result: "u32",
  },
} as const;

const user32functions = {
  LoadCursorW: { parameters: ["pointer", "usize"], result: "usize" },
  RegisterClassExW: {
    parameters: ["buffer"],
    result: "u16",
  },
  CreateWindowExW: {
    parameters: [
      "u32",
      "buffer",
      "buffer",
      "u32",
      "u32",
      "u32",
      "u32",
      "u32",
      "pointer",
      "pointer",
      "pointer",
      "usize",
    ],
    result: "pointer",
  },
  PeekMessageW: {
    parameters: ["pointer", "pointer", "u32", "u32", "u32"],
    result: "bool",
    callback: true,
  },
  TranslateMessage: { parameters: ["pointer"], result: "bool" },
  DispatchMessageW: {
    parameters: ["pointer"],
    result: "usize",
    callback: true,
  },
  DefWindowProcW: {
    parameters: ["pointer", "u32", "usize", "usize"],
    result: "usize",
    callback: true,
  },
} as const;

class Win32Window implements Window {
  readonly id: bigint;
  constructor(readonly lib: Win32Library, classNameBuf: ArrayBuffer) {
    const window = lib.user32.symbols.CreateWindowExW(
      0,
      classNameBuf,
      null,
      0x10CF0000,
      0x80000000,
      0x80000000,
      0x80000000,
      0x80000000,
      null,
      null,
      null,
      0n,
    );
    if (window == null) throw new Error(lib.getLastError());
    this.id = BigInt(Deno.UnsafePointer.value(window));
    lib.windows.set(this.id, this);
  }
  blit(_rgba: Uint8Array, _width: number, _height: number): void {
    // TODO: implement pixel blitting for Win32
  }
  [Symbol.dispose]() {
    this.close();
  }
  close(): void {
    this.lib.windows.delete(this.id);
  }
}

class Win32Library implements Library {
  readonly kernel32: Deno.DynamicLibrary<typeof kernel32functions>;
  readonly user32: Deno.DynamicLibrary<typeof user32functions>;
  #wndClass = new ArrayBuffer(80);
  #classNameBuffer = (() => {
    const name = "Winding";
    const classNameBuffer = new ArrayBuffer((name.length + 1) * 2);
    const classNameU16 = new Uint16Array(classNameBuffer);
    for (let i = 0; i < name.length; i++) {
      classNameU16[i] = name.charCodeAt(i);
    }
    classNameU16[name.length] = 0;
    return classNameBuffer;
  })();
  #wndProc: Deno.UnsafeCallback<{
    parameters: ["pointer", "u32", "usize", "usize"];
    result: "usize";
  }>;
  #event: UIEvent | undefined;
  constructor() {
    this.kernel32 = Deno.dlopen("kernel32", kernel32functions);
    this.user32 = Deno.dlopen("user32", user32functions);

    const wndClassDv = new DataView(this.#wndClass);
    let off = 0;

    // cbSize
    wndClassDv.setUint32(off, this.#wndClass.byteLength, true);
    off += 4;

    // style
    wndClassDv.setUint32(off, 0x1 | 0x2 | 0x20, true);
    off += 4;

    // lpfnWndProc
    this.#wndProc = new Deno.UnsafeCallback({
      parameters: ["pointer", "u32", "usize", "usize"],
      result: "usize",
    }, (hWnd, uMsg, wParam, lParam) => {
      const win = this.windows.get(BigInt(Deno.UnsafePointer.value(hWnd)));
      switch (uMsg) {
        case 0x0005: { // WM_SIZE
          const w = Number(BigInt(lParam) & 0xFFFFn);
          const h = Number((BigInt(lParam) >> 16n) & 0xFFFFn);
          if (w > 0 && h > 0) {
            this.#event = { type: "resize", width: w, height: h, window: win };
          }
          break;
        }
        case 0x0010: // WM_CLOSE
          this.#event = { type: "close", window: win };
          // Return without calling DefWindowProcW to prevent immediate window
          // destruction; let the application decide when to tear down.
          return 0n;
        case 0x200: { // WM_MOUSEMOVE
          this.#event = {
            type: "mousemove",
            x: Number(BigInt(lParam) & 0xFFFFn),
            y: Number((BigInt(lParam) >> 16n) & 0xFFFFn),
            window: win,
          };
          break;
        }
      }
      return this.user32.symbols.DefWindowProcW(hWnd, uMsg, wParam, lParam);
    });
    wndClassDv.setBigUint64(
      off,
      BigInt(Deno.UnsafePointer.value(this.#wndProc.pointer)),
      true,
    );
    off += 8;

    // cbClsExtra
    off += 4;

    // cbWndExtra
    off += 4;

    // hInstance
    const instance = this.kernel32.symbols.GetModuleHandleW(null);
    if (BigInt(instance) == 0n) throw new Error(this.getLastError());
    wndClassDv.setBigUint64(off, BigInt(instance), true);
    off += 8;

    // hIcon
    off += 8;

    // hCursor
    const cursor = this.user32.symbols.LoadCursorW(null, 32512n);
    // (IDC_ARROW - https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors)
    if (BigInt(cursor) === 0n) throw new Error(this.getLastError());
    wndClassDv.setBigUint64(off, BigInt(cursor), true);
    off += 8;

    // hbrBackground
    off += 8;

    // lpszMenuName
    off += 8;

    // lpszClassName
    wndClassDv.setBigUint64(
      off,
      BigInt(Deno.UnsafePointer.value(
        Deno.UnsafePointer.of(this.#classNameBuffer),
      )),
      true,
    );
    off += 8;

    // hIconSm
    off += 8;

    if (off !== this.#wndClass.byteLength) {
      throw new Error("Bug: mismatched offset with expected WNDCLASS size");
    }

    const wndClass = this.user32.symbols.RegisterClassExW(this.#wndClass);
    if (wndClass == 0) throw new Error(this.getLastError());
  }
  readonly windows = new Map<bigint, Win32Window>();
  openWindow(_x = 0, _y = 0, _w = 800, _h = 600): Win32Window {
    return new Win32Window(this, this.#classNameBuffer);
  }
  #msg = new ArrayBuffer(48);
  event(): UIEvent | undefined {
    const ptr = Deno.UnsafePointer.of(this.#msg);
    if (this.user32.symbols.PeekMessageW(ptr, null, 0, 0, 1)) {
      this.user32.symbols.TranslateMessage(
        Deno.UnsafePointer.of(this.#msg),
      );
      this.user32.symbols.DispatchMessageW(
        Deno.UnsafePointer.of(this.#msg),
      );
    }
    const event = this.#event;
    if (event !== undefined) this.#event = undefined;
    return event;
  }
  #lastErrorBuffer = new ArrayBuffer(4096);
  getLastError() {
    const code = this.kernel32.symbols.GetLastError();
    const bufU16 = new Uint16Array(this.#lastErrorBuffer);
    const bytesWritten = this.kernel32.symbols.FormatMessageW(
      0x1000,
      null,
      code,
      0,
      Deno.UnsafePointer.of(this.#lastErrorBuffer),
      this.#lastErrorBuffer.byteLength / 2,
      null,
    );
    if (bytesWritten == 0) {
      throw new Error(
        "Failed to get error information for error code: " + code,
      );
    }
    let s = "";
    for (let i = 0; i < bytesWritten; i++) {
      s += String.fromCharCode(bufU16[i]);
    }
    return s.trim() + " (" + code + ")";
  }
  [Symbol.dispose]() {
    this.close();
  }
  close(): void {
    this.#wndProc.close();
    this.user32.close();
    this.kernel32.close();
  }
}

export const load: LoadLibrary = () => new Win32Library();
