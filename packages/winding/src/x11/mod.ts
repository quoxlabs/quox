import type { Library, LoadLibrary, UIEvent, Window } from "../types.ts";

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
} as const;

const ALL_X_EV_MASKS = 0x1ffffffn;
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
  readonly #image: Deno.PointerValue;
  readonly #imageBuf: Uint8Array;
  readonly #width: number;
  readonly #height: number;

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

    lib.X11.symbols.XSelectInput(lib.display, window, ALL_X_EV_MASKS);
    lib.X11.symbols.XMapWindow(lib.display, window);
    lib.X11.symbols.XFlush(lib.display);
    this.id = BigInt(window);
    this.#width = w;
    this.#height = h;

    this.#gc = lib.X11.symbols.XCreateGC(lib.display, window, 0, 0n) as bigint;
    const visual = lib.X11.symbols.XDefaultVisual(lib.display, 0);
    // imageBuf is kept as a field so XCreateImage's internal pointer remains valid
    // for the entire lifetime of the window.
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
   */
  blit(rgba: Uint8Array, _width: number, _height: number): void {
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
  constructor() {
    this.X11 = Deno.dlopen("libX11.so", x11functions);
    const display = this.X11.symbols.XOpenDisplay(0n);
    if (display == null) throw new Error("Failed to open display");
    this.display = display;
    const screen = this.X11.symbols.XDefaultScreenOfDisplay(display);
    if (screen == null) throw new Error("Failed to get default screen");
    this.screen = screen;
  }
  openWindow(x = 0, y = 0, w = 800, h = 600): X11Window {
    return new X11Window(this, x, y, w, h);
  }
  #event = new ArrayBuffer(192);
  event(): UIEvent | undefined {
    if (this.X11.symbols.XPending(this.display) === 0) return undefined;
    this.X11.symbols.XNextEvent(
      this.display,
      Deno.UnsafePointer.of(this.#event),
    );
    const view = new DataView(this.#event);
    const event = importEvent(view);
    if (event === undefined) return undefined;
    return { ...event, window: this.windows.get(view.getBigUint64(32, true)) };
  }
  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    this.X11.close();
  }
}

const BUTTONS = [, "left", "middle", "right"] as const;
function importEvent(view: DataView<ArrayBuffer>): UIEvent | undefined {
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
    default:
      return undefined;
  }
}

export const load: LoadLibrary = () => new X11Library();
