import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";

// ---------------------------------------------------------------------------
// X11 FFI
// ---------------------------------------------------------------------------

const X11 = Deno.dlopen(
  "libX11.so",
  {
    XOpenDisplay: { parameters: ["usize"], result: "pointer" },
    XCloseDisplay: { parameters: ["pointer"], result: "void" },
    XDefaultScreenOfDisplay: { parameters: ["pointer"], result: "pointer" },
    XMapWindow: { parameters: ["pointer", "usize"], result: "void" },
    XFlush: { parameters: ["pointer"], result: "void" },
    XPutImage: {
      parameters: ["pointer", "usize", "usize", "pointer", "i32", "i32", "i32", "i32", "u32", "u32"],
      result: "i32",
    },
    XCreateGC: { parameters: ["pointer", "usize", "u32", "usize"], result: "usize" },
    XPending: { parameters: ["pointer"], result: "i32" },
    XSelectInput: { parameters: ["pointer", "usize", "u64"], result: "void" },
    XNextEvent: { parameters: ["pointer", "pointer"], result: "void" },
    XDefaultVisual: { parameters: ["pointer", "i32"], result: "pointer" },
    XCreateSimpleWindow: {
      parameters: ["pointer", "usize", "i32", "i32", "u32", "u32", "u32", "u64", "u64"],
      result: "usize",
    },
    XCreateImage: {
      parameters: ["pointer", "pointer", "u32", "i32", "i32", "buffer", "u32", "u32", "i32", "i32"],
      result: "pointer",
    },
  } as const,
);

// ---------------------------------------------------------------------------
// X11 constants
// ---------------------------------------------------------------------------

const X_KEY_PRESS = 2;
const X_KEY_RELEASE = 3;
const X_BUTTON_PRESS = 4;
const X_BUTTON_RELEASE = 5;
const X_MOTION_NOTIFY = 6;

const X_KEY_PRESS_MASK = 1n << 0n;
const X_KEY_RELEASE_MASK = 1n << 1n;
const X_BUTTON_PRESS_MASK = 1n << 2n;
const X_BUTTON_RELEASE_MASK = 1n << 3n;
const X_POINTER_MOTION_MASK = 1n << 6n;
const X_EXPOSURE_MASK = 1n << 15n;
const X_STRUCTURE_NOTIFY_MASK = 1n << 17n;

const X_EVENT_MASK = X_EXPOSURE_MASK |
  X_KEY_PRESS_MASK |
  X_KEY_RELEASE_MASK |
  X_BUTTON_PRESS_MASK |
  X_BUTTON_RELEASE_MASK |
  X_POINTER_MOTION_MASK |
  X_STRUCTURE_NOTIFY_MASK;

// XEvent struct field offsets (64-bit Linux)
const EV_TYPE_OFFSET = 0; // int32
const EV_X_OFFSET = 64; // int32 (XMotionEvent / XButtonEvent / XKeyEvent)
const EV_Y_OFFSET = 68; // int32
const EV_DETAIL_OFFSET = 84; // uint32 (keycode / button number)

const SIZEOF_X_EVENT = 192;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent;

export type QuoxMouseMoveEvent = { type: "mousemove"; x: number; y: number };
export type QuoxMouseButtonEvent = { type: "mousedown" | "mouseup"; button: number };
export type QuoxMouseWheelEvent = { type: "wheel"; deltaX: number; deltaY: number };
export type QuoxKeyboardEvent = {
  type: "keydown" | "keyup";
  /** X11 keycode as decimal string (e.g. "38" for 'a'). */
  key: string;
  /** X11 keycode as decimal string (same value). */
  code: string;
};

export interface LoadOptions {
  /** Width of the window in pixels (default 800). */
  width?: number;
  /** Height of the window in pixels (default 600). */
  height?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseX11Event(ev: DataView): QuoxInputEvent | null {
  const type = ev.getInt32(EV_TYPE_OFFSET, true);
  switch (type) {
    case X_MOTION_NOTIFY: {
      const x = ev.getInt32(EV_X_OFFSET, true);
      const y = ev.getInt32(EV_Y_OFFSET, true);
      return { type: "mousemove", x, y };
    }
    case X_BUTTON_PRESS: {
      const btn = ev.getUint32(EV_DETAIL_OFFSET, true);
      return { type: "mousedown", button: btn - 1 };
    }
    case X_BUTTON_RELEASE: {
      const btn = ev.getUint32(EV_DETAIL_OFFSET, true);
      return { type: "mouseup", button: btn - 1 };
    }
    case X_KEY_PRESS: {
      const code = ev.getUint32(EV_DETAIL_OFFSET, true);
      return { type: "keydown", key: String(code), code: String(code) };
    }
    case X_KEY_RELEASE: {
      const code = ev.getUint32(EV_DETAIL_OFFSET, true);
      return { type: "keyup", key: String(code), code: String(code) };
    }
    default:
      return null;
  }
}

/**
 * Convert a Vello `Rgba8Unorm` buffer into the X11 TrueColor pixel format.
 *
 * On little-endian Linux, a 32 bpp TrueColor pixel in memory is
 * `[Blue, Green, Red, Padding]`, so we swap the R and B channels.
 */
function copyRgbaToX11(rgba: Uint8Array, x11: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    x11[i] = rgba[i + 2]; // B ← vello B
    x11[i + 1] = rgba[i + 1]; // G
    x11[i + 2] = rgba[i]; // R ← vello R
    x11[i + 3] = 0; // padding
  }
}

// ---------------------------------------------------------------------------
// QuoxWindow
// ---------------------------------------------------------------------------

