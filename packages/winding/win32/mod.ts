import type { Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { DeferredNativeError, guardNativeCallback } from "../input/callback.ts";
import { EventQueue } from "../input/event_queue.ts";
import { kernel32functions, PM_REMOVE, SIZE_MINIMIZED, user32functions, WHEEL_DELTA, WM } from "./ffi.ts";
import { Win32InputController } from "./input_controller.ts";

// TRACKMOUSEEVENT: cbSize(4) + dwFlags(4) + hwndTrack(8, 8-byte aligned) +
// dwHoverTime(4) + 4 bytes trailing padding to the struct's 8-byte alignment = 24 bytes.
const TRACKMOUSEEVENT_SIZE = 24;
const TME_LEAVE = 0x00000002;

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

/**
 * Arm a one-shot `WM_MOUSELEAVE` for `hWnd`. Win32 doesn't report the pointer leaving a
 * window on its own (unlike X11's `LeaveNotify`); the window has to opt in via
 * `TrackMouseEvent`, and tracking is consumed by the very `WM_MOUSELEAVE` it requests, so it
 * must be re-armed on every `WM_MOUSEMOVE` to reliably catch the next leave.
 */
function trackMouseLeave(lib: Win32Library, hWnd: Deno.PointerValue): void {
  const buf = new ArrayBuffer(TRACKMOUSEEVENT_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, TRACKMOUSEEVENT_SIZE, true); // cbSize
  dv.setUint32(4, TME_LEAVE, true); // dwFlags
  dv.setBigUint64(8, BigInt(Deno.UnsafePointer.value(hWnd)), true); // hwndTrack
  dv.setUint32(16, 0, true); // dwHoverTime (unused without TME_HOVER)
  lib.user32.symbols.TrackMouseEvent(buf);
}

class Win32Window implements Window {
  readonly id: bigint;
  readonly #hwnd: Deno.PointerObject;
  #width: number;
  #height: number;
  /** Tracks minimized state so `WM_SIZE` transitions map to a single `visibilitychange` event instead of firing on every resize message. */
  minimized = false;
  #closed = false;

  constructor(readonly lib: Win32Library, classNameBuf: ArrayBuffer, width: number, height: number) {
    const window = lib.user32.symbols.CreateWindowExW(
      0,
      classNameBuf,
      null,
      0x10CF0000,
      0x80000000,
      0x80000000,
      width,
      height,
      null,
      null,
      lib.instance,
      0n,
    );
    if (window == null) throw new Error(lib.getLastError());
    this.#hwnd = window;
    this.id = BigInt(Deno.UnsafePointer.value(window));
    this.#width = width;
    this.#height = height;
    lib.windows.set(this.id, this);
    try {
      lib.input.attach(this);
    } catch (error) {
      lib.purgeWindowEvents(this);
      lib.windows.delete(this.id);
      const errors = [error];
      try {
        if (!lib.user32.symbols.DestroyWindow(window)) errors.push(new Error(lib.getLastError()));
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      throw collectedError(errors, "Failed to initialize Win32 window input");
    }
  }

  get hwnd(): Deno.PointerObject {
    return this.#hwnd;
  }

  setTitle(title: string): void {
    const ok = this.lib.user32.symbols.SetWindowTextW(this.#hwnd, wideStringBuffer(title));
    if (!ok) throw new Error(this.lib.getLastError());
  }

  setSize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  windowSurface(): Deno.UnsafeWindowSurface {
    return new Deno.UnsafeWindowSurface({
      system: "win32",
      windowHandle: this.#hwnd,
      displayHandle: this.lib.instance,
      width: this.#width,
      height: this.#height,
    });
  }
  [Symbol.dispose]() {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    try {
      this.lib.input.detach(this);
    } catch (error) {
      errors.push(error);
    }
    this.lib.purgeWindowEvents(this);
    this.lib.windows.delete(this.id);
    try {
      if (!this.lib.user32.symbols.DestroyWindow(this.#hwnd)) errors.push(new Error(this.lib.getLastError()));
    } catch (error) {
      errors.push(error);
    }
    throwCollected(errors, "Failed to close Win32 window");
  }
}

class Win32Library implements Library {
  readonly kernel32: Deno.DynamicLibrary<typeof kernel32functions>;
  readonly user32: Deno.DynamicLibrary<typeof user32functions>;
  #wndClass = new ArrayBuffer(80);
  #classNameBuffer = (() => {
    return wideStringBuffer("Winding");
  })();
  #wndProc: Deno.UnsafeCallback<{
    parameters: ["pointer", "u32", "usize", "usize"];
    result: "usize";
  }>;
  readonly #events = new EventQueue<UIEvent>();
  readonly #callbackErrors = new DeferredNativeError();
  readonly input: Win32InputController;
  readonly instance: Deno.PointerObject;
  readonly #instance: bigint;
  // Tracks how many mouse buttons are currently held, so capture is only
  // released once the last button of a (possibly multi-button) drag is
  // released rather than on every individual button-up.
  #captureCount = 0;
  #closed = false;
  constructor() {
    this.kernel32 = Deno.dlopen("kernel32", kernel32functions);
    this.user32 = Deno.dlopen("user32", user32functions);
    this.input = new Win32InputController(
      this.user32,
      (event) => this.#events.push(event),
      (id) => this.windows.get(id),
    );

    const wndClassDv = new DataView(this.#wndClass);
    let off = 0;

    // cbSize
    wndClassDv.setUint32(off, this.#wndClass.byteLength, true);
    off += 4;

    // style
    wndClassDv.setUint32(off, 0x1 | 0x2 | 0x20, true);
    off += 4;

    // lpfnWndProc
    this.#wndProc = new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "u32", "usize", "usize"],
        result: "usize",
      },
      guardNativeCallback(this.#callbackErrors, (hWnd, uMsg, wParam, lParam) => {
        const win = this.windows.get(BigInt(Deno.UnsafePointer.value(hWnd)));
        const inputResult = this.input.handleMessage(win, uMsg, wParam, lParam);
        if (inputResult !== undefined) return inputResult;
        switch (uMsg) {
          case WM.SIZE: {
            if (win === undefined) break;
            const w = Number(BigInt(lParam) & 0xFFFFn);
            const h = Number((BigInt(lParam) >> 16n) & 0xFFFFn);
            const minimized = Number(wParam) === SIZE_MINIMIZED;
            if (w > 0 && h > 0) win.setSize(w, h);
            if (win !== undefined && minimized !== win.minimized) {
              win.minimized = minimized;
              this.#events.push({ type: "visibilitychange", visible: !minimized, window: win });
            } else if (w > 0 && h > 0) {
              this.#events.push({ type: "resize", width: w, height: h, window: win });
            }
            break;
          }
          case WM.CLOSE:
            if (win === undefined) break;
            this.#events.push({ type: "close", window: win });
            // Return without calling DefWindowProcW to prevent immediate window
            // destruction; let the application decide when to tear down.
            return 0n;
          case WM.MOUSEMOVE: {
            if (win === undefined) break;
            // Re-arm on every move: `WM_MOUSELEAVE` tracking is consumed by the leave
            // event itself, so it must be requested again to catch the next one.
            trackMouseLeave(this, hWnd);
            this.#events.push({
              type: "mousemove",
              x: Number(BigInt(lParam) & 0xFFFFn),
              y: Number((BigInt(lParam) >> 16n) & 0xFFFFn),
              window: win,
            });
            break;
          }
          case WM.MOUSELEAVE:
            if (win === undefined) break;
            this.#events.push({ type: "mouseleave", window: win });
            break;
          case WM.LBUTTONDOWN:
          case WM.MBUTTONDOWN:
          case WM.RBUTTONDOWN: {
            if (win === undefined) break;
            // Capture the mouse so drags that leave the client area (e.g.
            // dragging a scrollbar thumb) still deliver the eventual button-up,
            // matching X11's implicit passive grab on button press.
            if (this.#captureCount++ === 0) this.user32.symbols.SetCapture(hWnd);
            this.#events.push({ type: "mousedown", button: DOWN_BUTTON[uMsg as WM]!, window: win });
            break;
          }
          case WM.LBUTTONUP:
          case WM.MBUTTONUP:
          case WM.RBUTTONUP: {
            if (win === undefined) break;
            if (this.#captureCount > 0 && --this.#captureCount === 0) {
              this.user32.symbols.ReleaseCapture();
            }
            this.#events.push({ type: "mouseup", button: UP_BUTTON[uMsg as WM]!, window: win });
            break;
          }
          case WM.MOUSEWHEEL:
          case WM.MOUSEHWHEEL: {
            if (win === undefined) break;
            // wParam's high word is a *signed* 16-bit tilt/rotation amount, in
            // multiples of WHEEL_DELTA per notch (unlike the unsigned x/y words
            // read elsewhere in this file).
            const raw = Number((BigInt(wParam) >> 16n) & 0xFFFFn);
            const signed = raw > 0x7FFF ? raw - 0x10000 : raw;
            const notches = signed / WHEEL_DELTA;
            this.#events.push(
              uMsg === WM.MOUSEWHEEL
                // Win32 reports a positive vertical delta for "rotated away from
                // the user" (scroll up); every other winding backend uses the
                // opposite convention (positive deltaY = scroll down), so flip it.
                ? { type: "wheel", deltaX: 0, deltaY: -notches, window: win }
                // Horizontal tilt-right is already positive in both Win32 and the
                // other backends (see Wayland's unflipped axis===1 handling), so
                // no sign flip is needed here.
                : { type: "wheel", deltaX: notches, deltaY: 0, window: win },
            );
            break;
          }
        }
        return this.user32.symbols.DefWindowProcW(hWnd, uMsg, wParam, lParam);
      }, (hWnd, uMsg, wParam, lParam) => {
        try {
          return this.user32.symbols.DefWindowProcW(hWnd, uMsg, wParam, lParam);
        } catch {
          // The primary callback error is already deferred. Never let a
          // secondary fallback failure unwind through the WndProc ABI.
          return 0n;
        }
      }),
    );
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
    this.#instance = BigInt(instance);
    const instancePointer = Deno.UnsafePointer.create(this.#instance);
    if (instancePointer === null) throw new Error("winding(win32): invalid module handle");
    this.instance = instancePointer;
    wndClassDv.setBigUint64(off, this.#instance, true);
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

  purgeWindowEvents(window: Win32Window): void {
    this.#events.purgeWindow(window);
  }

  readonly windows = new Map<bigint, Win32Window>();
  openWindow(_x = 0, _y = 0, w = 800, h = 600): Win32Window {
    if (this.#closed) throw new Error("winding(win32): library is closed");
    const window = new Win32Window(this, this.#classNameBuffer, w, h);
    try {
      this.#callbackErrors.throwIfPending();
      return window;
    } catch (error) {
      const errors = [error];
      try {
        window.close();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      throw collectedError(errors, "Failed to open Win32 window");
    }
  }
  #msg = new ArrayBuffer(48);
  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
    this.#callbackErrors.throwIfPending();
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;

    const ptr = Deno.UnsafePointer.of(this.#msg);
    while (this.#events.length === 0 && this.user32.symbols.PeekMessageW(ptr, null, 0, 0, PM_REMOVE)) {
      this.input.prepareKeyMessage(this.#msg);
      try {
        this.user32.symbols.TranslateMessage(ptr);
        this.user32.symbols.DispatchMessageW(ptr);
      } finally {
        this.input.clearPreparedKey();
      }
    }
    this.#callbackErrors.throwIfPending();
    return this.#events.shift();
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
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    this.#events.close();
    for (const window of [...this.windows.values()]) {
      try {
        window.close();
      } catch (error) {
        errors.push(error);
      }
    }
    captureError(errors, () => this.input.close());
    captureError(errors, () => {
      if (!this.user32.symbols.UnregisterClassW(this.#classNameBuffer, this.#instance)) {
        throw new Error(this.getLastError());
      }
    });
    captureError(errors, () => this.#callbackErrors.throwIfPending());
    captureError(errors, () => this.#wndProc.close());
    captureError(errors, () => this.user32.close());
    captureError(errors, () => this.kernel32.close());
    throwCollected(errors, "Failed to close Win32 library");
  }
}

function captureError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function throwCollected(errors: unknown[], message: string): void {
  if (errors.length > 0) throw collectedError(errors, message);
}

function collectedError(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

export const load: LoadLibrary = () => new Win32Library();
