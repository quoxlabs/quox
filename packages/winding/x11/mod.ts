import type {
  KeyDownEvent,
  KeyUpEvent,
  Library,
  LoadLibrary,
  MouseButton,
  PointerModifiers,
  UIEvent,
  Window,
} from "../types.ts";
import {
  ClickCounter,
  createImeActivationEvent,
  createImeCommitEvent,
  createImeDeleteSurroundingEvent,
  createImePreeditEvent,
  createKeyDownEvent,
  createKeyUpEvent,
  EventQueue,
  NativeEventClock,
  normalizeKeyboardText,
  PressedLogicalKeyCache,
} from "../input/mod.ts";
import { domCodeFromXkbName, keyLocationHintForKeysym } from "../linux/mod.ts";
import { utf8Bytes, utf8CString as cString } from "../text_encoding.ts";
import { libcFunctions, NotifyInferior, NotifyNormal, x11functions, XEventMask, XEventType } from "./ffi.ts";
import {
  isAutoRepeatPair,
  isTopLevelFocusTransition,
  x11CommittedText,
  x11KeyEditDisposition,
  type X11ModifierMapping,
  x11ModifierSnapshot,
  X11PointerButtonState,
  x11ScreenPosition,
} from "./input.ts";
import { NativeXImage } from "./native_image.ts";
import { XimContext, XimManager } from "./xim.ts";

// XStoreName sets the legacy WM_NAME property, which is read as Latin-1 by clients that don't
// understand the EWMH _NET_WM_NAME/UTF8_STRING property set below. Encoding it as UTF-8 there
// would corrupt non-ASCII titles for those clients, so approximate as Latin-1 instead.
function latin1CString(s: string): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(s.length + 1) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    buf[i] = code <= 0xff ? code : 0x3f; // '?' for characters outside Latin-1
  }
  return buf;
}

// Select only events routed by this backend. In particular, redirect and child
// notification masks would make this window responsible for managing XIM or
// embedded child windows even though it has no window-manager implementation.
const APPLICATION_X_EVENT_MASKS = BigInt(
  XEventMask.KeyPressMask |
    XEventMask.KeyReleaseMask |
    XEventMask.ButtonPressMask |
    XEventMask.ButtonReleaseMask |
    XEventMask.EnterWindowMask |
    XEventMask.LeaveWindowMask |
    XEventMask.PointerMotionMask |
    XEventMask.ExposureMask |
    XEventMask.StructureNotifyMask |
    XEventMask.FocusChangeMask,
);
const X_SHIFT_MASK = 1 << 0;
const X_CONTROL_MASK = 1 << 2;
const XK_CAPS_LOCK = 0xffe5n;
const XK_SCROLL_LOCK = 0xff14n;
const XK_NUM_LOCK = 0xff7fn;
const XK_ALT_L = 0xffe9n;
const XK_ALT_R = 0xffean;
const XK_META_L = 0xffe7n;
const XK_META_R = 0xffe8n;
const XK_SUPER_L = 0xffebn;
const XK_SUPER_R = 0xffecn;
const XK_MODE_SWITCH = 0xff7en;
const XK_ISO_LEVEL3_SHIFT = 0xfe03n;
const XK_ISO_LEVEL5_SHIFT = 0xfe11n;
const XF86XK_FN = 0x100811d0n;
const XKB_USE_CORE_KBD = 0x0100;
const XKB_KEY_NAMES_MASK = 1 << 9;
const XKB_ALL_COMPONENTS_MASK = 0x7f;
const X_ERROR_HANDLER_DEFINITION = {
  parameters: ["pointer", "pointer"],
  result: "i32",
} as const;

export function validateX11Geometry(x: number, y: number, width: number, height: number): void {
  if (
    !Number.isInteger(x) || !Number.isInteger(y) || x < -0x8000 || x > 0x7fff || y < -0x8000 || y > 0x7fff
  ) {
    throw new RangeError("winding(x11): window position must fit X11 signed 16-bit coordinates");
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 || width > 0xffff || height > 0xffff
  ) {
    throw new RangeError("winding(x11): window dimensions must be positive X11 16-bit integers");
  }
}

class X11Window implements Window {
  readonly id: bigint;
  readonly input: XimContext;
  readonly pressedKeys = new PressedLogicalKeyCache<number>();
  readonly pointerButtons = new X11PointerButtonState();
  readonly #gc: Deno.PointerObject;
  #image: NativeXImage;
  #width: number;
  #height: number;
  #visible = false;
  #closed = false;

