import type { Library, LoadLibrary, MouseButton, PointerModifiers, UIEvent, Window } from "../types.ts";
import { DeferredNativeError, guardNativeCallback } from "../input/callback.ts";
import { EventQueue } from "../input/event_queue.ts";
import { ClickCounter, NativeEventClock } from "../input/events.ts";
import {
  decodeWin32DpiChange,
  logicalWin32ScreenPosition,
  scaleWin32OuterGeometry,
  USER_DEFAULT_SCREEN_DPI,
  Win32DpiAwareness,
  Win32DpiState,
  type Win32OuterGeometry,
} from "./dpi.ts";
import { describeWin32Error, WIN32_SYSTEM_MESSAGE_FLAGS } from "./error.ts";
import { prepareWin32Frame, type Win32PreparedFrame, Win32RetainedFrame } from "./frame.ts";
import {
  gdi32functions,
  imm32functions,
  kernel32functions,
  PM_NOREMOVE,
  PM_REMOVE,
  SIZE_MINIMIZED,
  user32functions,
  WHEEL_DELTA,
  win32IntegerResource,
  win32WndProcDefinition,
  WM,
} from "./ffi.ts";
import {
  completeWin32MouseMessage,
  decodeMouseLParam,
  decodeWin32ClientRect,
  decodeWin32QueuedMessage,
  TranslateMessageReentrancyGuard,
  validateWin32Geometry,
  Win32ClientState,
  Win32MessageQueueGate,
  type Win32MouseButton,
  Win32MouseCaptureState,
  Win32MouseTrackingState,
  win32PointerModifiers,
  win32QuitExitCode,
} from "./input.ts";
import { Win32InputController } from "./input_controller.ts";
import { Win32WindowLifecycleGate } from "./window_lifecycle.ts";

const PAINTSTRUCT_SIZE = 72;
const BLACKNESS = 0x00000042;
const DIB_RGB_COLORS = 0;
const ERROR_CLASS_DOES_NOT_EXIST = 1411;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const WS_OVERLAPPEDWINDOW = 0x00CF0000;

let win32LibraryActive = false;

// TRACKMOUSEEVENT: cbSize(4) + dwFlags(4) + hwndTrack(8, 8-byte aligned) +
// dwHoverTime(4) + 4 bytes trailing padding to the struct's 8-byte alignment = 24 bytes.
const TRACKMOUSEEVENT_SIZE = 24;
const TME_LEAVE = 0x00000002;

const DOWN_BUTTON: Partial<Record<WM, Win32MouseButton>> = {
  [WM.LBUTTONDOWN]: "left",
  [WM.MBUTTONDOWN]: "middle",
  [WM.RBUTTONDOWN]: "right",
};
const UP_BUTTON: Partial<Record<WM, Win32MouseButton>> = {
  [WM.LBUTTONUP]: "left",
  [WM.MBUTTONUP]: "middle",
  [WM.RBUTTONUP]: "right",
};

interface Win32PointerSnapshot extends PointerModifiers {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  buttons: number;
  timeStamp: number;
}

function wideStringBuffer(value: string): ArrayBuffer {
  const buffer = new ArrayBuffer((value.length + 1) * 2);
  const view = new Uint16Array(buffer);
  for (let i = 0; i < value.length; i++) view[i] = value.charCodeAt(i);
  view[value.length] = 0;
  return buffer;
}

/** Serialize one rooted opaque pointer into the x64 WNDCLASSEXW buffer. */
function writePointerField(view: DataView, offset: number, pointer: Deno.PointerValue): void {
  view.setBigUint64(offset, pointer === null ? 0n : Deno.UnsafePointer.value(pointer), true);
}

/**
 * Arm a one-shot `WM_MOUSELEAVE` for `hWnd`. Tracking stays active until the requested leave,
 * so each window arms it once when the pointer enters and re-arms only after a real crossing.
 */
