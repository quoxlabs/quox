import type { KeyModifiers, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { getDomCode } from "./dom_code.ts";
import { gdi32functions, kernel32functions, user32functions, WHEEL_DELTA, WM } from "./ffi.ts";

// BITMAPINFOHEADER is 40 bytes; for 32bpp BI_RGB no color table follows, so
// this buffer alone is a valid BITMAPINFO for SetDIBitsToDevice.
const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

const DOWN_BUTTON: Partial<Record<WM, "left" | "middle" | "right">> = {
  [WM.LBUTTONDOWN]: "left",
  [WM.MBUTTONDOWN]: "middle",
  [WM.RBUTTONDOWN]: "right",
};
const UP_BUTTON: Partial<Record<WM, "left" | "middle" | "right">> = {
  [WM.LBUTTONUP]: "left",
  [WM.MBUTTONUP]: "middle",
  [WM.RBUTTONUP]: "right",
};

function wideStringBuffer(value: string): ArrayBuffer {
  const buffer = new ArrayBuffer((value.length + 1) * 2);
  const view = new Uint16Array(buffer);
  for (let i = 0; i < value.length; i++) view[i] = value.charCodeAt(i);
  view[value.length] = 0;
  return buffer;
}

function isKeyDown(lib: Win32Library, virtualKey: number): boolean {
  return (lib.user32.symbols.GetKeyState(virtualKey) & 0x8000) !== 0;
}

function getModifiers(lib: Win32Library): KeyModifiers {
  const ctrlKey = isKeyDown(lib, VK_CONTROL);
  return {
    shiftKey: isKeyDown(lib, VK_SHIFT),
    ctrlKey,
    altKey: isKeyDown(lib, VK_MENU),
    metaKey: isKeyDown(lib, VK_LWIN) || isKeyDown(lib, VK_RWIN),
    accelKey: ctrlKey,
  };
}

class Win32Window implements Window {
  readonly id: bigint;
  readonly #hwnd: Deno.PointerObject;
  #bgra = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  #bmi = new ArrayBuffer(BITMAPINFOHEADER_SIZE);

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
    this.#hwnd = window;
    this.id = BigInt(Deno.UnsafePointer.value(window));
    lib.windows.set(this.id, this);
  }

  setTitle(title: string): void {
    const ok = this.lib.user32.symbols.SetWindowTextW(this.#hwnd, wideStringBuffer(title));
    if (!ok) throw new Error(this.lib.getLastError());
  }

  /**
   * Copy an RGBA pixel buffer to the window's client area via GDI. Converts
   * to a top-down 32bpp BGRA DIB (matching the BGRX reordering used by the
   * X11 backend) and blits it with `SetDIBitsToDevice`.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    const byteLength = width * height * 4;
    if (this.#bgra.byteLength !== byteLength) {
      this.#bgra = new Uint8Array(byteLength) as Uint8Array<ArrayBuffer>;
    }
    const bgra = this.#bgra;
    for (let i = 0; i < rgba.length; i += 4) {
      bgra[i] = rgba[i + 2]; // B ← R
      bgra[i + 1] = rgba[i + 1]; // G
      bgra[i + 2] = rgba[i]; // R ← B
      bgra[i + 3] = rgba[i + 3]; // A
    }

    const dv = new DataView(this.#bmi);
    dv.setUint32(0, BITMAPINFOHEADER_SIZE, true); // biSize
    dv.setInt32(4, width, true); // biWidth
    dv.setInt32(8, -height, true); // biHeight (negative = top-down)
    dv.setUint16(12, 1, true); // biPlanes
    dv.setUint16(14, 32, true); // biBitCount
    dv.setUint32(16, BI_RGB, true); // biCompression
    dv.setUint32(20, byteLength, true); // biSizeImage
    dv.setInt32(24, 0, true); // biXPelsPerMeter
    dv.setInt32(28, 0, true); // biYPelsPerMeter
    dv.setUint32(32, 0, true); // biClrUsed
    dv.setUint32(36, 0, true); // biClrImportant

    const hdc = this.lib.user32.symbols.GetDC(this.#hwnd);
    if (hdc == null) throw new Error(this.lib.getLastError());
    try {
      this.lib.gdi32.symbols.SetDIBitsToDevice(
        hdc,
        0,
        0,
        width,
        height,
        0,
        0,
        0,
        height,
        bgra,
        this.#bmi,
        DIB_RGB_COLORS,
      );
    } finally {
      this.lib.user32.symbols.ReleaseDC(this.#hwnd, hdc);
    }
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
  readonly gdi32: Deno.DynamicLibrary<typeof gdi32functions>;
  #wndClass = new ArrayBuffer(80);
  #classNameBuffer = (() => {
    return wideStringBuffer("Winding");
  })();
  #wndProc: Deno.UnsafeCallback<{
    parameters: ["pointer", "u32", "usize", "usize"];
    result: "usize";
  }>;
  #event: UIEvent | undefined;
  // Tracks how many mouse buttons are currently held, so capture is only
  // released once the last button of a (possibly multi-button) drag is
  // released rather than on every individual button-up.
  #captureCount = 0;
  constructor() {
    this.kernel32 = Deno.dlopen("kernel32", kernel32functions);
    this.user32 = Deno.dlopen("user32", user32functions);
    this.gdi32 = Deno.dlopen("gdi32", gdi32functions);

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
        case WM.SIZE: {
          const w = Number(BigInt(lParam) & 0xFFFFn);
          const h = Number((BigInt(lParam) >> 16n) & 0xFFFFn);
          if (w > 0 && h > 0) {
            this.#event = { type: "resize", width: w, height: h, window: win };
          }
          break;
        }
        case WM.CLOSE:
          this.#event = { type: "close", window: win };
          // Return without calling DefWindowProcW to prevent immediate window
          // destruction; let the application decide when to tear down.
          return 0n;
        case WM.MOUSEMOVE: {
          this.#event = {
            type: "mousemove",
            x: Number(BigInt(lParam) & 0xFFFFn),
            y: Number((BigInt(lParam) >> 16n) & 0xFFFFn),
            window: win,
          };
          break;
        }
        case WM.LBUTTONDOWN:
        case WM.MBUTTONDOWN:
        case WM.RBUTTONDOWN: {
          // Capture the mouse so drags that leave the client area (e.g.
          // dragging a scrollbar thumb) still deliver the eventual button-up,
          // matching X11's implicit passive grab on button press.
          if (this.#captureCount++ === 0) this.user32.symbols.SetCapture(hWnd);
          this.#event = { type: "mousedown", button: DOWN_BUTTON[uMsg as WM]!, window: win };
          break;
        }
        case WM.LBUTTONUP:
        case WM.MBUTTONUP:
        case WM.RBUTTONUP: {
          if (this.#captureCount > 0 && --this.#captureCount === 0) {
            this.user32.symbols.ReleaseCapture();
          }
          this.#event = { type: "mouseup", button: UP_BUTTON[uMsg as WM]!, window: win };
          break;
        }
        case WM.MOUSEWHEEL:
        case WM.MOUSEHWHEEL: {
          // wParam's high word is a *signed* 16-bit tilt/rotation amount, in
          // multiples of WHEEL_DELTA per notch (unlike the unsigned x/y words
          // read elsewhere in this file).
          const raw = Number((BigInt(wParam) >> 16n) & 0xFFFFn);
          const signed = raw > 0x7FFF ? raw - 0x10000 : raw;
          const notches = signed / WHEEL_DELTA;
          this.#event = uMsg === WM.MOUSEWHEEL
            // Win32 reports a positive vertical delta for "rotated away from
            // the user" (scroll up); every other winding backend uses the
            // opposite convention (positive deltaY = scroll down), so flip it.
            ? { type: "wheel", deltaX: 0, deltaY: -notches, window: win }
            // Horizontal tilt-right is already positive in both Win32 and the
            // other backends (see Wayland's unflipped axis===1 handling), so
            // no sign flip is needed here.
            : { type: "wheel", deltaX: notches, deltaY: 0, window: win };
          break;
        }
        case WM.KEYDOWN:
        // Alt-held key combinations arrive as WM_SYSKEYDOWN instead of
        // WM_KEYDOWN; fold them into the same "keydown" event since winding
        // has no separate "system key" event type. DefWindowProcW still runs
        // below, so system behaviors (Alt+F4, the system menu, ...) keep working.
        case WM.SYSKEYDOWN:
          this.#event = {
            type: "keydown",
            keycode: Number(wParam),
            code: getDomCode(lParam),
            ...getModifiers(this),
            window: win,
          };
          break;
        case WM.KEYUP:
        case WM.SYSKEYUP:
          this.#event = {
            type: "keyup",
            keycode: Number(wParam),
            code: getDomCode(lParam),
            ...getModifiers(this),
            window: win,
          };
          break;
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
    this.gdi32.close();
    this.user32.close();
    this.kernel32.close();
  }
}

export const load: LoadLibrary = () => new Win32Library();
