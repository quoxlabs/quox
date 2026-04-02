import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";

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

const BUTTON_INDEX: Record<"left" | "middle" | "right", number> = { left: 0, middle: 1, right: 2 };

function mapWindingEvent(ev: WindingUIEvent): QuoxInputEvent | null {
  switch (ev.type) {
    case "mousemove":
      return { type: "mousemove", x: ev.x, y: ev.y };
    case "mousedown":
      return { type: "mousedown", button: BUTTON_INDEX[ev.button] };
    case "mouseup":
      return { type: "mouseup", button: BUTTON_INDEX[ev.button] };
    case "wheel":
      return { type: "wheel", deltaX: ev.deltaX, deltaY: ev.deltaY };
    case "keydown":
      return { type: "keydown", key: String(ev.keycode), code: String(ev.keycode) };
    case "keyup":
      return { type: "keyup", key: String(ev.keycode), code: String(ev.keycode) };
  }
}

// ---------------------------------------------------------------------------
// QuoxWindow
// ---------------------------------------------------------------------------

export class QuoxWindow implements Disposable {
  readonly #lib: WindingLibrary;
  readonly #win: WindingWindow;
  readonly #width: number;
  readonly #height: number;
  readonly #renderer: WasmRenderer;
  #intervalId: number | null = null;
  #rendering = false;
  readonly #listeners: Array<(event: QuoxInputEvent) => void> = [];

  private constructor(
    lib: WindingLibrary,
    win: WindingWindow,
    width: number,
    height: number,
    renderer: WasmRenderer,
  ) {
    this.#lib = lib;
    this.#win = win;
    this.#width = width;
    this.#height = height;
    this.#renderer = renderer;
  }

  /** Open a window and create a WASM renderer for the given HTML. */
  static async create(html: string, options: LoadOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;

    const lib = windingLoad();
    const win = lib.openWindow(0, 0, width, height);
    const renderer = await WasmRenderer.create(html, width, height);

    return new QuoxWindow(lib, win, width, height, renderer);
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
    // Drain all pending events and forward input events to listeners.
    let ev: WindingUIEvent | undefined;
    while ((ev = this.#lib.event()) !== undefined) {
      const mapped = mapWindingEvent(ev);
      if (mapped !== null) {
        for (const cb of this.#listeners) cb(mapped);
      }
    }

    // Render HTML via WebGPU in WASM.
    const rgba = await this.#renderer.render();

    // Blit RGBA buffer to the window (conversion to native pixel format is handled by winding).
    this.#win.blit(rgba, this.#width, this.#height);
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
    this.#win.close();
    this.#lib.close();
  }
}

/**
 * Open a window, render the given HTML string via WASM/WebGPU, and
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
