// @ts-types="../lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import { render as renderToString } from "preact-render-to-string";
import { QuoxDocument } from "./document.ts";
import type { QuoxInnerHTML } from "./node.ts";

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent
  | QuoxResizeEvent
  | QuoxCloseEvent;

export type QuoxMouseMoveEvent = { type: "mousemove"; x: number; y: number };
export type QuoxMouseButtonEvent = { type: "mousedown" | "mouseup"; button: number };
export type QuoxMouseWheelEvent = { type: "wheel"; deltaX: number; deltaY: number };
export type QuoxKeyboardEvent = {
  type: "keydown" | "keyup";
  key: string;
  code: number;
};
export type QuoxResizeEvent = { type: "resize"; width: number; height: number };
export type QuoxCloseEvent = { type: "close" };

export interface WindowOptions {
  /** Width of the window in pixels (default 800). */
  width?: number;
  /** Height of the window in pixels (default 600). */
  height?: number;
  /** Initial content for `document.head.innerHTML`. */
  head?: QuoxInnerHTML;
  /** Initial content for `document.body.innerHTML`. */
  body?: QuoxInnerHTML;
}

const BUTTON_INDEX: Record<"left" | "middle" | "right", number> = { left: 0, middle: 1, right: 2 };

function innerHTMLToString(value: QuoxInnerHTML | undefined): string {
  return value === undefined ? "" : typeof value === "string" ? value : renderToString(value);
}

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
      return { type: "keydown", key: String(ev.keycode), code: ev.keycode };
    case "keyup":
      return { type: "keyup", key: String(ev.keycode), code: ev.keycode };
    case "resize":
      return { type: "resize", width: ev.width, height: ev.height };
    case "close":
      return { type: "close" };
  }
}

export class QuoxWindow implements Disposable {
  readonly #lib: WindingLibrary;
  readonly #win: WindingWindow;
  #width: number;
  #height: number;
  readonly #renderer: WasmRenderer;
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #rendering = false;
  #renderQueued = false;
  #needsRender = false;
  #stopped = false;
  #disposed = false;
  #rendererFreed = false;
  readonly #listeners: Array<(event: QuoxInputEvent) => void> = [];
  readonly document: QuoxDocument;

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
    this.document = new QuoxDocument(
      renderer,
      () => this.#requestRender(),
      () => this.#assertActiveDocument(),
    );
  }

  /** Open a window and create a WASM renderer with a live document. */
  static async create(options: WindowOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;
    const head = innerHTMLToString(options.head);
    const body = innerHTMLToString(options.body);

    const lib = windingLoad();
    const win = lib.openWindow(0, 0, width, height);
    const renderer = await WasmRenderer.create(width, height, head, body);

    return new QuoxWindow(lib, win, width, height, renderer);
  }

  /** Start native event polling and queue an initial render. */
  start(): void {
    if (this.#intervalId !== null) return;
    this.#intervalId = setInterval(() => {
      this.#pollEvents();
    }, 16);
    this.#requestRender();
  }

  #pollEvents(): void {
    // Drain all pending events and forward input events to listeners.
    let ev: WindingUIEvent | undefined;
    while ((ev = this.#lib.event()) !== undefined) {
      const mapped = mapWindingEvent(ev);
      if (mapped === null) continue;

      if (mapped.type === "close") {
        // Notify listeners before tearing down so they can react.
        for (const cb of this.#listeners) cb(mapped);
        this[Symbol.dispose]();
        return;
      }

      if (mapped.type === "resize") {
        this.#width = mapped.width;
        this.#height = mapped.height;
        // Propagate new dimensions to the WASM renderer so Blitz/Vello reflows
        // the layout at the correct viewport size.
        this.#renderer.resize(mapped.width, mapped.height);
        this.#requestRender();
      }

      if (mapped.type === "wheel") {
        // Scale raw wheel notches (±1) to pixels so the viewport scrolls a
        // comfortable distance per tick.
        const SCROLL_SPEED = 40;
        this.#renderer.scroll(
          Math.round(mapped.deltaX * SCROLL_SPEED),
          Math.round(mapped.deltaY * SCROLL_SPEED),
        );
        this.#requestRender();
      }

      for (const cb of this.#listeners) cb(mapped);
    }
  }

  #requestRender(): void {
    if (this.#stopped || this.#disposed) return;

    this.#needsRender = true;
    if (this.#renderQueued) return;

    this.#renderQueued = true;
    setTimeout(() => {
      this.#renderQueued = false;
      void this.#renderIfNeeded();
    }, 0);
  }

  #assertActiveDocument(): void {
    if (this.#stopped || this.#disposed || this.#rendererFreed) {
      throw new Error("window is not active");
    }
  }

  async #renderIfNeeded(): Promise<void> {
    if (this.#stopped || this.#disposed || this.#rendering || !this.#needsRender) return;

    this.#rendering = true;
    this.#needsRender = false;
    const renderWidth = this.#width;
    const renderHeight = this.#height;
    try {
      // Render the retained Blitz document via WebGPU in WASM.
      const rgba = await this.#renderer.render();

      if (!this.#stopped && !this.#disposed) {
        // Blit RGBA buffer to the window (conversion to native pixel format is handled by winding).
        this.#win.blit(rgba, renderWidth, renderHeight);
      }
    } catch (err) {
      console.error("Quox render failed:", err);
    } finally {
      this.#rendering = false;
      if (this.#needsRender) this.#requestRender();
    }
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
    if (this.#stopped) return;
    this.#stopped = true;

    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }

    this.#releaseRenderer();
  }

  #releaseRenderer(): void {
    if (this.#rendererFreed) return;
    this.#renderer.free();
    this.#rendererFreed = true;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.#win.close();
    this.#lib.close();
  }
}

/**
 * Open a blank native window with a live DOM facade backed by Blitz's WASM document mutator.
 */
export async function openWindow(options?: WindowOptions): Promise<QuoxWindow> {
  const win = await QuoxWindow.create(options);
  win.start();
  return win;
}