  constructor(readonly lib: X11Library, x = 0, y = 0, w = 800, h = 600) {
    const parent = BigInt(lib.X11.symbols.XRootWindowOfScreen(lib.screen));
    const white_pixel = BigInt(lib.X11.symbols.XWhitePixelOfScreen(lib.screen));
    const black_pixel = BigInt(lib.X11.symbols.XBlackPixelOfScreen(lib.screen));

    const window = lib.X11.symbols.XCreateSimpleWindow(
      lib.display,
      parent,
      x,
      y,
      w,
      h,
      0,
      black_pixel,
      white_pixel,
    );
    if (BigInt(window) === 0n) throw new Error("winding(x11): failed to create window");

    // Set background_pixmap = None so the X server does not clear the window
    // to a solid colour on every resize (which causes white flicker).
    const CW_BACK_PIXMAP = 1n; // bit 0
    const attrs = new BigUint64Array([0n]); // None pixmap
    lib.X11.symbols.XChangeWindowAttributes(lib.display, window, CW_BACK_PIXMAP, attrs);

    lib.X11.symbols.XSelectInput(lib.display, window, APPLICATION_X_EVENT_MASKS);

    // Ask the window manager to send WM_DELETE_WINDOW via ClientMessage instead
    // of forcibly killing the process when the user closes the window.
    if (lib.wmProtocols && lib.wmDeleteWindow) {
      const protocolsBuf = new BigUint64Array([lib.wmDeleteWindow]);
      if (lib.X11.symbols.XSetWMProtocols(lib.display, window, protocolsBuf, 1) === 0) {
        lib.X11.symbols.XDestroyWindow(lib.display, window);
        lib.X11.symbols.XFlush(lib.display);
        throw new Error("winding(x11): failed to register WM_DELETE_WINDOW");
      }
    }

    this.id = BigInt(window);
    this.#width = w;
    this.#height = h;

    const gc = lib.X11.symbols.XCreateGC(lib.display, window, 0n, null);
    if (gc === null) {
      lib.X11.symbols.XDestroyWindow(lib.display, window);
      lib.X11.symbols.XFlush(lib.display);
      throw new Error("winding(x11): failed to create graphics context");
    }
    this.#gc = gc;
    try {
      const visual = lib.X11.symbols.XDefaultVisualOfScreen(lib.screen);
      if (visual === null) throw new Error("winding(x11): failed to get default visual");
      const depth = lib.X11.symbols.XDefaultDepthOfScreen(lib.screen);
      this.#image = new NativeXImage(
        lib.X11.symbols,
        lib.libc.symbols,
        lib.display,
        visual,
        depth,
        w,
        h,
      );

      lib.windows.set(this.id, this);
      let input: XimContext | undefined;
      try {
        input = lib.input.createContext(this.id);
        this.input = input;
        // Publish only after every fallible local and XIM resource exists.
        lib.X11.symbols.XMapWindow(lib.display, window);
        lib.X11.symbols.XFlush(lib.display);
        this.#visible = true;
      } catch (error) {
        lib.windows.delete(this.id);
        input?.close();
        this.#image.close();
        throw error;
      }
    } catch (error) {
      lib.X11.symbols.XFreeGC(lib.display, gc);
      lib.X11.symbols.XDestroyWindow(lib.display, window);
      lib.X11.symbols.XFlush(lib.display);
      throw error;
    }
  }

  setImeEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.input.setEnabled(enabled);
    this.lib.syncAndCheck();
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.#assertOpen();
    this.input.setCursorArea(x, y, width, height);
    this.lib.syncAndCheck();
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    this.#assertOpen();
    this.input.setSurroundingText(text, selectionStartBytes, selectionEndBytes);
  }

  setTitle(title: string): void {
    this.#assertOpen();
    const normalizedTitle = title.replaceAll("\0", "�");
    const titleBytes = utf8Bytes(normalizedTitle);
    if (titleBytes.length > this.lib.maxTitleBytes) {
      throw new RangeError(`winding(x11): title exceeds ${this.lib.maxTitleBytes} UTF-8 bytes`);
    }
    const titleBuffer = titleBytes.length > 0 ? titleBytes : new Uint8Array(1);
    this.lib.X11.symbols.XChangeProperty(
      this.lib.display,
      this.id,
      this.lib.netWmName,
      this.lib.utf8String,
      8,
      0,
      titleBuffer,
      titleBytes.length,
    );
    this.lib.X11.symbols.XStoreName(this.lib.display, this.id, latin1CString(normalizedTitle));
    this.lib.syncAndCheck();
  }

  /**
   * Copy an RGBA pixel buffer to the X11 window. The buffer must be
   * `width * height * 4` bytes. Internally converts to the default visual's
   * advertised TrueColor layout before blitting.
   *
   * If the dimensions differ from the last blit, the XImage is recreated to
   * match the new size.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    this.#assertOpen();
    if (rgba.byteLength !== width * height * 4) {
      throw new RangeError("winding(x11): RGBA buffer size does not match its dimensions");
    }
    if (width !== this.#width || height !== this.#height) {
      throw new RangeError(
        `winding(x11): ${width}x${height} frame does not match ${this.#width}x${this.#height} window`,
      );
    }
    this.#image.write(rgba);
    this.reblit();
  }

  /**
   * Re-issue the last blitted frame to the drawable without touching `#imageBuf`. Used to
   * respond to an `Expose` event (the window manager/compositor asking us to repaint a
   * region, e.g. after being uncovered) — the pixels haven't changed, only the drawable
   * needs the same bytes reapplied.
   */
  reblit(): void {
    this.#assertOpen();
    this.lib.X11.symbols.XPutImage(
      this.lib.display,
      this.id,
      this.#gc,
      this.#image.pointer,
      0,
      0,
      0,
      0,
      this.#width,
      this.#height,
    );
    this.lib.syncAndCheck();
  }

  updateSize(width: number, height: number): boolean {
    this.#assertOpen();
    if (width === this.#width && height === this.#height) return false;
    const image = this.#createImage(width, height);
    this.#image.close();
    this.#image = image;
    this.#width = width;
    this.#height = height;
    return true;
  }

  updateVisibility(visible: boolean): boolean {
    if (visible === this.#visible) return false;
    this.#visible = visible;
    return true;
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseNativeResources(true);
  }

  handleNativeDestroy(): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    this.#releaseNativeResources(false);
    return true;
  }

  handleDisplayLoss(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.lib.unregisterWindow(this);
    this.pressedKeys.clear();
    // XImage destruction is client-local. GC/window destruction would write
    // to the dead display and must deliberately be abandoned.
    this.#image.close();
    this.input.close();
  }

  #releaseNativeResources(destroyWindow: boolean): void {
    this.lib.unregisterWindow(this);
    const errors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    cleanup(() => this.input.close());
    this.pressedKeys.clear();
    cleanup(() => this.#image.close());
    cleanup(() => {
      this.lib.X11.symbols.XFreeGC(this.lib.display, this.#gc);
    });
    if (destroyWindow) {
      cleanup(() => {
        this.lib.X11.symbols.XDestroyWindow(this.lib.display, this.id);
        this.lib.X11.symbols.XFlush(this.lib.display);
      });
    } else cleanup(() => this.lib.X11.symbols.XFlush(this.lib.display));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(x11): errors while closing window");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("winding(x11): window is closed");
  }

  #createImage(width: number, height: number): NativeXImage {
    const visual = this.lib.X11.symbols.XDefaultVisualOfScreen(this.lib.screen);
    if (visual === null) throw new Error("winding(x11): failed to get default visual");
    return new NativeXImage(
      this.lib.X11.symbols,
      this.lib.libc.symbols,
      this.lib.display,
      visual,
      this.lib.X11.symbols.XDefaultDepthOfScreen(this.lib.screen),
      width,
      height,
    );
  }
}

