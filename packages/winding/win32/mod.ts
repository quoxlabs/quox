import type { Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { DeferredNativeError, guardNativeCallback } from "../input/callback.ts";
import { EventQueue } from "../input/event_queue.ts";
import {
  gdi32functions,
  imm32functions,
  kernel32functions,
  PM_REMOVE,
  SIZE_MINIMIZED,
  user32functions,
  WHEEL_DELTA,
  WM,
} from "./ffi.ts";
import { validateWin32Geometry } from "./input.ts";
import { Win32InputController } from "./input_controller.ts";

// BITMAPINFOHEADER is 40 bytes; for 32bpp BI_RGB no color table follows, so
// this buffer alone is a valid BITMAPINFO for SetDIBitsToDevice.
const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const ERROR_CLASS_DOES_NOT_EXIST = 1411;
const SW_SHOW = 5;
const WS_OVERLAPPEDWINDOW = 0x00CF0000;

let win32LibraryActive = false;

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
  #bgra = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  #bmi = new ArrayBuffer(BITMAPINFOHEADER_SIZE);
  /** Tracks minimized state so `WM_SIZE` transitions map to a single `visibilitychange` event instead of firing on every resize message. */
  minimized = false;
  #clientWidth: number | undefined;
  #clientHeight: number | undefined;
  #closing = false;
  #destroyed = false;

  constructor(
    readonly lib: Win32Library,
    classNameBuf: ArrayBuffer,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    const window = lib.user32.symbols.CreateWindowExW(
      0,
      classNameBuf,
      null,
      WS_OVERLAPPEDWINDOW,
      x,
      y,
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
    lib.windows.set(this.id, this);
    try {
      lib.input.attach(this);
      lib.publishInitialWindowState(this);
      lib.user32.symbols.ShowWindow(window, SW_SHOW);
    } catch (error) {
      const errors = [error];
      try {
        if (lib.user32.symbols.DestroyWindow(window) === 0 && !this.#destroyed) {
          errors.push(new Error(lib.getLastError()));
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      throw collectedError(errors, "Failed to initialize Win32 window input");
    }
  }

  get hwnd(): Deno.PointerObject {
    return this.#hwnd;
  }

  observeClientSize(width: number, height: number): boolean {
    if (this.#clientWidth === width && this.#clientHeight === height) return false;
    this.#clientWidth = width;
    this.#clientHeight = height;
    return true;
  }

  setTitle(title: string): void {
    const ok = this.lib.user32.symbols.SetWindowTextW(this.#hwnd, wideStringBuffer(title));
    if (ok === 0) throw new Error(this.lib.getLastError());
  }

  setImeEnabled(enabled: boolean): void {
    if (this.#destroyed) return;
    this.lib.input.setImeEnabled(this, enabled);
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    if (this.#destroyed) return;
    this.lib.input.setImeCursorArea(this, x, y, width, height);
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    if (this.#destroyed) return;
    this.lib.input.setImeSurroundingText(this, text, selectionStartBytes, selectionEndBytes);
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
    if (this.#destroyed || this.#closing) return;
    this.#closing = true;
    try {
      if (this.lib.user32.symbols.DestroyWindow(this.#hwnd) === 0 && !this.#destroyed) {
        this.#closing = false;
        throw new Error(this.lib.getLastError());
      }
    } catch (error) {
      if (!this.#destroyed) this.#closing = false;
      throw error;
    }
    if (!this.#destroyed) {
      this.#closing = false;
      throw new Error("winding(win32): DestroyWindow returned before WM_NCDESTROY");
    }
  }

  /** Complete JavaScript teardown only at Win32's definitive HWND lifetime boundary. */
  nativeDestroyed(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#closing = false;
    const errors: unknown[] = [];
    try {
      this.lib.input.detach(this);
    } catch (error) {
      errors.push(error);
    } finally {
      this.lib.purgeWindowEvents(this);
      this.lib.windows.delete(this.id);
    }
    throwCollected(errors, "Failed to release destroyed Win32 window state");
  }
}

class Win32Library implements Library {
  readonly kernel32: Deno.DynamicLibrary<typeof kernel32functions>;
  readonly user32: Deno.DynamicLibrary<typeof user32functions>;
  readonly gdi32: Deno.DynamicLibrary<typeof gdi32functions>;
  readonly imm32: Deno.DynamicLibrary<typeof imm32functions>;
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
  #classRegistered = false;
  #closing = false;
  #closed = false;
  constructor() {
    if (win32LibraryActive) {
      throw new Error("winding(win32): only one library instance may be active");
    }

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
            if (win !== undefined && minimized !== win.minimized) {
              win.minimized = minimized;
              this.#events.push({ type: "visibilitychange", visible: !minimized, window: win });
            } else if (w > 0 && h > 0 && win.observeClientSize(w, h)) {
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
          case WM.NCDESTROY:
            if (win !== undefined) win.nativeDestroyed();
            break;
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
    win32LibraryActive = true;
    const rollback = new ConstructionRollback(() => {
      win32LibraryActive = false;
    });
    rollback.defer(() => this.#wndProc.close());
    this.kernel32 = rollback.acquire(
      () => Deno.dlopen("kernel32", kernel32functions),
      (library) => library.close(),
    );
    this.user32 = rollback.acquire(
      () => Deno.dlopen("user32", user32functions),
      (library) => library.close(),
    );
    this.gdi32 = rollback.acquire(
      () => Deno.dlopen("gdi32", gdi32functions),
      (library) => library.close(),
    );
    this.imm32 = rollback.acquire(
      () => Deno.dlopen("imm32", imm32functions),
      (library) => library.close(),
    );
    this.input = rollback.acquire(
      () =>
        new Win32InputController(
          this.user32,
          this.imm32,
          (event) => this.#events.push(event),
          (id) => this.windows.get(id),
        ),
      (input) => input.close(),
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
    const instance = rollback.run(() => this.kernel32.symbols.GetModuleHandleW(null));
    if (BigInt(instance) == 0n) rollback.fail(new Error(rollback.run(() => this.getLastError())));
    this.#instance = BigInt(instance);
    const instancePointer = rollback.run(() => Deno.UnsafePointer.create(this.#instance));
    if (instancePointer === null) rollback.fail(new Error("winding(win32): invalid module handle"));
    this.instance = instancePointer;
    wndClassDv.setBigUint64(off, this.#instance, true);
    off += 8;

    // hIcon
    off += 8;

    // hCursor
    const cursor = rollback.run(() => this.user32.symbols.LoadCursorW(null, 32512n));
    // (IDC_ARROW - https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors)
    if (BigInt(cursor) === 0n) rollback.fail(new Error(rollback.run(() => this.getLastError())));
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
      rollback.fail(new Error("Bug: mismatched offset with expected WNDCLASS size"));
    }

    const wndClass = rollback.run(() => this.user32.symbols.RegisterClassExW(this.#wndClass));
    if (wndClass == 0) rollback.fail(new Error(rollback.run(() => this.getLastError())));
    this.#classRegistered = true;
    rollback.commit();
  }

  purgeWindowEvents(window: Win32Window): void {
    this.#events.purgeWindow(window);
  }

  publishInitialWindowState(window: Win32Window): void {
    const clientRect = new ArrayBuffer(16);
    if (this.user32.symbols.GetClientRect(window.hwnd, clientRect) === 0) {
      throw new Error(this.getLastError());
    }
    const rect = new DataView(clientRect);
    const width = Math.max(0, rect.getInt32(8, true) - rect.getInt32(0, true));
    const height = Math.max(0, rect.getInt32(12, true) - rect.getInt32(4, true));
    if (window.observeClientSize(width, height)) {
      this.#events.push({ type: "resize", width, height, window });
    }

    const focus = this.user32.symbols.GetFocus();
    const focused = focus !== null && BigInt(Deno.UnsafePointer.value(focus)) === window.id;
    this.input.observeNativeFocus(window, focused);
  }

  readonly windows = new Map<bigint, Win32Window>();
  openWindow(x = 0, y = 0, w = 800, h = 600): Win32Window {
    if (this.#closed || this.#closing) throw new Error("winding(win32): library is closed");
    validateWin32Geometry(x, y, w, h);
    const window = new Win32Window(this, this.#classNameBuffer, x, y, w, h);
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
    if (this.#closed || this.#closing) return undefined;
    this.#callbackErrors.throwIfPending();
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;

    const ptr = Deno.UnsafePointer.of(this.#msg);
    while (this.#events.length === 0 && this.user32.symbols.PeekMessageW(ptr, null, 0, 0, PM_REMOVE) !== 0) {
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
  getLastError(code = this.kernel32.symbols.GetLastError()) {
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
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    const errors: unknown[] = [];
    for (const window of [...this.windows.values()]) {
      try {
        window.close();
      } catch (error) {
        errors.push(error);
      }
    }

    if (this.windows.size > 0) {
      this.#closing = false;
      throw collectedError(errors, "Failed to destroy every Win32 window");
    }

    if (this.#classRegistered) {
      try {
        if (this.user32.symbols.UnregisterClassW(this.#classNameBuffer, this.#instance) !== 0) {
          this.#classRegistered = false;
        } else {
          const code = this.kernel32.symbols.GetLastError();
          if (code === ERROR_CLASS_DOES_NOT_EXIST) this.#classRegistered = false;
          else errors.push(new Error(this.getLastError(code)));
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (this.#classRegistered) {
      this.#closing = false;
      throw collectedError(errors, "Failed to unregister the Win32 window class");
    }

    this.#events.close();
    captureError(errors, () => this.input.close());
    captureError(errors, () => this.#callbackErrors.throwIfPending());
    captureError(errors, () => this.#wndProc.close());
    captureError(errors, () => this.imm32.close());
    captureError(errors, () => this.gdi32.close());
    captureError(errors, () => this.user32.close());
    captureError(errors, () => this.kernel32.close());
    this.#closed = true;
    this.#closing = false;
    win32LibraryActive = false;
    throwCollected(errors, "Failed to close Win32 library");
  }
}

class ConstructionRollback {
  readonly #cleanup: Array<() => void> = [];

  constructor(readonly onFailure: () => void) {}

  acquire<Resource>(create: () => Resource, close: (resource: Resource) => void): Resource {
    const resource = this.run(create);
    this.defer(() => close(resource));
    return resource;
  }

  defer(cleanup: () => void): void {
    this.#cleanup.push(cleanup);
  }

  run<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error: unknown): never {
    const errors = [error];
    for (let index = this.#cleanup.length - 1; index >= 0; index--) {
      captureError(errors, this.#cleanup[index]);
    }
    this.#cleanup.length = 0;
    this.onFailure();
    throw collectedError(errors, "Failed to construct Win32 library");
  }

  commit(): void {
    this.#cleanup.length = 0;
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
