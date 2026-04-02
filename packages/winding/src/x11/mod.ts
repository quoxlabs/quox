import type { Library, LoadLibrary, UIEvent, Window } from "../types.ts";

const x11functions = {
  XOpenDisplay: { parameters: ["usize"], result: "pointer" },
  XCloseDisplay: { parameters: ["pointer"], result: "void" },
  XDefaultScreenOfDisplay: { parameters: ["pointer"], result: "pointer" },
  XMapWindow: { parameters: ["pointer", "usize"], result: "void" },
  XPending: { parameters: ["pointer"], result: "i32" },
  XSelectInput: { parameters: ["pointer", "usize", "u64"], result: "void" },
  XNextEvent: { parameters: ["pointer", "pointer"], result: "void" },
  XCreateSimpleWindow: {
    parameters: [
      "pointer",
      "usize",
      "i32",
      "i32",
      "u32",
      "u32",
      "u32",
      "u64",
      "u64",
    ],
    result: "usize",
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
  constructor(readonly lib: X11Library) {
    const view = new Deno.UnsafePointerView(lib.screen);
    const parent = view.getBigUint64(16);
    const white_pixel = view.getBigUint64(88);
    const black_pixel = view.getBigUint64(96);

    const window = lib.X11.symbols.XCreateSimpleWindow(
      lib.display,
      parent,
      10,
      10,
      100,
      100,
      0,
      black_pixel,
      white_pixel,
    );
    if (BigInt(window) === 0n) throw new Error("Failed to create window");

    lib.X11.symbols.XSelectInput(lib.display, window, ALL_X_EV_MASKS);
    lib.X11.symbols.XMapWindow(lib.display, window);
    this.id = BigInt(window);
    this.lib.windows.set(this.id, this);
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
  openWindow(): X11Window {
    return new X11Window(this);
  }
  #event = new ArrayBuffer(192);
  // FIXME: does not receive mouse motion for some reason?
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
      const button = BUTTONS[view.getInt32(84, true)];
      if (button === undefined) return undefined;
      return { type: "mousedown", button };
    }
    case XEvType.ButtonRelease: {
      const button = BUTTONS[view.getInt32(84, true)];
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
      console.log("unknown event type", type);
      return undefined;
  }
}

export const load: LoadLibrary = () => new X11Library();