function openX11Library(): Deno.DynamicLibrary<typeof x11functions> {
  let library: Deno.DynamicLibrary<typeof x11functions>;
  try {
    library = Deno.dlopen("libX11.so.6", x11functions);
  } catch (versionedError) {
    try {
      library = Deno.dlopen("libX11.so", x11functions);
    } catch {
      throw versionedError;
    }
  }
  if (library.symbols.XInitThreads() === 0) {
    library.close();
    throw new Error("winding(x11): Xlib could not initialize thread safety");
  }
  return library;
}

let libraryActive = false;

export function supportsX11Abi(os: string, arch: string, littleEndian: boolean): boolean {
  return os === "linux" && (arch === "x86_64" || arch === "aarch64") && littleEndian;
}

function assertSupportedX11Abi(): void {
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (!supportsX11Abi(Deno.build.os, Deno.build.arch, littleEndian)) {
    throw new Error("winding(x11): requires 64-bit little-endian Linux on x86-64 or AArch64");
  }
}

function assertMainIsolate(): void {
  const constructorName = (globalThis as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (constructorName.includes("Worker")) {
    throw new Error("winding(x11): the library must be created on the main thread, not a Worker");
  }
}

class X11Library implements Library {
  readonly X11: Deno.DynamicLibrary<typeof x11functions>;
  readonly libc: Deno.DynamicLibrary<typeof libcFunctions>;
  readonly display: Deno.PointerObject;
  readonly screen: Deno.PointerObject;
  readonly windows = new Map<bigint, X11Window>();
  readonly wmProtocols: bigint;
  readonly wmDeleteWindow: bigint;
  readonly netWmName: bigint;
  readonly utf8String: bigint;
  readonly maxTitleBytes: number;
  readonly input: XimManager;
  readonly #events = new EventQueue<UIEvent>();
  readonly #eventClock = new NativeEventClock(2 ** 32);
  readonly #clickCounter = new ClickCounter<MouseButton>();
  #modifierMapping: X11ModifierMapping = {
    shiftMask: X_SHIFT_MASK,
    controlMask: X_CONTROL_MASK,
    altMask: 0,
    metaMask: 0,
    capsLockMask: 0,
    altGraphMask: 0,
    fnMask: 0,
    numLockMask: 0,
    scrollLockMask: 0,
    maskByKeycode: new Map(),
    toggleKeycodes: new Set(),
  };
  #domCodes = new Map<number, string>();
  #detectableAutoRepeat = false;
  #errorCallback: Deno.UnsafeCallback<typeof X_ERROR_HANDLER_DEFINITION> | undefined;
  #previousErrorHandler: Deno.PointerValue = null;
  #pendingProtocolError: Error | undefined;
  #closed = false;
  constructor() {
    this.X11 = openX11Library();
    try {
      this.libc = Deno.dlopen("libc.so.6", libcFunctions);
    } catch (error) {
      this.X11.close();
      throw new Error("winding(x11): this build requires glibc (libc.so.6)", { cause: error });
    }
    const display = this.X11.symbols.XOpenDisplay(null);
    if (display == null) {
      this.libc.close();
      this.X11.close();
      throw new Error("winding(x11): failed to open display");
    }
    this.display = display;
    const screen = this.X11.symbols.XDefaultScreenOfDisplay(display);
    if (screen == null) {
      this.X11.symbols.XCloseDisplay(display);
      this.libc.close();
      this.X11.close();
      throw new Error("winding(x11): failed to get default screen");
    }
    this.screen = screen;
    this.maxTitleBytes = Math.max(0, Number(this.X11.symbols.XMaxRequestSize(display)) * 4 - 256);
    this.wmProtocols = BigInt(this.X11.symbols.XInternAtom(display, cString("WM_PROTOCOLS"), 0));
    this.wmDeleteWindow = BigInt(
      this.X11.symbols.XInternAtom(display, cString("WM_DELETE_WINDOW"), 0),
    );
    this.netWmName = BigInt(this.X11.symbols.XInternAtom(display, cString("_NET_WM_NAME"), 0));
    this.utf8String = BigInt(this.X11.symbols.XInternAtom(display, cString("UTF8_STRING"), 0));
    this.#refreshModifierMapping();
    this.#refreshDomCodes();
    const detectable = new Int32Array(1);
    this.#detectableAutoRepeat = this.X11.symbols.XkbSetDetectableAutoRepeat(display, 1, detectable) !== 0 &&
      detectable[0] !== 0;
    try {
      this.input = new XimManager(
        this.X11,
        display,
        this.libc,
        (windowId, event) => {
          const window = this.windows.get(windowId);
          if (window === undefined) return;
          switch (event.kind) {
            case "enabled":
            case "disabled":
              this.#events.push(createImeActivationEvent(window, event.kind));
              return;
            case "preedit":
              this.#events.push(createImePreeditEvent(window, event.text, event.cursorRange));
              return;
            case "commit": {
              const commit = createImeCommitEvent(window, event.text);
              if (commit !== undefined) this.#events.push(commit);
              return;
            }
            case "deleteSurrounding": {
              const deletion = createImeDeleteSurroundingEvent(window, event.beforeBytes, event.afterBytes);
              if (deletion !== undefined) this.#events.push(deletion);
              return;
            }
            case "replace":
              this.#events.push({ ...event, window });
              return;
            default:
              assertNever(event);
          }
        },
        (windowId, extraMask) => {
          this.X11.symbols.XSelectInput(this.display, windowId, APPLICATION_X_EVENT_MASKS | extraMask);
        },
      );
    } catch (error) {
      this.X11.symbols.XCloseDisplay(display);
      this.libc.close();
      this.X11.close();
      throw error;
    }
    try {
      this.#installErrorHandler();
    } catch (error) {
      try {
        this.input.close();
      } finally {
        this.X11.symbols.XCloseDisplay(display);
        this.libc.close();
        this.X11.close();
      }
      throw error;
    }
  }
  openWindow(x = 0, y = 0, w = 800, h = 600): X11Window {
    if (this.#closed) throw new Error("winding(x11): library is closed");
    this.#ensureDisplayConnection();
    this.#throwIfProtocolFailed();
    validateX11Geometry(x, y, w, h);
    const window = new X11Window(this, x, y, w, h);
    this.syncAndCheck();
    return window;
  }

  unregisterWindow(window: X11Window): void {
    if (this.windows.get(window.id) !== window) return;
    this.windows.delete(window.id);
    this.#events.purgeWindow(window);
  }
  syncAndCheck(): void {
    if (this.#closed) throw new Error("winding(x11): library is closed");
    this.#ensureDisplayConnection();
    this.X11.symbols.XSync(this.display, 0);
    this.#throwIfProtocolFailed();
  }
  #event = new ArrayBuffer(192);
  #peekEvent = new ArrayBuffer(192);
  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
    this.#ensureDisplayConnection();
    this.#processInternalConnections();
    this.#throwIfProtocolFailed();
    this.input.processDeferred();
    this.input.throwIfCallbackFailed();
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;

    const view = new DataView(this.#event);
    const eventPointer = Deno.UnsafePointer.of(this.#event)!;
    // Keep consuming X11 events until we find one we handle or the queue is empty.
    // Returning undefined for unhandled types and immediately surfacing it to the
    // caller would stop the outer while-loop in #tick, causing subsequent handled
    // events (e.g. ConfigureNotify after a ReparentNotify) to be delayed by a
    // full tick.
    while (true) {
      const pending = this.X11.symbols.XPending(this.display);
      this.#throwIfProtocolFailed();
      if (pending === 0) break;
      this.X11.symbols.XNextEvent(
        this.display,
        eventPointer,
      );
      this.#throwIfProtocolFailed();

      const type = view.getInt32(0, true);
      // XConfigureEvent distinguishes the event recipient from the drawable
      // whose geometry changed; all other routed events use XAnyEvent.window.
      const structureEvent = type === XEventType.ConfigureNotify || type === XEventType.DestroyNotify ||
        type === XEventType.MapNotify || type === XEventType.UnmapNotify;
      const windowId = structureEvent ? view.getBigUint64(40, true) : view.getBigUint64(32, true);
      const window = this.windows.get(windowId);

      const routedKey = (type === XEventType.KeyPress || type === XEventType.KeyRelease) && window !== undefined;
      if (!routedKey) {
        const filtered = this.input.filterEvent(eventPointer);
        this.input.throwIfCallbackFailed();
        if (filtered) {
          const imeEvent = this.#events.shift();
          if (imeEvent !== undefined) return imeEvent;
          continue;
        }
      }

      if (type === XEventType.MappingNotify) {
        this.X11.symbols.XRefreshKeyboardMapping(eventPointer);
        this.#refreshModifierMapping();
        this.#refreshDomCodes();
        continue;
      }

      if ((type === XEventType.KeyPress || type === XEventType.KeyRelease) && window !== undefined) {
        const state = view.getUint32(80, true);
        const keycode = view.getUint32(84, true);
        const code = this.#domCodes.get(keycode) ?? "Unidentified";
        const modifiers = x11ModifierSnapshot(
          state,
          keycode,
          type === XEventType.KeyPress,
          this.#modifierMapping,
        );
        const wasComposing = window.input.composing;
        let lookupStaged = type === XEventType.KeyPress;
        if (lookupStaged) window.input.beginLookup();
        try {
          const filtered = this.input.filterEvent(eventPointer);
          this.input.throwIfCallbackFailed();
          if (filtered) {
            if (keycode === 0) {
              if (lookupStaged) {
                window.input.finishLookup();
                lookupStaged = false;
              }
              const imeEvent = this.#events.shift();
              if (imeEvent !== undefined) return imeEvent;
              continue;
            }
            let keyEvent: KeyDownEvent | KeyUpEvent;
            if (type === XEventType.KeyPress) {
              const repeat = window.pressedKeys.has(keycode);
              const key = window.pressedKeys.press(keycode, "Process");
              keyEvent = createKeyDownEvent({
                keycode,
                code,
                key,
                repeat,
                isComposing: wasComposing,
                editDisposition: "text-input",
                ...modifiers,
                window,
              });
            } else {
              keyEvent = createKeyUpEvent({
                keycode,
                code,
                key: window.pressedKeys.release(keycode),
                isComposing: wasComposing,
                ...modifiers,
                window,
              });
            }
            if (lookupStaged) {
              window.input.finishLookup();
              lookupStaged = false;
            }
            // Xlib owns native dispatch for a filtered event, but the browser-
            // style wrapper still exposes the physical transition first.
            this.#events.prepend(keyEvent);
            return this.#events.shift();
          }

          // XIM reserves keycode zero as a synthetic notice that lookup data is
          // ready. It has no physical key and normally has no matching release.
          if (keycode === 0) {
            if (type === XEventType.KeyPress) {
              const lookup = this.input.lookup(window.input, eventPointer);
              this.input.throwIfCallbackFailed();
              const text = normalizeKeyboardText(lookup.text ?? "");
              if (text !== undefined) window.input.commit(text);
            }
            if (lookupStaged) {
              window.input.finishLookup();
              lookupStaged = false;
            }
            const imeEvent = this.#events.shift();
            if (imeEvent !== undefined) return imeEvent;
            continue;
          }

          if (type === XEventType.KeyRelease) {
            if (this.#isAutoRepeatRelease(view)) continue;
            const lookup = this.input.lookupKey(eventPointer);
            const key = window.pressedKeys.release(keycode, lookup.key);
            const event: KeyUpEvent = createKeyUpEvent({
              keycode,
              code,
              key,
              location: keyLocationHintForKeysym(lookup.keysym),
              isComposing: window.input.composing,
              ...modifiers,
              window,
            });
            return event;
          }

          const lookup = this.input.lookup(window.input, eventPointer);
          this.input.throwIfCallbackFailed();
          const repeat = window.pressedKeys.has(keycode);
          const key = window.pressedKeys.press(keycode, lookup.key);
          const text = x11CommittedText(
            normalizeKeyboardText(lookup.text ?? ""),
            modifiers,
            wasComposing,
            window.input.composing,
            window.input.hasStagedEvents,
          );
          const event: KeyDownEvent = createKeyDownEvent({
            keycode,
            code,
            key,
            location: keyLocationHintForKeysym(lookup.keysym),
            repeat,
            isComposing: wasComposing,
            editDisposition: x11KeyEditDisposition(
              key,
              text !== undefined,
              wasComposing,
              window.input.composing,
              window.input.hasStagedEvents,
            ),
            ...modifiers,
            window,
          });

          // Xutf8LookupString may invoke XIM callbacks synchronously. The native
          // transition's keydown must remain observably ahead of those semantic
          // events, and committed text remains exclusively in the commit event.
          this.#events.prepend(event);
          if (text !== undefined) window.input.commit(text);
          return this.#events.shift();
        } finally {
          if (lookupStaged) window.input.finishLookup();
        }
      }

      if ((type === XEventType.FocusIn || type === XEventType.FocusOut) && window !== undefined) {
        if (!isTopLevelFocusTransition(view.getInt32(40, true), view.getInt32(44, true))) continue;
        if (type === XEventType.FocusIn) {
          if (!window.input.setNativeFocused(true)) continue;
          return { type: "focus", window };
        }
        if (!window.input.setNativeFocused(false)) continue;
        window.pressedKeys.clear();
        const imeEvent = this.#events.shift();
        if (imeEvent !== undefined) {
          this.#events.push({ type: "blur", window });
          return imeEvent;
        }
        return { type: "blur", window };
      }

      // Expose is a pure repaint request (e.g. the window was uncovered) — the pixels
      // haven't changed, so self-heal by re-blitting the last frame directly rather than
      // surfacing a UIEvent for it.
      if (type === XEventType.Expose) {
        window?.reblit();
        continue;
      }

      if (type === XEventType.ConfigureNotify && window !== undefined) {
        const width = view.getInt32(56, true);
        const height = view.getInt32(60, true);
        if (!window.updateSize(width, height)) continue;
        return {
          type: "resize",
          width,
          height,
          framebufferWidth: width,
          framebufferHeight: height,
          devicePixelRatio: 1,
          window,
        };
      }
      if (type === XEventType.DestroyNotify && window !== undefined) {
        if (!window.handleNativeDestroy()) continue;
        return { type: "close", window };
      }

      const event = importEvent(
        view,
        window,
        this.#eventClock,
        this.#clickCounter,
        this.#modifierMapping,
        this.wmProtocols,
        this.wmDeleteWindow,
      );
      if (event !== undefined) return event;
    }
    return undefined;
  }
  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
    const errors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const window of [...this.windows.values()]) cleanup(() => window.close());
    cleanup(() => this.input.close());
    cleanup(() => this.input.throwIfCallbackFailed());
    cleanup(() => {
      this.X11.symbols.XCloseDisplay(this.display);
    });
    cleanup(() => this.input.afterDisplayClosed());
    cleanup(() => this.#restoreErrorHandler());
    cleanup(() => this.X11.close());
    cleanup(() => this.libc.close());
    libraryActive = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(x11): errors while closing library");
    }
  }

  #installErrorHandler(): void {
    const callback = new Deno.UnsafeCallback(
      X_ERROR_HANDLER_DEFINITION,
      (_display, nativeEvent) => {
        try {
          if (nativeEvent === null) {
            this.#pendingProtocolError ??= new Error("winding(x11): unknown X protocol error");
            return 0;
          }
          const event = new Deno.UnsafePointerView(nativeEvent);
          const resource = event.getBigUint64(16);
          const serial = event.getBigUint64(24);
          const code = event.getUint8(32);
          const request = event.getUint8(33);
          const minor = event.getUint8(34);
          this.#pendingProtocolError ??= new Error(
            `winding(x11): protocol error ${code} in request ${request}.${minor} ` +
              `(resource ${resource}, serial ${serial})`,
          );
        } catch {
          this.#pendingProtocolError ??= new Error("winding(x11): malformed X protocol error");
        }
        return 0;
      },
    );
    this.#previousErrorHandler = this.X11.symbols.XSetErrorHandler(callback.pointer);
    this.#errorCallback = callback;
  }

  #restoreErrorHandler(): void {
    const callback = this.#errorCallback;
    if (callback === undefined) return;
    this.#errorCallback = undefined;
    this.X11.symbols.XSetErrorHandler(this.#previousErrorHandler);
    callback.close();
  }

  #throwIfProtocolFailed(): void {
    const error = this.#pendingProtocolError;
    if (error === undefined) return;
    this.#pendingProtocolError = undefined;
    try {
      this.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "winding(x11): protocol failure during cleanup");
    }
    throw error;
  }

  #ensureDisplayConnection(): void {
    const pollBuffer = new ArrayBuffer(8);
    const pollView = new DataView(pollBuffer);
    pollView.setInt32(0, this.X11.symbols.XConnectionNumber(this.display), true);
    pollView.setInt16(4, 0x19, true); // POLLIN | POLLERR | POLLHUP
    if (this.libc.symbols.poll(pollBuffer, 1n, 0) < 0) return;
    if ((pollView.getInt16(6, true) & 0x38) === 0) return; // POLLERR | POLLHUP | POLLNVAL
    const error = new Error("winding(x11): display connection was closed");
    const cleanupErrors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    };
    this.#closed = true;
    this.#events.close();
    cleanup(() => this.input.abandonDisplay());
    for (const window of [...this.windows.values()]) cleanup(() => window.handleDisplayLoss());
    cleanup(() => this.#restoreErrorHandler());
    cleanup(() => this.X11.close());
    cleanup(() => this.libc.close());
    libraryActive = false;
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "winding(x11): display loss cleanup failed");
    }
    throw error;
  }

  #refreshModifierMapping(): void {
    const native = this.X11.symbols.XGetModifierMapping(this.display);
    if (native === null) return;
    try {
      const view = new Deno.UnsafePointerView(native);
      const keysPerModifier = view.getInt32(0);
      const keycodesAddress = view.getBigUint64(8);
      const keycodesPointer = Deno.UnsafePointer.create(keycodesAddress);
      if (keysPerModifier <= 0 || keycodesPointer === null) return;
      const keycodes = new Deno.UnsafePointerView(keycodesPointer);

      let altMask = 0;
      let metaMask = 0;
      let capsLockMask = 0;
      let altGraphMask = 0;
      let fnMask = 0;
      let numLockMask = 0;
      let scrollLockMask = 0;
      const maskByKeycode = new Map<number, number>();
      const toggleKeycodes = new Set<number>();
      for (let modifier = 0; modifier < 8; modifier++) {
        const mask = 1 << modifier;
        for (let slot = 0; slot < keysPerModifier; slot++) {
          const keycode = keycodes.getUint8(modifier * keysPerModifier + slot);
          if (keycode === 0) continue;
          maskByKeycode.set(keycode, (maskByKeycode.get(keycode) ?? 0) | mask);
          for (const level of [0, 1]) {
            const keysym = BigInt(this.X11.symbols.XKeycodeToKeysym(this.display, keycode, level));
            if (keysym === XK_ALT_L || keysym === XK_ALT_R) altMask |= mask;
            if (
              keysym === XK_META_L || keysym === XK_META_R ||
              keysym === XK_SUPER_L || keysym === XK_SUPER_R
            ) metaMask |= mask;
            if (keysym === XK_CAPS_LOCK) {
              capsLockMask |= mask;
              toggleKeycodes.add(keycode);
            }
            if (keysym === XK_NUM_LOCK) {
              numLockMask |= mask;
              toggleKeycodes.add(keycode);
            }
            if (keysym === XK_SCROLL_LOCK) {
              scrollLockMask |= mask;
              toggleKeycodes.add(keycode);
            }
            if (keysym === XF86XK_FN) fnMask |= mask;
            if (
              keysym === XK_MODE_SWITCH || keysym === XK_ISO_LEVEL3_SHIFT ||
              keysym === XK_ISO_LEVEL5_SHIFT
            ) altGraphMask |= mask;
          }
        }
      }
      this.#modifierMapping = {
        shiftMask: X_SHIFT_MASK,
        controlMask: X_CONTROL_MASK,
        altMask,
        metaMask,
        capsLockMask,
        altGraphMask,
        fnMask,
        numLockMask,
        scrollLockMask,
        maskByKeycode,
        toggleKeycodes,
      };
    } finally {
      this.X11.symbols.XFreeModifiermap(native);
    }
  }

  #refreshDomCodes(): void {
    this.#domCodes = new Map();
    const opcode = new Int32Array(1);
    const event = new Int32Array(1);
    const error = new Int32Array(1);
    const major = new Int32Array([1]);
    const minor = new Int32Array([0]);
    if (this.X11.symbols.XkbQueryExtension(this.display, opcode, event, error, major, minor) === 0) return;

    const keyboard = this.X11.symbols.XkbGetMap(this.display, 0, XKB_USE_CORE_KBD);
    if (keyboard === null) return;
    try {
      // XkbGetNames returns an X11 Status: zero is Success, unlike the Bool
      // returned by XkbQueryExtension immediately above.
      if (this.X11.symbols.XkbGetNames(this.display, XKB_KEY_NAMES_MASK, keyboard) !== 0) return;
      const minimumOutput = new Int32Array(1);
      const maximumOutput = new Int32Array(1);
      this.X11.symbols.XDisplayKeycodes(this.display, minimumOutput, maximumOutput);
      const minimum = Math.max(0, minimumOutput[0]);
      const maximum = Math.min(255, maximumOutput[0]);
      const keyboardView = new Deno.UnsafePointerView(keyboard);
      const namesAddress = keyboardView.getBigUint64(48);
      const namesPointer = Deno.UnsafePointer.create(namesAddress);
      if (namesPointer === null) return;
      const names = new Deno.UnsafePointerView(namesPointer);
      const keysAddress = names.getBigUint64(456);
      const keysPointer = Deno.UnsafePointer.create(keysAddress);
      if (keysPointer === null) return;
      const keys = new Deno.UnsafePointerView(keysPointer);
      const decoder = new TextDecoder("ascii");
      for (let keycode = minimum; keycode <= maximum; keycode++) {
        const bytes = new Uint8Array(4);
        for (let index = 0; index < bytes.length; index++) {
          bytes[index] = keys.getUint8(keycode * bytes.length + index);
        }
        const code = domCodeFromXkbName(decoder.decode(bytes));
        if (code !== "Unidentified") this.#domCodes.set(keycode, code);
      }
    } finally {
      this.X11.symbols.XkbFreeKeyboard(keyboard, XKB_ALL_COMPONENTS_MASK, 1);
    }
  }

  #processInternalConnections(): void {
    const addresses = new BigUint64Array(1);
    const countOutput = new Int32Array(1);
    if (this.X11.symbols.XInternalConnectionNumbers(this.display, addresses, countOutput) === 0) return;
    if (addresses[0] === 0n) return;
    const nativeFds = Deno.UnsafePointer.create(addresses[0]);
    if (nativeFds === null) return;
    try {
      const count = countOutput[0];
      if (count <= 0) return;
      const nativeView = new Deno.UnsafePointerView(nativeFds);
      // struct pollfd is { int fd; short events; short revents } on Linux.
      const pollBuffer = new ArrayBuffer(count * 8);
      const pollView = new DataView(pollBuffer);
      for (let index = 0; index < count; index++) {
        pollView.setInt32(index * 8, nativeView.getInt32(index * 4), true);
        pollView.setInt16(index * 8 + 4, 1, true); // POLLIN
      }
      if (this.libc.symbols.poll(pollBuffer, BigInt(count), 0) <= 0) return;
      for (let index = 0; index < count; index++) {
        if ((pollView.getInt16(index * 8 + 6, true) & 1) === 0) continue;
        this.X11.symbols.XProcessInternalConnection(this.display, pollView.getInt32(index * 8, true));
      }
    } finally {
      this.X11.symbols.XFree(nativeFds);
    }
  }

  #isAutoRepeatRelease(release: DataView<ArrayBuffer>): boolean {
    if (this.#detectableAutoRepeat) return false;
    const pending = this.X11.symbols.XPending(this.display);
    this.#throwIfProtocolFailed();
    if (pending === 0) return false;
    const peekPointer = Deno.UnsafePointer.of(this.#peekEvent)!;
    this.X11.symbols.XPeekEvent(this.display, peekPointer);
    const press = new DataView(this.#peekEvent);
    return isAutoRepeatPair(release, press);
  }
}

function importEvent(
  view: DataView<ArrayBuffer>,
  window: X11Window | undefined,
  eventClock: NativeEventClock,
  clickCounter: ClickCounter<MouseButton>,
  modifierMapping: X11ModifierMapping,
  wmProtocols?: bigint,
  wmDeleteWindow?: bigint,
): UIEvent | undefined {
  if (window === undefined) return undefined;
  const type = view.getInt32(0, true);
  switch (type) {
    case XEventType.ButtonPress: {
      const btn = view.getUint32(84, true);
      const wheelPointer = x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons);
      if (btn === 4) return { type: "wheel", deltaX: 0, deltaY: -1, deltaMode: 1, ...wheelPointer, window };
      if (btn === 5) return { type: "wheel", deltaX: 0, deltaY: 1, deltaMode: 1, ...wheelPointer, window };
      if (btn === 6) return { type: "wheel", deltaX: -1, deltaY: 0, deltaMode: 1, ...wheelPointer, window };
      if (btn === 7) return { type: "wheel", deltaX: 1, deltaY: 0, deltaMode: 1, ...wheelPointer, window };
      const button = x11MouseButton(btn);
      if (button === undefined) return undefined;
      const pointer = x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons, button, true);
      return {
        type: "mousedown",
        button,
        detail: clickCounter.detail(button, true, pointer.timeStamp, pointer.x, pointer.y),
        ...pointer,
        window,
      };
    }
    case XEventType.ButtonRelease: {
      const btn = view.getUint32(84, true);
      if (btn >= 4 && btn <= 7) return undefined; // wheel has no release
      const button = x11MouseButton(btn);
      if (button === undefined) return undefined;
      const pointer = x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons, button, false);
      return {
        type: "mouseup",
        button,
        detail: clickCounter.detail(button, false, pointer.timeStamp, pointer.x, pointer.y),
        ...pointer,
        window,
      };
    }
    case XEventType.MotionNotify:
      return {
        type: "mousemove",
        ...x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons),
        window,
      };
    case XEventType.ClientMessage: {
      // XClientMessageEvent: message_type (Atom) at offset 40, data.l[0] at offset 56.
      // Check for WM_DELETE_WINDOW sent via WM_PROTOCOLS.
      const msgType = view.getBigUint64(40, true);
      const data0 = view.getBigUint64(56, true);
      if (view.getInt32(48, true) === 32 && msgType === wmProtocols && data0 === wmDeleteWindow) {
        return { type: "close", window };
      }
      return undefined;
    }
    case XEventType.EnterNotify:
      // Ignore transitions between the top-level and descendants; the pointer
      // remains inside the browser-style window boundary.
      return view.getInt32(80, true) === NotifyNormal && view.getInt32(84, true) !== NotifyInferior
        ? {
          type: "mouseenter",
          ...x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons, undefined, undefined, 96),
          window,
        }
        : undefined;
    case XEventType.LeaveNotify:
      return view.getInt32(80, true) === NotifyNormal && view.getInt32(84, true) !== NotifyInferior
        ? {
          type: "mouseleave",
          ...x11PointerSnapshot(view, eventClock, modifierMapping, window.pointerButtons, undefined, undefined, 96),
          window,
        }
        : undefined;
    case XEventType.UnmapNotify:
      return window.updateVisibility(false) ? { type: "visibilitychange", visible: false, window } : undefined;
    case XEventType.MapNotify:
      return window.updateVisibility(true) ? { type: "visibilitychange", visible: true, window } : undefined;
    default:
      return undefined;
  }
}