export class QuoxWindow implements Disposable {
  readonly #display: Deno.PointerValue;
  readonly #win: bigint;
  readonly #gc: bigint;
  readonly #image: Deno.PointerValue;
  readonly #imageBuf: Uint8Array;
  readonly #eventBuf: Uint8Array;
  readonly #eventView: DataView;
  readonly #eventPtr: Deno.PointerValue;
  readonly #width: number;
  readonly #height: number;
  readonly #renderer: WasmRenderer;
  #intervalId: number | null = null;
  #rendering = false;
  readonly #listeners: Array<(event: QuoxInputEvent) => void> = [];

  private constructor(
    display: Deno.PointerValue,
    win: bigint,
    gc: bigint,
    image: Deno.PointerValue,
    imageBuf: Uint8Array,
    eventBuf: Uint8Array,
    width: number,
    height: number,
    renderer: WasmRenderer,
  ) {
    this.#display = display;
    this.#win = win;
    this.#gc = gc;
    this.#image = image;
    this.#imageBuf = imageBuf;
    this.#eventBuf = eventBuf;
    this.#eventView = new DataView(eventBuf.buffer, eventBuf.byteOffset, eventBuf.byteLength);
    this.#eventPtr = Deno.UnsafePointer.of(eventBuf as Uint8Array<ArrayBuffer>);
    this.#width = width;
    this.#height = height;
    this.#renderer = renderer;
  }

  /** Open an X11 window and create a WASM renderer for the given HTML. */
  static async create(html: string, options: LoadOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;

    const display = X11.symbols.XOpenDisplay(0n);
    if (!display) throw new Error("XOpenDisplay failed — is DISPLAY set?");

    const screenPtr = X11.symbols.XDefaultScreenOfDisplay(display);
    if (!screenPtr) throw new Error("XDefaultScreenOfDisplay failed");

    const screenData = new DataView(Deno.UnsafePointerView.getArrayBuffer(screenPtr as Deno.PointerObject, 104));
    const parent = screenData.getBigUint64(16, true);
    const whitePx = screenData.getBigUint64(88, true);
    const blackPx = screenData.getBigUint64(96, true);

    const win = X11.symbols.XCreateSimpleWindow(display, parent, 0, 0, width, height, 0, blackPx, whitePx) as bigint;

    X11.symbols.XSelectInput(display, win, X_EVENT_MASK);
    X11.symbols.XMapWindow(display, win);
    X11.symbols.XFlush(display);

    const gc = X11.symbols.XCreateGC(display, win, 0, 0n) as bigint;
    const visual = X11.symbols.XDefaultVisual(display, 0);

    // The image buffer is kept alive as a field so XCreateImage's internal
    // pointer remains valid for the entire lifetime of the window.
    const imageBuf = new Uint8Array(width * height * 4);
    const image = X11.symbols.XCreateImage(display, visual, 24, 2, 0, imageBuf, width, height, 32, 0);
    if (!image) throw new Error("XCreateImage failed");

    const eventBuf = new Uint8Array(SIZEOF_X_EVENT);

    const renderer = await WasmRenderer.create(html, width, height);

    return new QuoxWindow(display, win, gc, image, imageBuf, eventBuf, width, height, renderer);
  }

  /** Start the render loop (~60 fps). */
  start(): void {
    if (this.#intervalId !== null) return;
    this.#intervalId = setInterval(async () => {
      if (this.#rendering) return;
      this.#rendering = true;
      try {
        await this.#tick();
      } finally {
        this.#rendering = false;
      }
    }, 16);
  }

  async #tick(): Promise<void> {
    // Drain all pending X11 events and forward input events to listeners.
    while (X11.symbols.XPending(this.#display) !== 0) {
      X11.symbols.XNextEvent(this.#display, this.#eventPtr);
      const ev = parseX11Event(this.#eventView);
      if (ev !== null) {
        for (const cb of this.#listeners) cb(ev);
      }
    }

    // Render HTML via WebGPU in WASM.
    const rgba = await this.#renderer.render();

    // Convert Vello RGBA → X11 BGRX and write into the pinned image buffer.
    copyRgbaToX11(rgba, this.#imageBuf);

    // Blit to the X11 window.
    X11.symbols.XPutImage(
      this.#display,
      this.#win,
      this.#gc,
      this.#image,
      0,
      0,
      0,
      0,
      this.#width,
      this.#height,
    );
    X11.symbols.XFlush(this.#display);
  }

  /** Register a callback that is invoked for every input event during a tick. */
  addEventListener(callback: (event: QuoxInputEvent) => void): void {
    this.#listeners.push(callback);
  }

  /** Remove a previously registered input event callback. */
  removeEventListener(callback: (event: QuoxInputEvent) => void): void {
    const idx = this.#listeners.indexOf(callback);
    if (idx >= 0) this.#listeners.splice(idx, 1);
  }

  /** Stop the render loop and free WASM resources. */
  stop(): void {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
    this.#renderer.free();
  }

  [Symbol.dispose](): void {
    this.stop();
    X11.symbols.XCloseDisplay(this.#display);
  }
}

/**
 * Open an X11 window, render the given HTML string via WASM/WebGPU, and
 * start the render loop.
 */
export async function renderRawHTML(html: string, options?: LoadOptions): Promise<QuoxWindow> {
  const win = await QuoxWindow.create(html, options);
  win.start();
  return win;
}

if (import.meta.main) {
  const win = await renderRawHTML("<h1>Hello from Blitz WASM + X11</h1>");
  console.log("Window open:", win);
}
