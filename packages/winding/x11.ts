import type { Library, LoadLibrary, UIEvent, Window } from "./src/../types.ts";

const x11functions = {
  XOpenDisplay: { parameters: ["usize"], result: "pointer" },
  XCloseDisplay: { parameters: ["pointer"], result: "void" },
  XDefaultScreenOfDisplay: { parameters: ["pointer"], result: "pointer" },
  XMapWindow: { parameters: ["pointer", "usize"], result: "void" },
  XFlush: { parameters: ["pointer"], result: "void" },
  XPending: { parameters: ["pointer"], result: "i32" },
  XSelectInput: { parameters: ["pointer", "usize", "u64"], result: "void" },
  XNextEvent: { parameters: ["pointer", "pointer"], result: "void" },
  XDefaultVisual: { parameters: ["pointer", "i32"], result: "pointer" },
  XCreateSimpleWindow: {
    parameters: ["pointer", "usize", "i32", "i32", "u32", "u32", "u32", "u64", "u64"],
    result: "usize",
  },
  XCreateGC: { parameters: ["pointer", "usize", "u32", "usize"], result: "usize" },
  XCreateImage: {
    parameters: ["pointer", "pointer", "u32", "i32", "i32", "buffer", "u32", "u32", "i32", "i32"],
    result: "pointer",
  },
  XPutImage: {
    parameters: ["pointer", "usize", "usize", "pointer", "i32", "i32", "i32", "i32", "u32", "u32"],
    result: "i32",
  },
  XInternAtom: { parameters: ["pointer", "buffer", "i32"], result: "usize" },
  XSetWMProtocols: { parameters: ["pointer", "usize", "buffer", "i32"], result: "i32" },
  XChangeWindowAttributes: {
    parameters: ["pointer", "usize", "u64", "buffer"],
    result: "i32",
  },
} as const;

function cString(s: string): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(s.length + 1) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf;
}

// All event masks except:
//   - PointerMotionHint (bit 7): throttles MotionNotify to one hint per entry
//     and requires XQueryPointer acknowledgement, making cursor tracking choppy.
//   - ResizeRedirect (bit 18): blocks the WM from resizing the window, causing
//     the drawable to stay at its initial size while synthetic ConfigureNotify
//     events report the intended (larger) dimensions.
const ALL_X_EV_MASKS = 0x1fbff7fn;
enum _XEvMask {
  NoEvent = 0,
  KeyPress = 1 << 0,
  KeyRelease = 1 << 1,
  ButtonPress = 1 << 2,
  ButtonRelease = 1 << 3,
  EnterWindow = 1 << 4,
  LeaveWindow = 1 << 5,
  PointerMotion = 1 << 6,
  PointerMotionHint = 1 << 7,
  Button1Motion = 1 << 8,
  Button2Motion = 1 << 9,
  Button3Motion = 1 << 10,
  Button4Motion = 1 << 11,
  Button5Motion = 1 << 12,
  ButtonMotion = 1 << 13,
  KeymapState = 1 << 14,
  Exposure = 1 << 15,
  VisibilityChange = 1 << 16,
  StructureNotify = 1 << 17,
  ResizeRedirect = 1 << 18,
  SubstructureNotify = 1 << 19,
  SubstructureRedirect = 1 << 20,
  FocusChange = 1 << 21,
  PropertyChange = 1 << 22,
  ColormapChange = 1 << 23,
  OwnerGrabButton = 1 << 24,
}

enum XEvType {
  KeyPress = 2,
  KeyRelease,
  ButtonPress,
  ButtonRelease,
  MotionNotify,
  EnterNotify,
  LeaveNotify,
  FocusIn,
  FocusOut,
  KeymapNotify,
  Expose,
  GraphicsExpose,
  NoExpose,
  VisibilityNotify,
  CreateNotify,
  DestroyNotify,
  UnmapNotify,
  MapNotify,
  MapRequest,
  ReparentNotify,
  ConfigureNotify,
  ConfigureRequest,
  GravityNotify,
  ResizeRequest,
  CirculateNotify,
  CirculateRequest,
  PropertyNotify,
  SelectionClear,
  SelectionRequest,
  SelectionNotify,
  ColormapNotify,
  ClientMessage,
  MappingNotify,
}

class X11Window implements Window {
  readonly id: bigint;
  readonly #gc: bigint;
  #image: Deno.PointerValue;
  // imageBuf is kept as a field so XCreateImage's internal pointer remains
  // valid for the entire lifetime of each image.
  #imageBuf: Uint8Array;
  #width: number;
  #height: number;

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
    if (BigInt(window) === 0n) throw new Error("Failed to create window");

    // Set background_pixmap = None so the X server does not clear the window
    // to a solid colour on every resize (which causes white flicker).
    const CW_BACK_PIXMAP = 1n; // bit 0
    const attrs = new BigUint64Array([0n]); // None pixmap
    lib.X11.symbols.XChangeWindowAttributes(lib.display, window, CW_BACK_PIXMAP, attrs);

    lib.X11.symbols.XSelectInput(lib.display, window, ALL_X_EV_MASKS);

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

    this.#gc = lib.X11.symbols.XCreateGC(lib.display, window, 0, 0n) as bigint;
    const visual = lib.X11.symbols.XDefaultVisual(lib.display, 0);
    this.#imageBuf = new Uint8Array(w * h * 4);
    const image = lib.X11.symbols.XCreateImage(
      lib.display,
      visual,
      24,
      2,
      0,
      this.#imageBuf as Uint8Array<ArrayBuffer>,
      w,
      h,
      32,
      0,
    );
    if (!image) throw new Error("XCreateImage failed");
    this.#image = image;