function x11PointerSnapshot(
  view: DataView<ArrayBuffer>,
  eventClock: NativeEventClock,
  modifierMapping: X11ModifierMapping,
  buttonState: X11PointerButtonState,
  changedButton?: MouseButton,
  pressed?: boolean,
  stateOffset = 80,
): {
  x: number;
  y: number;
  screenX: number | null;
  screenY: number | null;
  buttons: number;
  timeStamp: number;
} & PointerModifiers {
  const state = view.getUint32(stateOffset, true);
  const buttons = buttonState.snapshot(state, changedButton, pressed);
  return {
    x: view.getInt32(64, true),
    y: view.getInt32(68, true),
    ...x11ScreenPosition(view),
    buttons,
    timeStamp: eventClock.timeStamp(view.getUint32(56, true)),
    ...pointerModifiers(x11ModifierSnapshot(state, 0, false, modifierMapping)),
  };
}

function x11MouseButton(button: number): MouseButton | undefined {
  switch (button) {
    case 1:
      return "left";
    case 2:
      return "middle";
    case 3:
      return "right";
    case 8:
      return "back";
    case 9:
      return "forward";
    default:
      return undefined;
  }
}

function pointerModifiers(modifiers: ReturnType<typeof x11ModifierSnapshot>): PointerModifiers {
  return {
    shiftKey: modifiers.shiftKey,
    ctrlKey: modifiers.ctrlKey,
    altKey: modifiers.altKey,
    metaKey: modifiers.metaKey,
    capsLock: modifiers.capsLock,
    altGraphKey: modifiers.altGraphKey,
    fnKey: modifiers.fnKey,
    numLock: modifiers.numLock,
    scrollLock: modifiers.scrollLock,
  };
}

export const load: LoadLibrary = () => {
  assertSupportedX11Abi();
  assertMainIsolate();
  if (libraryActive) throw new Error("winding(x11): only one library instance may be active");
  libraryActive = true;
  try {
    return new X11Library();
  } catch (error) {
    libraryActive = false;
    throw error;
  }
};

function assertNever(_value: never): never {
  throw new TypeError("Unsupported XIM event");
}
