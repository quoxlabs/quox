import type { KeyDownEvent, KeyModifiers, KeyUpEvent, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import {
  createImeActivationEvent,
  createImeCommitEvent,
  createImeDeleteSurroundingEvent,
  createImePreeditEvent,
  createKeyDownEvent,
  createKeyUpEvent,
  EventQueue,
  keyLocationForCode,
  normalizeCommittedText,
  PressedLogicalKeyCache,
} from "../input/mod.ts";
import { domCodeFromX11 } from "../linux/mod.ts";
import { utf8Bytes, utf8CString as cString } from "../text_encoding.ts";
import { libcFunctions, NotifyNormal, x11functions, XEventMask, XEventType } from "./ffi.ts";
import { isAutoRepeatPair, x11CommittedText, x11KeyEditDisposition } from "./input.ts";
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
    XEventMask.VisibilityChangeMask |
    XEventMask.StructureNotifyMask |
    XEventMask.FocusChangeMask |
    XEventMask.OwnerGrabButtonMask,
);
const X_SHIFT_MASK = 1 << 0;
const X_LOCK_MASK = 1 << 1;
const X_CONTROL_MASK = 1 << 2;
const X_MOD1_MASK = 1 << 3;
const X_MOD4_MASK = 1 << 6;
const XK_MODE_SWITCH = 0xff7en;
const XK_ISO_LEVEL3_SHIFT = 0xfe03n;
const XK_ISO_LEVEL5_SHIFT = 0xfe11n;

function getModifiers(state: number, altGraphMask: number): KeyModifiers {
  const ctrlKey = (state & X_CONTROL_MASK) !== 0;
  const altGraphKey = (state & altGraphMask) !== 0;
  return {
    shiftKey: (state & X_SHIFT_MASK) !== 0,
    ctrlKey,
    altKey: (state & X_MOD1_MASK) !== 0,
    metaKey: (state & X_MOD4_MASK) !== 0,
    accelKey: ctrlKey && !altGraphKey,
    capsLock: (state & X_LOCK_MASK) !== 0,
    altGraphKey,
  };
}

class X11Window implements Window {
  readonly id: bigint;
  readonly input: XimContext;
  readonly pressedKeys = new PressedLogicalKeyCache<number>();
  readonly #gc: bigint;
  #image: NativeXImage;
  #width: number;
  #height: number;
  #closed = false;

  constructor(readonly lib: X11Library, x = 0, y = 0, w = 800, h = 600) {
    const view = new Deno.UnsafePointerView(lib.screen);
    const parent = view.getBigUint64(16);
    const white_pixel = view.getBigUint64(88);
    const black_pixel = view.getBigUint64(96);

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
      lib.X11.symbols.XSetWMProtocols(lib.display, window, protocolsBuf, 1);
    }

    lib.X11.symbols.XMapWindow(lib.display, window);
    lib.X11.symbols.XFlush(lib.display);
    this.id = BigInt(window);
    this.#width = w;
    this.#height = h;

    const gc = BigInt(lib.X11.symbols.XCreateGC(lib.display, window, 0n, null));
    if (gc === 0n) {
      lib.X11.symbols.XDestroyWindow(lib.display, window);
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
      try {
        this.input = lib.input.createContext(this.id);
      } catch (error) {
        lib.windows.delete(this.id);
        this.#image.close();
        throw error;
      }
    } catch (error) {
      lib.X11.symbols.XFreeGC(lib.display, gc);
      lib.X11.symbols.XDestroyWindow(lib.display, window);
      throw error;
    }
  }

  setImeEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.input.setEnabled(enabled);
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.#assertOpen();
    this.input.setCursorArea(x, y, width, height);
  }

  setTitle(title: string): void {
    this.#assertOpen();
    const titleBytes = utf8Bytes(title);
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
    this.lib.X11.symbols.XStoreName(this.lib.display, this.id, latin1CString(title));
    this.lib.X11.symbols.XFlush(this.lib.display);
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
      const visual = this.lib.X11.symbols.XDefaultVisualOfScreen(this.lib.screen);
      if (visual === null) throw new Error("winding(x11): failed to get default visual");
      const depth = this.lib.X11.symbols.XDefaultDepthOfScreen(this.lib.screen);
      const image = new NativeXImage(
        this.lib.X11.symbols,
        this.lib.libc.symbols,
        this.lib.display,
        visual,
        depth,
        width,
        height,
      );
      this.#image.close();
      this.#image = image;
      this.#width = width;
      this.#height = height;
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
    this.lib.X11.symbols.XFlush(this.lib.display);
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
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
    cleanup(() => {
      this.lib.X11.symbols.XDestroyWindow(this.lib.display, this.id);
    });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(x11): errors while closing window");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("winding(x11): window is closed");
  }
}

