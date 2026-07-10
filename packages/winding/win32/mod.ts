import type { KeyLocation, KeyModifiers, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { getDomCode } from "./dom_code.ts";
import {
  CPS_CANCEL,
  CS_INSERTCHAR,
  CS_NOMOVECARET,
  GCS_COMPATTR,
  GCS_COMPCLAUSE,
  GCS_COMPREADATTR,
  GCS_COMPREADCLAUSE,
  GCS_COMPREADSTR,
  GCS_COMPSTR,
  GCS_CURSORPOS,
  GCS_DELTASTART,
  GCS_RESULTCLAUSE,
  GCS_RESULTREADCLAUSE,
  GCS_RESULTREADSTR,
  GCS_RESULTSTR,
  gdi32functions,
  IACE_DEFAULT,
  IMECHARPOSITION_SIZE,
  imm32functions,
  IMR_QUERYCHARPOSITION,
  ISC_SHOWUICOMPOSITIONWINDOW,
  kernel32functions,
  NI_COMPOSITIONSTR,
  PM_NOREMOVE,
  PM_REMOVE,
  SIZE_MINIMIZED,
  TU_NO_STATE_CHANGE,
  UNICODE_NOCHAR,
  user32functions,
  WHEEL_DELTA,
  WM,
} from "./ffi.ts";
import {
  AltGraphControlFilter,
  type CursorRectangle,
  decodeKeyLParam,
  encodeCandidateForm,
  encodeCompositionForm,
  encodeImeCharPosition,
  ImeCompositionReducer,
  type ImeEdit,
  insertCompositionCharacter,
  isCommitText,
  keyboardModifiers,
  keyLocation,
  LogicalKeyCache,
  normalizeCursorRectangle,
  readImmUtf16,
  repeatedWmCharText,
  ResultEchoSuppressor,
  SemanticEventQueue,
  type ToUnicodeAdapter,
  translateLogicalKey,
  utf16CursorRangeToUtf8,
  VK,
  withImeContext,
  WmCharDecoder,
} from "./input.ts";

// BITMAPINFOHEADER is 40 bytes; for 32bpp BI_RGB no color table follows, so
// this buffer alone is a valid BITMAPINFO for SetDIBitsToDevice.
const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const GCS_ALL = GCS_COMPREADSTR | GCS_COMPREADATTR | GCS_COMPREADCLAUSE | GCS_COMPSTR |
  GCS_COMPATTR | GCS_COMPCLAUSE | GCS_CURSORPOS | GCS_DELTASTART | GCS_RESULTREADSTR |
  GCS_RESULTREADCLAUSE | GCS_RESULTSTR | GCS_RESULTCLAUSE;
const IME_COMPOSITION_FLAGS = GCS_ALL | CS_INSERTCHAR | CS_NOMOVECARET;

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

interface Win32KeyEvent extends KeyModifiers {
  type: "keydown" | "keyup";
  window: Win32Window;
  keycode: number;
  code: string;
  key: string;
  repeat: boolean;
  location: KeyLocation;
  isComposing: boolean;
  altGraphKey: boolean;
  textInputHandled: boolean;
}

type Win32ImeEvent =
  | { type: "ime"; kind: "enabled" | "disabled"; window: Win32Window }
  | {
    type: "ime";
    kind: "preedit";
    window: Win32Window;
    text: string;
    cursorRange?: readonly [number, number];
  }
  | { type: "ime"; kind: "commit"; window: Win32Window; text: string }
  | {
    type: "ime";
    kind: "deleteSurrounding";
    window: Win32Window;
    beforeLength: number;
    afterLength: number;
  };

type QueuedEvent = UIEvent | Win32ImeEvent;

interface PreparedKeyEvent {
  event: Win32KeyEvent;
  suppress: boolean;
}

interface NativeKeyMessage {
  windowId: bigint;
  message: number;
  virtualKey: number;
  lParam: bigint;
  timestamp: number;
}

function domKeyLocation(code: string): KeyLocation {
  switch (keyLocation(code)) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "numpad":
      return 3;
    default:
      return 0;
  }
}