function trackMouseLeave(lib: Win32Library, hWnd: Deno.PointerObject): void {
  const buf = new ArrayBuffer(TRACKMOUSEEVENT_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, TRACKMOUSEEVENT_SIZE, true); // cbSize
  dv.setUint32(4, TME_LEAVE, true); // dwFlags
  dv.setBigUint64(8, Deno.UnsafePointer.value(hWnd), true); // hwndTrack
  dv.setUint32(16, 0, true); // dwHoverTime (unused without TME_HOVER)
  if (lib.user32.symbols.TrackMouseEvent(buf) === 0) {
    throw new Error(lib.getLastError());
  }
}

class Win32Window implements Window {
  readonly id: bigint;
  readonly #hwnd: Deno.PointerObject;
  readonly #retainedFrame = new Win32RetainedFrame();
  readonly mouseTracking = new Win32MouseTrackingState();
  pointerSnapshot: Win32PointerSnapshot | undefined;
  readonly clientState = new Win32ClientState();
  readonly dpiState: Win32DpiState;
  readonly #lifecycle = new Win32WindowLifecycleGate();

  constructor(
    readonly lib: Win32Library,
    classNameBuf: ArrayBuffer,
    x: number,
    y: number,
    width: number,
    height: number,
    creationThreadDpiAwareness: Win32DpiAwareness,
    systemDpi: number,
  ) {
    if (
      creationThreadDpiAwareness === Win32DpiAwareness.UNAWARE &&
      systemDpi !== USER_DEFAULT_SCREEN_DPI
    ) {
      throw new Error("winding(win32): unaware thread reported non-default system DPI");
    }
    // Create on the intended monitor using primary/system scaling first. Once
    // the HWND exists, its monitor DPI can refine outer size without moving it.
    const provisionalGeometry = scaleWin32OuterGeometry(x, y, width, height, systemDpi, systemDpi);
    const window = lib.user32.symbols.CreateWindowExW(
      0,
      classNameBuf,
      null,
      WS_OVERLAPPEDWINDOW,
      provisionalGeometry.x,
      provisionalGeometry.y,
      provisionalGeometry.width,
      provisionalGeometry.height,
      null,
      null,
      lib.instance,
      null,
    );
    if (window == null) throw new Error(lib.getLastError());
    this.#hwnd = window;
    this.id = Deno.UnsafePointer.value(window);
    try {
      this.dpiState = lib.dpiStateForWindow(window);
      let appliedGeometry = provisionalGeometry;
      for (let attempt = 0; attempt < 4; attempt++) {
        const nativeGeometry = this.dpiState.outerGeometry(x, y, width, height, systemDpi);
        if (
          nativeGeometry.x !== appliedGeometry.x || nativeGeometry.y !== appliedGeometry.y ||
          nativeGeometry.width !== appliedGeometry.width || nativeGeometry.height !== appliedGeometry.height
        ) {
          lib.setOuterGeometry(window, nativeGeometry);
          appliedGeometry = nativeGeometry;
        }
        const observedDpi = lib.dpiForWindow(window);
        if (observedDpi === this.dpiState.dpi) break;
        if (!this.dpiState.handlesDpiChanges || attempt === 3) {
          throw new Error("winding(win32): initial window DPI did not stabilize");
        }
        // A large size correction can change the monitor owning the still-
        // hidden HWND. Re-query and refine so an initialization-time
        // WM_DPICHANGED cannot leave cached scale stale before registration.
        this.dpiState.update(observedDpi);
      }
      lib.windows.set(this.id, this);
      lib.input.attach(this);
      lib.publishInitialWindowState(this);
      lib.user32.symbols.ShowWindow(window, SW_SHOW);
    } catch (error) {
      const errors = [error];
      try {
        if (lib.user32.symbols.DestroyWindow(window) === 0 && !this.#lifecycle.destroyed) {
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

  get devicePixelRatio(): number {
    return this.dpiState.devicePixelRatio;
  }

  nativeToLogical(value: number): number {
    return this.dpiState.nativeToLogical(value);
  }

  containsClientPoint(x: number, y: number): boolean {
    return this.clientState.contains(x, y);
  }

  setTitle(title: string): void {
    this.#lifecycle.mutate(() => {
      const ok = this.lib.user32.symbols.SetWindowTextW(this.#hwnd, wideStringBuffer(title));
      if (ok === 0) throw new Error(this.lib.getLastError());
    });
  }

  setImeEnabled(enabled: boolean): void {
    this.#lifecycle.mutate(() => this.lib.input.setImeEnabled(this, enabled));
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.#lifecycle.mutate(() => this.lib.input.setImeCursorArea(this, x, y, width, height));
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    this.#lifecycle.mutate(() =>
      this.lib.input.setImeSurroundingText(this, text, selectionStartBytes, selectionEndBytes)
    );
  }

  /**
   * Copy an RGBA pixel buffer to the window's client area via GDI. Converts
   * to a top-down 32bpp BGRA DIB (matching the BGRX reordering used by the
   * X11 backend) and blits it with `SetDIBitsToDevice`.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    this.#lifecycle.mutate(() => {
      const candidate = prepareWin32Frame(rgba, width, height, this.clientState.framebufferSize);

      const hdc = this.lib.user32.symbols.GetDC(this.#hwnd);
      if (hdc == null) throw new Error("winding(win32): GetDC failed");
      try {
        this.#retainedFrame.drawAndRetain(candidate, (frame) => this.#drawFrame(hdc, frame));
      } finally {
        this.lib.user32.symbols.ReleaseDC(this.#hwnd, hdc);
      }
    });
  }

  paint(hdc: Deno.PointerObject, left: number, top: number, right: number, bottom: number): void {
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width > 0 && height > 0 && this.lib.gdi32.symbols.PatBlt(hdc, left, top, width, height, BLACKNESS) === 0) {
      throw new Error("winding(win32): failed to clear the paint region");
    }
    this.#retainedFrame.redraw((frame) => this.#drawFrame(hdc, frame));
  }

  #drawFrame(hdc: Deno.PointerObject, frame: Win32PreparedFrame): number {
    return this.lib.gdi32.symbols.SetDIBitsToDevice(
      hdc,
      0,
      0,
      frame.width,
      frame.height,
      0,
      0,
      0,
      frame.height,
      frame.bgra,
      frame.bitmapInfo,
      DIB_RGB_COLORS,
    );
  }
  [Symbol.dispose]() {
    this.close();
  }
  close(): void {
    if (!this.#lifecycle.beginClose()) return;
    try {
      if (this.lib.user32.symbols.DestroyWindow(this.#hwnd) === 0 && !this.#lifecycle.destroyed) {
        throw new Error(this.lib.getLastError());
      }
    } catch (error) {
      this.#lifecycle.recoverFailedClose();
      throw error;
    }
    if (!this.#lifecycle.destroyed) {
      this.#lifecycle.recoverFailedClose();
      throw new Error("winding(win32): DestroyWindow returned before WM_NCDESTROY");
    }
  }

  /** Complete JavaScript teardown only at Win32's definitive HWND lifetime boundary. */
  nativeDestroyed(): void {
    if (!this.#lifecycle.markDestroyed()) return;
    this.mouseTracking.reset();
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
  #wndProc: Deno.UnsafeCallback<typeof win32WndProcDefinition>;
  readonly #events = new EventQueue<UIEvent>();
  readonly #callbackErrors = new DeferredNativeError();
  readonly #translateMessageGuard = new TranslateMessageReentrancyGuard();
  readonly input: Win32InputController;
  readonly instance: Deno.PointerObject;
  readonly #mouseCapture = new Win32MouseCaptureState();
  readonly #eventClock = new NativeEventClock(2 ** 32);
  readonly #clickCounter = new ClickCounter<MouseButton>();
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
      win32WndProcDefinition,
      guardNativeCallback(this.#callbackErrors, (hWnd, uMsg, wParam, lParam) => {
        const win = this.windows.get(Deno.UnsafePointer.value(hWnd));
        const defaultProcedure = () => this.user32.symbols.DefWindowProcW(hWnd, uMsg, wParam, lParam);
        let inputResult: bigint | undefined;
        const inSendMessageFlags = this.#translateMessageGuard.translating
          ? this.user32.symbols.InSendMessageEx(null)
          : 0;
        if (this.#translateMessageGuard.shouldDefer(inSendMessageFlags)) {
          const deferred = this.input.deferImeMessage(
            win,
            uMsg,
            wParam,
            lParam,
            (operation) => this.#translateMessageGuard.defer(operation),
          );
          inputResult = deferred === undefined ? this.input.handleMessage(win, uMsg, wParam, lParam) : deferred.result;
        } else {
          inputResult = this.input.handleMessage(win, uMsg, wParam, lParam);
        }
        if (inputResult !== undefined) return inputResult;
        switch (uMsg) {
          case WM.NCCREATE:
            // Per-Monitor-V1 hosts require this window-local opt-in for the
            // non-client frame. V2 does it automatically; other contexts can
            // reject the call without affecting client-area DPI handling.
            try {
              this.user32.symbols.EnableNonClientDpiScaling(hWnd);
            } catch {
              // Optional enhancement only: continue normal NCCREATE handling.
            }
            break;
          case WM.PAINT: {
            if (win === undefined) break;
            const paint = new ArrayBuffer(PAINTSTRUCT_SIZE);
            const hdc = this.user32.symbols.BeginPaint(hWnd, paint);
            if (hdc === null) throw new Error("winding(win32): BeginPaint failed");
            let paintError: unknown;
            try {
              const view = new DataView(paint);
              win.paint(
                hdc,
                view.getInt32(12, true),
                view.getInt32(16, true),
                view.getInt32(20, true),
                view.getInt32(24, true),
              );
            } catch (error) {
              paintError = error;
            }
            const endPaintError = this.user32.symbols.EndPaint(hWnd, paint) === 0
              ? new Error("winding(win32): EndPaint failed")
              : undefined;
            if (paintError !== undefined && endPaintError !== undefined) {
              throw new AggregateError([paintError, endPaintError], "winding(win32): failed to paint window");
            }
            if (paintError !== undefined) throw paintError;
            if (endPaintError !== undefined) throw endPaintError;
            return 0n;
          }
          case WM.SIZE: {
            if (win === undefined) break;
            this.#publishClientState(win, Number(wParam) === SIZE_MINIMIZED);
            break;
          }
          case WM.DPICHANGED: {
            if (win === undefined || !win.dpiState.handlesDpiChanges) break;
            const rectanglePointer = Deno.UnsafePointer.create(BigInt.asUintN(64, BigInt(lParam)));
            if (rectanglePointer === null) throw new Error("winding(win32): WM_DPICHANGED omitted its rectangle");
            const rectangle = new Uint8Array(16);
            new Deno.UnsafePointerView(rectanglePointer).copyInto(rectangle);
            const change = decodeWin32DpiChange(wParam, rectangle);
            win.dpiState.update(change.dpi);
            const errors: unknown[] = [];
            // Updating DPI first ensures a synchronous WM_SIZE is converted
            // with the new scale rather than publishing a stale logical size.
            captureError(errors, () => this.setOuterGeometry(win.hwnd, change));
            captureError(errors, () => this.#publishClientState(win, win.clientState.minimized));
            captureError(errors, () => this.input.dpiChanged(win));
            throwCollected(errors, "Failed to apply Win32 DPI change");
            return 0n;
          }
          case WM.CLOSE:
            if (win === undefined) break;
            this.#events.push({ type: "close", window: win });
            // Return without calling DefWindowProcW to prevent immediate window
            // destruction; let the application decide when to tear down.
            return 0n;
          case WM.NCDESTROY:
            if (win !== undefined) {
              this.#mouseCapture.resetOwner(win.id);
              win.nativeDestroyed();
            }
            break;
          case WM.CAPTURECHANGED:
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            this.#mouseCapture.resetOwner(win.id);
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          case WM.CANCELMODE:
            if (win !== undefined) this.#cancelMouseCapture(win);
            break;
          case WM.MOUSEMOVE: {
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            const pointer = this.#pointerSnapshot(win, uMsg as WM, wParam, lParam);
            const inside = win.containsClientPoint(pointer.x, pointer.y);
            if (win.mouseTracking.needsLeaveTracking(inside)) {
              trackMouseLeave(this, win.hwnd);
              win.mouseTracking.markLeaveTrackingArmed();
            }
            if (win.mouseTracking.observeMove(inside)) {
              this.#events.push({ type: "mouseenter", ...pointer, window: win });
            }
            this.#events.push({
              type: "mousemove",
              ...pointer,
              window: win,
            });
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          }
          case WM.MOUSELEAVE:
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            if (win.mouseTracking.observeLeave()) {
              const pointer = {
                ...(win.pointerSnapshot ?? emptyPointerSnapshot(this.#messageTimeStamp())),
                timeStamp: this.#messageTimeStamp(),
                ...this.#pointerModifiers(),
              };
              win.pointerSnapshot = pointer;
              this.#events.push({ type: "mouseleave", ...pointer, window: win });
            }
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          case WM.LBUTTONDOWN:
          case WM.MBUTTONDOWN:
          case WM.RBUTTONDOWN:
          case WM.XBUTTONDOWN: {
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            // Capture the mouse so drags that leave the client area (e.g.
            // dragging a scrollbar thumb) still deliver the eventual button-up,
            // matching X11's implicit passive grab on button press.
            const button = uMsg === WM.XBUTTONDOWN ? win32XButton(wParam) : DOWN_BUTTON[uMsg as WM];
            if (button === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            this.#captureMouseButton(win, button);
            const pointer = this.#pointerSnapshot(win, uMsg as WM, wParam, lParam, button, true);
            this.#events.push({
              type: "mousedown",
              button,
              detail: this.#clickCounter.detail(button, true, pointer.timeStamp, pointer.x, pointer.y),
              ...pointer,
              window: win,
            });
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          }
          case WM.LBUTTONUP:
          case WM.MBUTTONUP:
          case WM.RBUTTONUP:
          case WM.XBUTTONUP: {
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            const button = uMsg === WM.XBUTTONUP ? win32XButton(wParam) : UP_BUTTON[uMsg as WM];
            if (button === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            this.#releaseMouseButton(win, button);
            const pointer = this.#pointerSnapshot(win, uMsg as WM, wParam, lParam, button, false);
            this.#events.push({
              type: "mouseup",
              button,
              detail: this.#clickCounter.detail(button, false, pointer.timeStamp, pointer.x, pointer.y),
              ...pointer,
              window: win,
            });
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          }
          case WM.MOUSEWHEEL:
          case WM.MOUSEHWHEEL: {
            if (win === undefined) return completeWin32MouseMessage(uMsg, false, defaultProcedure);
            // wParam's high word is a *signed* 16-bit tilt/rotation amount, in
            // multiples of WHEEL_DELTA per notch (unlike the unsigned x/y words
            // read elsewhere in this file).
            const raw = Number((BigInt(wParam) >> 16n) & 0xFFFFn);
            const signed = raw > 0x7FFF ? raw - 0x10000 : raw;
            const notches = signed / WHEEL_DELTA;
            const pointer = this.#pointerSnapshot(win, uMsg as WM, wParam, lParam);
            this.#events.push(
              uMsg === WM.MOUSEWHEEL
                // Win32 reports a positive vertical delta for "rotated away from
                // the user" (scroll up); every other winding backend uses the
                // opposite convention (positive deltaY = scroll down), so flip it.
                ? { type: "wheel", deltaX: 0, deltaY: -notches, deltaMode: 1, ...pointer, window: win }
                // Horizontal tilt-right is already positive in both Win32 and the
                // other backends (see Wayland's unflipped axis===1 handling), so
                // no sign flip is needed here.
                : { type: "wheel", deltaX: notches, deltaY: 0, deltaMode: 1, ...pointer, window: win },
            );
            return completeWin32MouseMessage(uMsg, true, defaultProcedure);
          }
        }
        return defaultProcedure();
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
    writePointerField(wndClassDv, off, this.#wndProc.pointer);
    off += 8;

    // cbClsExtra
    off += 4;

    // cbWndExtra
    off += 4;

    // hInstance
    const instance = rollback.run(() => this.kernel32.symbols.GetModuleHandleW(null));
    const instancePointer = instance === null
      ? rollback.fail(new Error(rollback.run(() => this.getLastError())))
      : instance;
    this.instance = instancePointer;
    writePointerField(wndClassDv, off, instancePointer);
    off += 8;

    // hIcon
    off += 8;

    // hCursor
    // IDC_ARROW uses MAKEINTRESOURCEW's tagged LPCWSTR representation.
    const cursorName = rollback.run(() => win32IntegerResource(32512));
    const cursor = rollback.run(() => this.user32.symbols.LoadCursorW(null, cursorName));
    const cursorPointer = cursor === null ? rollback.fail(new Error(rollback.run(() => this.getLastError()))) : cursor;
    writePointerField(wndClassDv, off, cursorPointer);
    off += 8;

    // hbrBackground
    off += 8;

    // lpszMenuName
    off += 8;

    // lpszClassName
    writePointerField(wndClassDv, off, Deno.UnsafePointer.of(this.#classNameBuffer));
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

  currentThreadDpiAwareness(): Win32DpiAwareness {
    const context = this.user32.symbols.GetThreadDpiAwarenessContext();
    if (context === null) throw new Error("winding(win32): no thread DPI awareness context");
    return this.#dpiAwareness(context);
  }

  dpiStateForWindow(window: Deno.PointerObject): Win32DpiState {
    const context = this.user32.symbols.GetWindowDpiAwarenessContext(window);
    if (context === null) throw new Error("winding(win32): no window DPI awareness context");
    return new Win32DpiState(this.#dpiAwareness(context), this.dpiForWindow(window));
  }

  dpiForWindow(window: Deno.PointerObject): number {
    const dpi = this.user32.symbols.GetDpiForWindow(window);
    if (dpi === 0) throw new Error("winding(win32): GetDpiForWindow failed");
    return dpi;
  }

  systemDpi(): number {
    const dpi = this.user32.symbols.GetDpiForSystem();
    if (dpi === 0) throw new Error("winding(win32): GetDpiForSystem failed");
    return dpi;
  }

  #dpiAwareness(context: Deno.PointerObject): Win32DpiAwareness {
    const awareness = this.user32.symbols.GetAwarenessFromDpiAwarenessContext(context);
    if (
      awareness !== Win32DpiAwareness.UNAWARE && awareness !== Win32DpiAwareness.SYSTEM &&
      awareness !== Win32DpiAwareness.PER_MONITOR
    ) {
      throw new Error("winding(win32): invalid DPI awareness context");
    }
    return awareness;
  }

  setOuterGeometry(window: Deno.PointerObject, geometry: Win32OuterGeometry): void {
    if (
      this.user32.symbols.SetWindowPos(
        window,
        null,
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
        SWP_NOZORDER | SWP_NOACTIVATE,
      ) === 0
    ) {
      throw new Error(this.getLastError());
    }
  }

  #nativeCaptureOwner(): bigint | undefined {
    const capture = this.user32.symbols.GetCapture();
    return capture === null ? undefined : Deno.UnsafePointer.value(capture);
  }

  #messageTimeStamp(): number {
    return this.#eventClock.timeStamp(this.user32.symbols.GetMessageTime() >>> 0);
  }

  #pointerModifiers(keyState?: number): PointerModifiers {
    return win32PointerModifiers(
      keyState,
      (virtualKey) => this.user32.symbols.GetKeyState(virtualKey),
      () => this.input.layoutHasAltGraph(),
    );
  }

  #pointerSnapshot(
    window: Win32Window,
    message: WM,
    wParam: number | bigint,
    lParam: number | bigint,
    changedButton?: MouseButton,
    pressed?: boolean,
  ): Win32PointerSnapshot {
    const point = decodeMouseLParam(lParam);
    let nativeScreenX = point.x;
    let nativeScreenY = point.y;
    if (message === WM.MOUSEWHEEL || message === WM.MOUSEHWHEEL) {
      const clientPoint = new Int32Array([point.x, point.y]);
      if (this.user32.symbols.ScreenToClient(window.hwnd, clientPoint) === 0) {
        throw new Error(this.getLastError());
      }
      point.x = clientPoint[0];
      point.y = clientPoint[1];
    } else {
      const screenPoint = new Int32Array([point.x, point.y]);
      if (this.user32.symbols.ClientToScreen(window.hwnd, screenPoint) === 0) {
        throw new Error(this.getLastError());
      }
      nativeScreenX = screenPoint[0];
      nativeScreenY = screenPoint[1];
    }
    // Mouse messages and ScreenToClient use the HWND's native coordinate
    // space. Public pointer coordinates share the resize event's logical units.
    point.x = window.nativeToLogical(point.x);
    point.y = window.nativeToLogical(point.y);
    const screen = logicalWin32ScreenPosition(nativeScreenX, nativeScreenY, this.systemDpi());
    const keyState = Number(BigInt(wParam) & 0xffffn);
    let buttons = win32Buttons(keyState);
    if (changedButton !== undefined && pressed !== undefined) {
      const mask = mouseButtonMask(changedButton);
      buttons = pressed ? buttons | mask : buttons & ~mask;
    }
    const snapshot: Win32PointerSnapshot = {
      x: point.x,
      y: point.y,
      ...screen,
      buttons,
      timeStamp: this.#messageTimeStamp(),
      ...this.#pointerModifiers(keyState),
    };
    window.pointerSnapshot = snapshot;
    return snapshot;
  }

  #captureMouseButton(window: Win32Window, button: Win32MouseButton): void {
    if (this.#mouseCapture.owns(window.id) && this.#nativeCaptureOwner() !== window.id) {
      this.#mouseCapture.resetOwner(window.id);
    }
    if (!this.#mouseCapture.owns(window.id)) {
      // A null SetCapture result only means there was no previous owner. Query
      // the actual owner instead of interpreting the return as success/failure.
      this.user32.symbols.SetCapture(window.hwnd);
      if (this.#nativeCaptureOwner() !== window.id) {
        throw new Error("winding(win32): SetCapture did not assign mouse capture");
      }
    }
    this.#mouseCapture.recordDown(window.id, button);
  }

  #releaseMouseButton(window: Win32Window, button: Win32MouseButton): void {
    if (!this.#mouseCapture.owns(window.id) || !this.#mouseCapture.hasButton(button)) return;
    if (!this.#mouseCapture.releaseWouldEnd(window.id, button)) {
      this.#mouseCapture.recordUp(window.id, button);
      return;
    }

    const released = this.user32.symbols.ReleaseCapture();
    const nativeOwner = this.#nativeCaptureOwner();
    if (nativeOwner !== window.id) this.#mouseCapture.resetOwner(window.id);
    if (released === 0) {
      throw new Error("winding(win32): ReleaseCapture failed");
    }
    this.#mouseCapture.resetOwner(window.id);
  }

  #cancelMouseCapture(window: Win32Window): void {
    if (!this.#mouseCapture.owns(window.id)) return;
    if (this.#nativeCaptureOwner() !== window.id) {
      this.#mouseCapture.resetOwner(window.id);
      return;
    }
    const released = this.user32.symbols.ReleaseCapture();
    const nativeOwner = this.#nativeCaptureOwner();
    if (nativeOwner !== window.id) this.#mouseCapture.resetOwner(window.id);
    if (released === 0) throw new Error("winding(win32): failed to cancel mouse capture");
    this.#mouseCapture.resetOwner(window.id);
  }

  publishInitialWindowState(window: Win32Window): void {
    this.#publishClientState(window, false);

    const focus = this.user32.symbols.GetFocus();
    const focused = focus !== null && Deno.UnsafePointer.value(focus) === window.id;
    this.input.observeNativeFocus(window, focused);
  }

  #publishClientState(window: Win32Window, minimized: boolean): void {
    const clientRect = new ArrayBuffer(16);
    if (this.user32.symbols.GetClientRect(window.hwnd, clientRect) === 0) {
      throw new Error(this.getLastError());
    }
    const framebuffer = decodeWin32ClientRect(clientRect);
    const change = window.clientState.observe(
      minimized,
      framebuffer.width,
      framebuffer.height,
      window.devicePixelRatio,
    );
    if (change.visible !== undefined) {
      this.#events.push({ type: "visibilitychange", visible: change.visible, window });
    }
    if (change.size !== undefined) {
      this.#events.push({
        type: "resize",
        width: change.size.width,
        height: change.size.height,
        framebufferWidth: change.size.framebufferWidth,
        framebufferHeight: change.size.framebufferHeight,
        devicePixelRatio: change.size.devicePixelRatio,
        window,
      });
    }
  }

  readonly windows = new Map<bigint, Win32Window>();
  openWindow(x = 0, y = 0, w = 800, h = 600): Win32Window {
    if (this.#closed || this.#closing) throw new Error("winding(win32): library is closed");
    validateWin32Geometry(x, y, w, h);
    const threadAwareness = this.currentThreadDpiAwareness();
    const systemDpi = this.systemDpi();
    const window = new Win32Window(this, this.#classNameBuffer, x, y, w, h, threadAwareness, systemDpi);
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
  readonly #messageQueue = new Win32MessageQueueGate();
  event(): UIEvent | undefined {
    if (this.#closed || this.#closing) return undefined;
    this.#callbackErrors.throwIfPending();
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;
    if (!this.#messageQueue.mayPump) return undefined;

    const ptr = Deno.UnsafePointer.of(this.#msg);
    while (
      this.#events.length === 0 && this.#messageQueue.mayPump &&
      this.user32.symbols.PeekMessageW(ptr, null, 0, 0, PM_NOREMOVE) !== 0
    ) {
      const next = decodeWin32QueuedMessage(this.#msg);
      const owner = this.windows.get(next.windowId);
      const disposition = this.#messageQueue.observe(next, owner !== undefined);
      if (disposition !== "dispatch" || owner === undefined) break;

      // Remove through the observed HWND rather than NULL. Thread messages are
      // therefore never selected if sent-message processing changes the queue
      // between the non-removing peek and this call. WM_QUIT is Win32's one
      // documented exception to the HWND filter and is handled below.
      if (this.user32.symbols.PeekMessageW(ptr, owner.hwnd, 0, 0, PM_REMOVE) === 0) continue;
      const removed = decodeWin32QueuedMessage(this.#msg);
      if (this.#messageQueue.observe(removed, this.windows.has(removed.windowId)) === "quit") {
        // PeekMessage always selects WM_QUIT even with an HWND filter. Preserve
        // a quit posted during sent-message reentry by restoring its exit code
        // exactly once; the latched gate prevents us from consuming it again.
        this.user32.symbols.PostQuitMessage(win32QuitExitCode(removed.wParam));
        break;
      }

      this.input.prepareKeyMessage(this.#msg);
      try {
        this.#translateMessageGuard.begin();
        try {
          this.user32.symbols.TranslateMessage(ptr);
        } finally {
          this.#translateMessageGuard.end();
        }
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
    let charactersWritten = 0;
    try {
      charactersWritten = this.kernel32.symbols.FormatMessageW(
        WIN32_SYSTEM_MESSAGE_FLAGS,
        null,
        code,
        0,
        Deno.UnsafePointer.of(this.#lastErrorBuffer),
        this.#lastErrorBuffer.byteLength / 2,
        null,
      );
    } catch {
      return describeWin32Error(code);
    }
    let s = "";
    for (let i = 0; i < charactersWritten; i++) {
      s += String.fromCharCode(bufU16[i]);
    }
    return describeWin32Error(code, s);
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
        if (this.user32.symbols.UnregisterClassW(this.#classNameBuffer, this.instance) !== 0) {
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
    this.#translateMessageGuard.clear();
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

function win32XButton(wParam: number | bigint): MouseButton | undefined {
  const button = Number((BigInt(wParam) >> 16n) & 0xffffn);
  return button === 1 ? "back" : button === 2 ? "forward" : undefined;
}

function win32Buttons(keyState: number): number {
  return (keyState & 0x0001 ? 1 : 0) |
    (keyState & 0x0002 ? 2 : 0) |
    (keyState & 0x0010 ? 4 : 0) |
    (keyState & 0x0020 ? 8 : 0) |
    (keyState & 0x0040 ? 16 : 0);
}

function mouseButtonMask(button: MouseButton): number {
  return button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : button === "back" ? 8 : 16;
}

function emptyPointerSnapshot(timeStamp: number): Win32PointerSnapshot {
  return {
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    buttons: 0,
    timeStamp,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    capsLock: false,
    altGraphKey: false,
    fnKey: false,
    numLock: false,
    scrollLock: false,
  };
}

export const load: LoadLibrary = () => new Win32Library();