function openX11Library(): Deno.DynamicLibrary<typeof x11functions> {
  try {
    return Deno.dlopen("libX11.so.6", x11functions);
  } catch (versionedError) {
    try {
      return Deno.dlopen("libX11.so", x11functions);
    } catch {
      throw versionedError;
    }
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
  readonly input: XimManager;
  readonly #events = new EventQueue<UIEvent>();
  #altGraphMask = 0;
  #closed = false;
  constructor() {
    this.X11 = openX11Library();
    try {
      this.libc = Deno.dlopen("libc.so.6", libcFunctions);
    } catch (error) {
      this.X11.close();
      throw error;
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
    this.wmProtocols = BigInt(this.X11.symbols.XInternAtom(display, cString("WM_PROTOCOLS"), 0));
    this.wmDeleteWindow = BigInt(
      this.X11.symbols.XInternAtom(display, cString("WM_DELETE_WINDOW"), 0),
    );
    this.netWmName = BigInt(this.X11.symbols.XInternAtom(display, cString("_NET_WM_NAME"), 0));
    this.utf8String = BigInt(this.X11.symbols.XInternAtom(display, cString("UTF8_STRING"), 0));
    this.#refreshAltGraphMask();
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
  }
  openWindow(x = 0, y = 0, w = 800, h = 600): X11Window {
    if (this.#closed) throw new Error("winding(x11): library is closed");
    return new X11Window(this, x, y, w, h);
  }

  unregisterWindow(window: X11Window): void {
    if (this.windows.get(window.id) !== window) return;
    this.windows.delete(window.id);
    this.#events.purgeWindow(window);
  }
  #event = new ArrayBuffer(192);
  #peekEvent = new ArrayBuffer(192);
  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
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
    while (this.X11.symbols.XPending(this.display) !== 0) {
      this.X11.symbols.XNextEvent(
        this.display,
        eventPointer,
      );

      const type = view.getInt32(0, true);
      const windowId = view.getBigUint64(32, true);
      const window = this.windows.get(windowId);

      const routedKey =
        (type === XEventType.KeyPress || type === XEventType.KeyRelease) && window !== undefined;
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
        this.#refreshAltGraphMask();
        continue;
      }

      if ((type === XEventType.KeyPress || type === XEventType.KeyRelease) && window !== undefined) {
        const state = view.getUint32(80, true);
        const keycode = view.getUint32(84, true);
        const code = domCodeFromX11(keycode);
        const modifiers = getModifiers(state, this.#altGraphMask);
        const wasComposing = window.input.composing;
        let lookupStaged = type === XEventType.KeyPress;
        if (lookupStaged) window.input.beginLookup();
        try {
          const filtered = this.input.filterEvent(eventPointer);
          this.input.throwIfCallbackFailed();
          if (filtered) {
            let keyEvent: KeyDownEvent | KeyUpEvent;
            if (type === XEventType.KeyPress) {
              const repeat = window.pressedKeys.has(keycode);
              const key = window.pressedKeys.press(keycode, "Process");
              keyEvent = createKeyDownEvent({
                keycode,
                code,
                key,
                location: keyLocationForCode(code),
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
                location: keyLocationForCode(code),
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

          if (type === XEventType.KeyRelease) {
            if (this.#isAutoRepeatRelease(view)) continue;
            const key = window.pressedKeys.release(keycode);
            const event: KeyUpEvent = createKeyUpEvent({
              keycode,
              code,
              key,
              location: keyLocationForCode(code),
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
            normalizeCommittedText(lookup.text ?? ""),
            modifiers,
            wasComposing,
            window.input.composing,
            window.input.hasStagedEvents,
          );
          const event: KeyDownEvent = createKeyDownEvent({
            keycode,
            code,
            key,
            location: keyLocationForCode(code),
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

      if (type === XEventType.FocusIn && window !== undefined && view.getInt32(40, true) === NotifyNormal) {
        window.input.setNativeFocused(true);
        return { type: "focus", window };
      }
      if (type === XEventType.FocusOut && window !== undefined && view.getInt32(40, true) === NotifyNormal) {
        window.input.setNativeFocused(false);
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

      const event = importEvent(view, window, this.wmProtocols, this.wmDeleteWindow);
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
    cleanup(() => this.X11.close());
    cleanup(() => this.libc.close());
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(x11): errors while closing library");
    }
  }

  #refreshAltGraphMask(): void {
    this.#altGraphMask = Number(
      this.X11.symbols.XkbKeysymToModifiers(this.display, XK_MODE_SWITCH) |
        this.X11.symbols.XkbKeysymToModifiers(this.display, XK_ISO_LEVEL3_SHIFT) |
        this.X11.symbols.XkbKeysymToModifiers(this.display, XK_ISO_LEVEL5_SHIFT),
    );
  }

  #isAutoRepeatRelease(release: DataView<ArrayBuffer>): boolean {
    if (this.X11.symbols.XPending(this.display) === 0) return false;
    const peekPointer = Deno.UnsafePointer.of(this.#peekEvent)!;
    this.X11.symbols.XPeekEvent(this.display, peekPointer);
    const press = new DataView(this.#peekEvent);
    return isAutoRepeatPair(release, press);
  }
}

const BUTTONS = [, "left", "middle", "right"] as const;
function importEvent(
  view: DataView<ArrayBuffer>,
  window: X11Window | undefined,
  wmProtocols?: bigint,
  wmDeleteWindow?: bigint,
): UIEvent | undefined {
  if (window === undefined) return undefined;
  const type = view.getInt32(0, true);
  switch (type) {
    case XEventType.ButtonPress: {
      const btn = view.getInt32(84, true);
      if (btn === 4) return { type: "wheel", deltaX: 0, deltaY: -1, window };
      if (btn === 5) return { type: "wheel", deltaX: 0, deltaY: 1, window };
      const button = BUTTONS[btn];
      if (button === undefined) return undefined;
      return { type: "mousedown", button, window };
    }
    case XEventType.ButtonRelease: {
      const btn = view.getInt32(84, true);
      if (btn === 4 || btn === 5) return undefined; // wheel has no release
      const button = BUTTONS[btn];
      if (button === undefined) return undefined;
      return { type: "mouseup", button, window };
    }
    case XEventType.MotionNotify:
      return {
        type: "mousemove",
        x: view.getInt32(64, true),
        y: view.getInt32(68, true),
        window,
      };
    case XEventType.ConfigureNotify: {
      // XConfigureEvent: width at offset 56, height at offset 60.
      const width = view.getInt32(56, true);
      const height = view.getInt32(60, true);
      return { type: "resize", width, height, window };
    }
    case XEventType.ClientMessage: {
      // XClientMessageEvent: message_type (Atom) at offset 40, data.l[0] at offset 56.
      // Check for WM_DELETE_WINDOW sent via WM_PROTOCOLS.
      const msgType = view.getBigUint64(40, true);
      const data0 = view.getBigUint64(56, true);
      if (msgType === wmProtocols && data0 === wmDeleteWindow) {
        return { type: "close", window };
      }
      return undefined;
    }
    case XEventType.EnterNotify:
      // XCrossingEvent: mode at offset 80. Only NotifyNormal is a real pointer-enter.
      return view.getInt32(80, true) === NotifyNormal ? { type: "mouseenter", window } : undefined;
    case XEventType.LeaveNotify:
      // XCrossingEvent: mode at offset 80. Only NotifyNormal is a real pointer-leave.
      return view.getInt32(80, true) === NotifyNormal ? { type: "mouseleave", window } : undefined;
    case XEventType.UnmapNotify:
      return { type: "visibilitychange", visible: false, window };
    case XEventType.MapNotify:
      return { type: "visibilitychange", visible: true, window };
    default:
      return undefined;
  }
}

export const load: LoadLibrary = () => new X11Library();

function assertNever(_value: never): never {
  throw new TypeError("Unsupported XIM event");
}