function isTextInputHandled(
  type: "keydown" | "keyup",
  key: string,
  isComposing: boolean,
  modifiers: ReturnType<typeof keyboardModifiers>,
): boolean {
  if (type === "keyup") return false;
  if (isComposing || key === "Dead") return true;
  if (modifiers.altKey && !modifiers.altGraphKey) return true;
  return isCommitText(key) && (modifiers.altGraphKey || (!modifiers.ctrlKey && !modifiers.metaKey));
}

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
  focused = false;
  imeAllowed = false;
  imeActive = false;
  isComposing = false;
  preeditText = "";
  preeditCursorRange: readonly [number, number] | undefined;
  imeCursorRectangle: CursorRectangle | undefined;
  readonly logicalKeys = new LogicalKeyCache();
  readonly altGraphControlFilter = new AltGraphControlFilter();
  readonly charDecoder = new WmCharDecoder();
  readonly imeReducer = new ImeCompositionReducer();
  readonly resultEcho = new ResultEchoSuppressor();
  #closed = false;

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
      lib.instance,
      0n,
    );
    if (window == null) throw new Error(lib.getLastError());
    this.#hwnd = window;
    this.id = BigInt(Deno.UnsafePointer.value(window));
    lib.windows.set(this.id, this);
    lib.initializeWindowInput(this);
  }

  get hwnd(): Deno.PointerObject {
    return this.#hwnd;
  }

  setTitle(title: string): void {
    const ok = this.lib.user32.symbols.SetWindowTextW(this.#hwnd, wideStringBuffer(title));
    if (!ok) throw new Error(this.lib.getLastError());
  }

  setImeEnabled(enabled: boolean): void {
    if (this.#closed) return;
    this.lib.setWindowImeEnabled(this, enabled);
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    if (this.#closed) return;
    this.imeCursorRectangle = normalizeCursorRectangle(x, y, width, height);
    this.lib.updateWindowImeCursorArea(this);
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
    if (this.#closed) return;
    this.#closed = true;
    this.lib.closeWindowInput(this);
    this.lib.windows.delete(this.id);
    if (!this.lib.user32.symbols.DestroyWindow(this.#hwnd)) {
      this.#closed = false;
      this.lib.windows.set(this.id, this);
      throw new Error(this.lib.getLastError());
    }
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
  #events = new SemanticEventQueue<QueuedEvent>();
  #preparedKey: PreparedKeyEvent | undefined;
  readonly instance: Deno.PointerObject;
  readonly #instance: bigint;
  readonly #altGraphLayouts = new Map<bigint, boolean>();
  // Tracks how many mouse buttons are currently held, so capture is only
  // released once the last button of a (possibly multi-button) drag is
  // released rather than on every individual button-up.
  #captureCount = 0;
  #closed = false;
  constructor() {
    this.kernel32 = Deno.dlopen("kernel32", kernel32functions);
    this.user32 = Deno.dlopen("user32", user32functions);
    this.gdi32 = Deno.dlopen("gdi32", gdi32functions);
    this.imm32 = Deno.dlopen("imm32", imm32functions);

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
          const minimized = Number(wParam) === SIZE_MINIMIZED;
          if (win !== undefined && minimized !== win.minimized) {
            win.minimized = minimized;
            this.#events.push({ type: "visibilitychange", visible: !minimized, window: win });
          } else if (w > 0 && h > 0) {
            this.#events.push({ type: "resize", width: w, height: h, window: win });
          }
          break;
        }
        case WM.CLOSE:
          this.#events.push({ type: "close", window: win });
          // Return without calling DefWindowProcW to prevent immediate window
          // destruction; let the application decide when to tear down.
          return 0n;
        case WM.SETFOCUS: {
          if (win === undefined) break;
          win.focused = true;
          this.#events.push({ type: "focus", window: win });
          if (win.imeAllowed) this.#activateIme(win);
          break;
        }
        case WM.KILLFOCUS: {
          if (win === undefined) break;
          this.#cancelComposition(win);
          this.#setImeActive(win, false);
          win.focused = false;
          win.logicalKeys.clear();
          win.altGraphControlFilter.reset();
          this.#events.push({ type: "blur", window: win });
          break;
        }
        case WM.MOUSEMOVE: {
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
          this.#events.push({ type: "mouseleave", window: win });
          break;
        case WM.LBUTTONDOWN:
        case WM.MBUTTONDOWN:
        case WM.RBUTTONDOWN: {
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
          if (this.#captureCount > 0 && --this.#captureCount === 0) {
            this.user32.symbols.ReleaseCapture();
          }
          this.#events.push({ type: "mouseup", button: UP_BUTTON[uMsg as WM]!, window: win });
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
        case WM.KEYDOWN:
        // Alt-held key combinations arrive as WM_SYSKEYDOWN instead of
        // WM_KEYDOWN; fold them into the same "keydown" event since winding
        // has no separate "system key" event type. DefWindowProcW still runs
        // below, so system behaviors (Alt+F4, the system menu, ...) keep working.
        case WM.SYSKEYDOWN: {
          const prepared = this.#takePreparedKey(win, "keydown", wParam, lParam);
          if (prepared !== undefined && !prepared.suppress) this.#events.push(prepared.event);
          break;
        }
        case WM.KEYUP:
        case WM.SYSKEYUP: {
          const prepared = this.#takePreparedKey(win, "keyup", wParam, lParam);
          if (prepared !== undefined && !prepared.suppress) this.#events.push(prepared.event);
          break;
        }
        case WM.CHAR:
          if (win !== undefined) {
            this.#handleChar(win, wParam, lParam);
            return 0n;
          }
          break;
        case WM.DEADCHAR:
          if (win !== undefined) this.#flushCharDecoder(win);
          return 0n;
        case WM.SYSCHAR:
          if (win !== undefined && this.#currentModifiers().altGraphKey) {
            this.#handleChar(win, wParam, lParam);
            return 0n;
          }
          break;
        case WM.SYSDEADCHAR:
          if (win !== undefined && this.#currentModifiers().altGraphKey) {
            this.#flushCharDecoder(win);
            return 0n;
          }
          break;
        case WM.UNICHAR:
          if (Number(wParam) === UNICODE_NOCHAR) return 1n;
          if (win !== undefined) {
            this.#flushCharDecoder(win);
            this.#handleUniChar(win, Number(wParam), lParam);
            return 0n;
          }
          break;
        case WM.INPUTLANGCHANGE:
          this.#altGraphLayouts.clear();
          for (const window of this.windows.values()) {
            this.#flushCharDecoder(window);
            window.altGraphControlFilter.reset();
          }
          break;
        case WM.IME_STARTCOMPOSITION:
          if (win !== undefined && win.imeAllowed) {
            this.#flushCharDecoder(win);
            win.isComposing = true;
            win.resultEcho.clear();
            if (!win.imeActive) this.#setImeActive(win, true);
            this.#applyImeCursorArea(win);
            return 0n;
          }
          break;
        case WM.IME_COMPOSITION:
          if (win !== undefined && win.imeAllowed && this.#handleImeComposition(win, wParam, lParam)) return 0n;
          break;
        case WM.IME_ENDCOMPOSITION:
          if (win !== undefined && win.imeAllowed) {
            this.#flushCharDecoder(win);
            this.#queueImeEdits(win, win.imeReducer.end());
            win.isComposing = false;
            return 0n;
          }
          break;
        case WM.IME_CHAR:
          if (win !== undefined) {
            this.#handleChar(win, wParam, lParam);
            return 0n;
          }
          break;
        case WM.IME_SETCONTEXT: {
          if (win === undefined) break;
          const activating = BigInt(wParam) !== 0n;
          if (activating && win.imeAllowed) {
            this.#setImeActive(win, true);
            this.#applyImeCursorArea(win);
          } else if (!activating) {
            this.#cancelComposition(win);
            this.#setImeActive(win, false);
          }
          const forwardedLParam = win.imeAllowed
            ? BigInt.asUintN(64, BigInt(lParam)) & ~BigInt(ISC_SHOWUICOMPOSITIONWINDOW)
            : BigInt(lParam);
          return this.user32.symbols.DefWindowProcW(hWnd, uMsg, wParam, forwardedLParam);
        }
        case WM.IME_REQUEST:
          if (
            win !== undefined && Number(wParam) === IMR_QUERYCHARPOSITION && this.#answerImeCharPosition(win, lParam)
          ) {
            return 1n;
          }
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

  #snapshotKeyboardState(): Uint8Array<ArrayBuffer> {
    const state = new Uint8Array(256) as Uint8Array<ArrayBuffer>;
    if (this.user32.symbols.GetKeyboardState(state)) return state;

    // GetKeyboardState can fail while a window is being created. Preserve a
    // useful modifier snapshot without manufacturing any printable key state.
    for (
      const virtualKey of [
        VK.SHIFT,
        VK.CONTROL,
        VK.MENU,
        VK.CAPITAL,
        VK.LSHIFT,
        VK.RSHIFT,
        VK.LCONTROL,
        VK.RCONTROL,
        VK.LMENU,
        VK.RMENU,
        VK.LWIN,
        VK.RWIN,
      ]
    ) {
      const keyState = this.user32.symbols.GetKeyState(virtualKey);
      if ((keyState & 0x8000) !== 0) state[virtualKey] |= 0x80;
      if ((keyState & 0x0001) !== 0) state[virtualKey] |= 0x01;
    }
    return state;
  }

  #currentModifiers() {
    const modifiers = keyboardModifiers(this.#snapshotKeyboardState());
    modifiers.altGraphKey = this.#layoutHasAltGraph(this.user32.symbols.GetKeyboardLayout(0)) && modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    return modifiers;
  }

  #toUnicodeAdapter(layout: Deno.PointerValue): ToUnicodeAdapter {
    return {
      toUnicode: (virtualKey, scanCode, keyboardState, flags) => {
        const output = new Uint16Array(16) as Uint16Array<ArrayBuffer>;
        const result = this.user32.symbols.ToUnicodeEx(
          virtualKey,
          scanCode,
          keyboardState,
          output,
          output.length,
          flags,
          layout,
        );
        const unitsWritten = result === 0 ? 0 : Math.min(output.length, Math.max(1, Math.abs(result)));
        let text = "";
        for (let index = 0; index < unitsWritten; index++) text += String.fromCharCode(output[index]);
        return { result, text };
      },
    };
  }

  #layoutHasAltGraph(layout: Deno.PointerValue): boolean {
    if (layout === null) return false;
    const layoutId = BigInt(Deno.UnsafePointer.value(layout));
    const cached = this.#altGraphLayouts.get(layoutId);
    if (cached !== undefined) return cached;

    const adapter = this.#toUnicodeAdapter(layout);
    const plainState = new Uint8Array(256);
    const altGraphState = new Uint8Array(256);
    for (const virtualKey of [VK.CONTROL, VK.LCONTROL, VK.MENU, VK.RMENU]) {
      altGraphState[virtualKey] = 0x80;
    }

    let hasAltGraph = false;
    for (let virtualKey = 0x20; virtualKey <= 0xfe; virtualKey++) {
      const plain = adapter.toUnicode(virtualKey, 0, plainState, TU_NO_STATE_CHANGE);
      const alternate = adapter.toUnicode(virtualKey, 0, altGraphState, TU_NO_STATE_CHANGE);
      if (alternate.result <= 0) continue;
      const alternateText = alternate.text.slice(0, alternate.result);
      const plainText = plain.result > 0 ? plain.text.slice(0, plain.result) : "";
      if (isCommitText(alternateText) && alternateText !== plainText) {
        hasAltGraph = true;
        break;
      }
    }
    this.#altGraphLayouts.set(layoutId, hasAltGraph);
    return hasAltGraph;
  }

  #keyMessageFromBuffer(buffer: ArrayBuffer): NativeKeyMessage | undefined {
    const view = new DataView(buffer);
    const message = view.getUint32(8, true);
    if (message !== WM.KEYDOWN && message !== WM.SYSKEYDOWN && message !== WM.KEYUP && message !== WM.SYSKEYUP) {
      return undefined;
    }
    return {
      windowId: view.getBigUint64(0, true),
      message,
      virtualKey: Number(view.getBigUint64(16, true)),
      lParam: view.getBigUint64(24, true),
      timestamp: view.getUint32(32, true),
    };
  }

  #peekNextKeyMessage(): NativeKeyMessage | undefined {
    const pointer = Deno.UnsafePointer.of(this.#peekMsg);
    if (!this.user32.symbols.PeekMessageW(pointer, null, WM.KEYDOWN, WM.UNICHAR, PM_NOREMOVE)) return undefined;
    return this.#keyMessageFromBuffer(this.#peekMsg);
  }

  #prepareKeyMessage(): void {
    this.#preparedKey = undefined;
    const message = this.#keyMessageFromBuffer(this.#msg);
    if (message === undefined) return;
    const win = this.windows.get(message.windowId);
    if (win === undefined) return;

    const type = message.message === WM.KEYDOWN || message.message === WM.SYSKEYDOWN ? "keydown" : "keyup";
    const state = this.#snapshotKeyboardState();
    const layout = this.user32.symbols.GetKeyboardLayout(0);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const stateForTranslation = Uint8Array.from(state);
    if (!layoutHasAltGraph) stateForTranslation[VK.RMENU] &= 0x7f;

    const translated = translateLogicalKey(
      message.virtualKey,
      message.lParam,
      stateForTranslation,
      this.#toUnicodeAdapter(layout),
    );
    const modifiers = keyboardModifiers(state);
    modifiers.altGraphKey = layoutHasAltGraph && modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;

    const code = getDomCode(message.lParam);
    let key = translated.key;
    if (code === "AltRight") key = modifiers.altGraphKey && layoutHasAltGraph ? "AltGraph" : "Alt";

    if (type === "keydown") {
      key = win.logicalKeys.get(message.virtualKey, message.lParam) ?? key;
      win.logicalKeys.remember(message.virtualKey, message.lParam, key);
      win.resultEcho.clear();
    } else {
      key = win.logicalKeys.release(message.virtualKey, message.lParam) ?? key;
    }

    const current = {
      phase: type === "keydown" ? "down" as const : "up" as const,
      virtualKey: message.virtualKey,
      lParam: message.lParam,
      timestamp: message.timestamp,
    };
    const nextMessage = type === "keydown" ? this.#peekNextKeyMessage() : undefined;
    const next = nextMessage === undefined || nextMessage.windowId !== message.windowId ? undefined : {
      phase: nextMessage.message === WM.KEYDOWN || nextMessage.message === WM.SYSKEYDOWN
        ? "down" as const
        : "up" as const,
      virtualKey: nextMessage.virtualKey,
      lParam: nextMessage.lParam,
      timestamp: nextMessage.timestamp,
    };
    const suppress = layoutHasAltGraph && win.altGraphControlFilter.shouldSuppress(current, next);
    this.#preparedKey = {
      suppress,
      event: {
        type,
        keycode: message.virtualKey,
        code,
        key,
        repeat: type === "keydown" && decodeKeyLParam(message.lParam).isRepeat,
        location: domKeyLocation(code),
        isComposing: win.isComposing,
        textInputHandled: isTextInputHandled(type, key, win.isComposing, modifiers),
        ...modifiers,
        window: win,
      },
    };
  }

  #takePreparedKey(
    win: Win32Window | undefined,
    type: "keydown" | "keyup",
    wParam: number | bigint,
    lParam: number | bigint,
  ): PreparedKeyEvent | undefined {
    const prepared = this.#preparedKey;
    this.#preparedKey = undefined;
    if (
      prepared !== undefined && prepared.event.type === type && prepared.event.keycode === Number(wParam) &&
      prepared.event.code === getDomCode(lParam)
    ) {
      return prepared;
    }
    if (win === undefined) return undefined;

    // Synchronous SendMessageW calls bypass event(), so retain a safe fallback
    // even though normal queued input is always prepared before TranslateMessage.
    const state = this.#snapshotKeyboardState();
    const layout = this.user32.symbols.GetKeyboardLayout(0);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const stateForTranslation = Uint8Array.from(state);
    if (!layoutHasAltGraph) stateForTranslation[VK.RMENU] &= 0x7f;
    const translated = translateLogicalKey(
      Number(wParam),
      lParam,
      stateForTranslation,
      this.#toUnicodeAdapter(layout),
    );
    const modifiers = keyboardModifiers(state);
    modifiers.altGraphKey = layoutHasAltGraph && modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    const code = getDomCode(lParam);
    let key = translated.key;
    if (code === "AltRight") key = modifiers.altGraphKey ? "AltGraph" : "Alt";
    if (type === "keydown") win.logicalKeys.remember(Number(wParam), lParam, key);
    else key = win.logicalKeys.release(Number(wParam), lParam) ?? key;
    return {
      suppress: false,
      event: {
        type,
        keycode: Number(wParam),
        code,
        key,
        repeat: type === "keydown" && decodeKeyLParam(lParam).isRepeat,
        location: domKeyLocation(code),
        isComposing: win.isComposing,
        textInputHandled: isTextInputHandled(type, key, win.isComposing, modifiers),
        ...modifiers,
        window: win,
      },
    };
  }

  #queueImeEdits(win: Win32Window, edits: ImeEdit[]): void {
    for (const edit of edits) {
      if (edit.type === "preedit") {
        win.preeditText = edit.text;
        win.preeditCursorRange = edit.text.length === 0 ? undefined : edit.cursorRange;
        this.#events.push({
          type: "ime",
          kind: "preedit",
          text: edit.text,
          ...(edit.cursorRange === undefined ? {} : { cursorRange: edit.cursorRange }),
          window: win,
        });
      } else if (edit.text.length > 0) {
        this.#events.push({ type: "ime", kind: "commit", text: edit.text, window: win });
      }
    }
  }

  #handleChar(win: Win32Window, wParam: number | bigint, lParam: number | bigint): void {
    const repeatCount = decodeKeyLParam(lParam).repeatCount;
    for (const decoded of win.charDecoder.push(wParam, repeatCount)) {
      if (win.resultEcho.consume(decoded.text, decoded.repeatCount)) continue;
      this.#queueImeEdits(win, win.imeReducer.update({ result: repeatedWmCharText(decoded) }));
    }
  }

  #flushCharDecoder(win: Win32Window): void {
    for (const decoded of win.charDecoder.flush()) {
      if (win.resultEcho.consume(decoded.text, decoded.repeatCount)) continue;
      this.#queueImeEdits(win, win.imeReducer.update({ result: repeatedWmCharText(decoded) }));
    }
  }

  #handleUniChar(win: Win32Window, codePoint: number, lParam: number | bigint): void {
    if (
      !Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) return;
    const text = String.fromCodePoint(codePoint);
    if (!isCommitText(text)) return;
    const repeatCount = Math.max(1, decodeKeyLParam(lParam).repeatCount);
    if (win.resultEcho.consume(text, repeatCount)) return;
    this.#queueImeEdits(win, win.imeReducer.update({ result: text.repeat(repeatCount) }));
  }

  #withImeContext<Result>(
    win: Win32Window,
    callback: (context: Deno.PointerObject) => Result,
  ): Result | undefined {
    return withImeContext(
      () => this.imm32.symbols.ImmGetContext(win.hwnd),
      (context) => {
        this.imm32.symbols.ImmReleaseContext(win.hwnd, context);
      },
      callback,
    );
  }

  #readCompositionString(context: Deno.PointerObject, index: number): string | undefined {
    return readImmUtf16({
      getCompositionString: (compositionIndex, buffer) =>
        this.imm32.symbols.ImmGetCompositionStringW(
          context,
          compositionIndex,
          buffer === undefined ? null : Deno.UnsafePointer.of(buffer),
          buffer?.byteLength ?? 0,
        ),
    }, index);
  }

  #handleImeComposition(
    win: Win32Window,
    wParam: number | bigint,
    lParam: number | bigint,
  ): boolean {
    const flags = Number(BigInt(lParam) & 0xffffffffn);
    if ((flags & IME_COMPOSITION_FLAGS) === 0) {
      this.#queueImeEdits(win, win.imeReducer.update({ preedit: null }));
      return true;
    }

    let insertedPreedit: { text: string; cursorRange?: readonly [number, number] } | undefined;
    if ((flags & CS_INSERTCHAR) !== 0 && (flags & GCS_COMPSTR) === 0) {
      const character = String.fromCharCode(Number(BigInt(wParam) & 0xffffn));
      if (isCommitText(character)) {
        insertedPreedit = insertCompositionCharacter(
          win.preeditText,
          win.preeditCursorRange,
          character,
          (flags & CS_NOMOVECARET) !== 0,
        );
      }
    }

    if ((flags & GCS_ALL) === 0) {
      if (insertedPreedit !== undefined) {
        win.isComposing = true;
        this.#queueImeEdits(win, win.imeReducer.update({ preedit: insertedPreedit }));
      }
      return true;
    }

    const update = this.#withImeContext(win, (context) => {
      let result: string | undefined;
      let preedit: { text: string; cursorRange?: readonly [number, number] } | null | undefined = insertedPreedit;

      if ((flags & GCS_RESULTSTR) !== 0) {
        result = this.#readCompositionString(context, GCS_RESULTSTR);
        if (result === undefined) return null;
      }

      if ((flags & GCS_COMPSTR) !== 0) {
        const text = this.#readCompositionString(context, GCS_COMPSTR);
        if (text === undefined) return null;
        // GCS_* lParam bits say which fields changed, not which current fields
        // may be queried. Always fetch the cursor with a replacement string so
        // a GCS_COMPSTR-only update cannot erase an otherwise valid caret.
        const cursorPosition = this.imm32.symbols.ImmGetCompositionStringW(context, GCS_CURSORPOS, null, 0);
        const cursorRange = cursorPosition < 0 ? undefined : utf16CursorRangeToUtf8(text, cursorPosition);
        preedit = text.length === 0 ? null : {
          text,
          ...(cursorRange === undefined ? {} : { cursorRange }),
        };
      } else if ((flags & GCS_CURSORPOS) !== 0 && win.preeditText.length > 0) {
        const cursorPosition = this.imm32.symbols.ImmGetCompositionStringW(context, GCS_CURSORPOS, null, 0);
        const cursorRange = cursorPosition < 0 ? undefined : utf16CursorRangeToUtf8(win.preeditText, cursorPosition);
        preedit = {
          text: win.preeditText,
          ...(cursorRange === undefined ? {} : { cursorRange }),
        };
      }

      return { result, preedit };
    });
    if (update === undefined || update === null) return false;

    if (update.result !== undefined && update.result.length > 0) win.resultEcho.expect(update.result);
    if (update.preedit !== undefined && update.preedit !== null) win.isComposing = true;
    this.#queueImeEdits(win, win.imeReducer.update(update));
    return true;
  }

  #setImeActive(win: Win32Window, active: boolean): void {
    if (win.imeActive === active) return;
    win.imeActive = active;
    this.#events.push({ type: "ime", kind: active ? "enabled" : "disabled", window: win });
  }

  #activateIme(win: Win32Window): void {
    if (!win.imeAllowed || !win.focused) return;
    if (!this.imm32.symbols.ImmAssociateContextEx(win.hwnd, null, IACE_DEFAULT)) return;
    this.#setImeActive(win, true);
    this.#applyImeCursorArea(win);
  }

  #cancelComposition(win: Win32Window): void {
    if (win.isComposing) {
      this.#withImeContext(win, (context) => {
        this.imm32.symbols.ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
      });
    }
    this.#flushCharDecoder(win);
    this.#queueImeEdits(win, win.imeReducer.end());
    win.isComposing = false;
    win.preeditText = "";
    win.preeditCursorRange = undefined;
    win.resultEcho.clear();
  }

  initializeWindowInput(win: Win32Window): void {
    // Match winit/Blitz's opt-in IME model. Keyboard-layout WM_CHAR input does
    // not require an associated IMM context, while composition is enabled only
    // once the focused document asks for it.
    this.imm32.symbols.ImmAssociateContextEx(win.hwnd, null, 0);
  }

  setWindowImeEnabled(win: Win32Window, enabled: boolean): void {
    if (win.imeAllowed === enabled) {
      if (enabled && win.focused && !win.imeActive) this.#activateIme(win);
      return;
    }
    win.imeAllowed = enabled;
    if (enabled) {
      this.#activateIme(win);
      return;
    }

    this.#cancelComposition(win);
    this.imm32.symbols.ImmAssociateContextEx(win.hwnd, null, 0);
    this.#setImeActive(win, false);
  }

  closeWindowInput(win: Win32Window): void {
    if (win.isComposing) {
      this.#withImeContext(win, (context) => {
        this.imm32.symbols.ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
      });
    }
    this.imm32.symbols.ImmAssociateContextEx(win.hwnd, null, 0);
    win.imeReducer.reset();
    win.charDecoder.reset();
    win.resultEcho.clear();
    win.logicalKeys.clear();
    win.altGraphControlFilter.reset();
    win.imeActive = false;
    win.imeAllowed = false;
    win.isComposing = false;
    win.preeditText = "";
    win.preeditCursorRange = undefined;
  }

  updateWindowImeCursorArea(win: Win32Window): void {
    if (win.imeActive) this.#applyImeCursorArea(win);
  }

  #applyImeCursorArea(win: Win32Window): void {
    const rectangle = win.imeCursorRectangle;
    if (rectangle === undefined) return;
    this.#withImeContext(win, (context) => {
      this.imm32.symbols.ImmSetCandidateWindow(context, encodeCandidateForm(rectangle));
      this.imm32.symbols.ImmSetCompositionWindow(context, encodeCompositionForm(rectangle));
    });
  }

  #clientPointToScreen(win: Win32Window, x: number, y: number): { x: number; y: number } | undefined {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setInt32(0, x, true);
    view.setInt32(4, y, true);
    if (!this.user32.symbols.ClientToScreen(win.hwnd, buffer)) return undefined;
    return { x: view.getInt32(0, true), y: view.getInt32(4, true) };
  }

  #clientRectToScreen(win: Win32Window, rectangle: CursorRectangle): CursorRectangle | undefined {
    const topLeft = this.#clientPointToScreen(win, rectangle.x, rectangle.y);
    const bottomRight = this.#clientPointToScreen(
      win,
      rectangle.x + rectangle.width,
      rectangle.y + rectangle.height,
    );
    if (topLeft === undefined || bottomRight === undefined) return undefined;
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: Math.max(0, bottomRight.x - topLeft.x),
      height: Math.max(0, bottomRight.y - topLeft.y),
    };
  }

  #screenDocumentRectangle(win: Win32Window): CursorRectangle | undefined {
    const buffer = new ArrayBuffer(16);
    if (!this.user32.symbols.GetClientRect(win.hwnd, buffer)) return undefined;
    const view = new DataView(buffer);
    return this.#clientRectToScreen(win, {
      x: view.getInt32(0, true),
      y: view.getInt32(4, true),
      width: Math.max(0, view.getInt32(8, true) - view.getInt32(0, true)),
      height: Math.max(0, view.getInt32(12, true) - view.getInt32(4, true)),
    });
  }

  #answerImeCharPosition(win: Win32Window, lParam: number | bigint): boolean {
    const address = BigInt(lParam);
    if (address === 0n || win.imeCursorRectangle === undefined) return false;
    const pointer = Deno.UnsafePointer.create(address);
    if (pointer === null) return false;
    const target = new Deno.UnsafePointerView(pointer).getArrayBuffer(IMECHARPOSITION_SIZE);
    const targetView = new DataView(target);
    if (targetView.getUint32(0, true) < IMECHARPOSITION_SIZE) return false;

    const caret = this.#clientRectToScreen(win, win.imeCursorRectangle);
    const document = this.#screenDocumentRectangle(win);
    if (caret === undefined || document === undefined) return false;
    const response = encodeImeCharPosition(targetView.getUint32(4, true), caret, document);
    new Uint8Array(target).set(new Uint8Array(response));
    return true;
  }

  readonly windows = new Map<bigint, Win32Window>();
  openWindow(_x = 0, _y = 0, _w = 800, _h = 600): Win32Window {
    if (this.#closed) throw new Error("winding(win32): library is closed");
    return new Win32Window(this, this.#classNameBuffer);
  }
  #msg = new ArrayBuffer(48);
  #peekMsg = new ArrayBuffer(48);
  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
    const queued = this.#events.shift();
    if (queued !== undefined) return queued as UIEvent;

    const ptr = Deno.UnsafePointer.of(this.#msg);
    while (this.#events.length === 0 && this.user32.symbols.PeekMessageW(ptr, null, 0, 0, PM_REMOVE)) {
      this.#prepareKeyMessage();
      try {
        this.user32.symbols.TranslateMessage(ptr);
        this.user32.symbols.DispatchMessageW(ptr);
      } finally {
        this.#preparedKey = undefined;
      }
    }
    return this.#events.shift() as UIEvent | undefined;
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
    for (const win of [...this.windows.values()]) win.close();
    if (!this.user32.symbols.UnregisterClassW(this.#classNameBuffer, this.#instance)) {
      throw new Error(this.getLastError());
    }
    this.#closed = true;
    this.#wndProc.close();
    this.imm32.close();
    this.gdi32.close();
    this.user32.close();
    this.kernel32.close();
  }
}

export const load: LoadLibrary = () => new Win32Library();