    lib.windows.set(this.id, this);
  }

  /**
   * Copy an RGBA pixel buffer to the X11 window. The buffer must be
   * `width * height * 4` bytes. Internally converts to X11 TrueColor BGRX
   * (little-endian) before blitting.
   *
   * If the dimensions differ from the last blit, the XImage is recreated to
   * match the new size.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    if (width !== this.#width || height !== this.#height) {
      this.#width = width;
      this.#height = height;
      this.#imageBuf = new Uint8Array(width * height * 4);
      const visual = this.lib.X11.symbols.XDefaultVisual(this.lib.display, 0);
      // The old XImage is intentionally not destroyed: XDestroyImage would try
      // to free the JS-managed imageBuf pointer. We simply let the reference
      // go stale; the tiny XImage struct is an acceptable one-time leak per
      // resize event.
      const image = this.lib.X11.symbols.XCreateImage(
        this.lib.display,
        visual,
        24,
        2,
        0,
        this.#imageBuf as Uint8Array<ArrayBuffer>,
        width,
        height,
        32,
        0,
      );
      if (!image) throw new Error("XCreateImage failed on resize");
      this.#image = image;
    }
    const buf = this.#imageBuf;
    for (let i = 0; i < rgba.length; i += 4) {
      buf[i] = rgba[i + 2]; // B ← R
      buf[i + 1] = rgba[i + 1]; // G
      buf[i + 2] = rgba[i]; // R ← B
      buf[i + 3] = 0; // padding
    }
    this.lib.X11.symbols.XPutImage(
      this.lib.display,
      this.id,
      this.#gc,
      this.#image,
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
    this.lib.windows.delete(this.id);
  }
}

class X11Library implements Library {
  readonly X11: Deno.DynamicLibrary<typeof x11functions>;
  readonly display: Deno.PointerObject;
  readonly screen: Deno.PointerObject;
  readonly windows = new Map<bigint, X11Window>();
  readonly wmProtocols: bigint;
  readonly wmDeleteWindow: bigint;
  constructor() {
    this.X11 = Deno.dlopen("libX11.so", x11functions);
    const display = this.X11.symbols.XOpenDisplay(0n);
    if (display == null) throw new Error("Failed to open display");
    this.display = display;
    const screen = this.X11.symbols.XDefaultScreenOfDisplay(display);
    if (screen == null) throw new Error("Failed to get default screen");
    this.screen = screen;
    this.wmProtocols = BigInt(this.X11.symbols.XInternAtom(display, cString("WM_PROTOCOLS"), 0));
    this.wmDeleteWindow = BigInt(
      this.X11.symbols.XInternAtom(display, cString("WM_DELETE_WINDOW"), 0),
    );
  }
  openWindow(x = 0, y = 0, w = 800, h = 600): X11Window {
    return new X11Window(this, x, y, w, h);
  }
  #event = new ArrayBuffer(192);
  event(): UIEvent | undefined {
    const view = new DataView(this.#event);
    // Keep consuming X11 events until we find one we handle or the queue is empty.
    // Returning undefined for unhandled types and immediately surfacing it to the
    // caller would stop the outer while-loop in #tick, causing subsequent handled
    // events (e.g. ConfigureNotify after a ReparentNotify) to be delayed by a
    // full tick.
    while (this.X11.symbols.XPending(this.display) !== 0) {
      this.X11.symbols.XNextEvent(
        this.display,
        Deno.UnsafePointer.of(this.#event),
      );
      const event = importEvent(view, this.wmProtocols, this.wmDeleteWindow);
      if (event !== undefined) {
        return { ...event, window: this.windows.get(view.getBigUint64(32, true)) };
      }
    }
    return undefined;
  }
  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    this.X11.close();
  }
}

const BUTTONS = [, "left", "middle", "right"] as const;
function importEvent(
  view: DataView<ArrayBuffer>,
  wmProtocols?: bigint,
  wmDeleteWindow?: bigint,
): UIEvent | undefined {
  const type = view.getInt32(0, true);
  switch (type) {
    case XEvType.KeyPress:
      return { type: "keydown", keycode: view.getInt32(84, true) };
    case XEvType.KeyRelease:
      return { type: "keyup", keycode: view.getInt32(84, true) };
    case XEvType.ButtonPress: {
      const btn = view.getInt32(84, true);
      if (btn === 4) return { type: "wheel", deltaX: 0, deltaY: -1 };
      if (btn === 5) return { type: "wheel", deltaX: 0, deltaY: 1 };
      const button = BUTTONS[btn];
      if (button === undefined) return undefined;
      return { type: "mousedown", button };
    }
    case XEvType.ButtonRelease: {
      const btn = view.getInt32(84, true);
      if (btn === 4 || btn === 5) return undefined; // wheel has no release
      const button = BUTTONS[btn];
      if (button === undefined) return undefined;
      return { type: "mouseup", button };
    }
    case XEvType.MotionNotify:
      return {
        type: "mousemove",
        x: view.getInt32(64, true),
        y: view.getInt32(68, true),
      };
    case XEvType.ConfigureNotify: {
      // XConfigureEvent: width at offset 56, height at offset 60.
      const width = view.getInt32(56, true);
      const height = view.getInt32(60, true);
      return { type: "resize", width, height };
    }
    case XEvType.ClientMessage: {
      // XClientMessageEvent: message_type (Atom) at offset 40, data.l[0] at offset 56.
      // Check for WM_DELETE_WINDOW sent via WM_PROTOCOLS.
      const msgType = view.getBigUint64(40, true);
      const data0 = view.getBigUint64(56, true);
      if (msgType === wmProtocols && data0 === wmDeleteWindow) {
        return { type: "close" };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export const load: LoadLibrary = () => new X11Library();
