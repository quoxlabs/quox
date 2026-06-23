// @ts-types="./lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "./lib/quox.js";
import { QuoxDocument } from "./dom.ts";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import type { VNode } from "preact";

export { QuoxDocument, QuoxElement, QuoxNode, QuoxText } from "./dom.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUTTON_INDEX: Record<"left" | "middle" | "right", number> = { left: 0, middle: 1, right: 2 };
const SCROLL_SPEED = 40;

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
  #pendingWidth: number | null = null;
  #pendingHeight: number | null = null;
  #pendingScrollX = 0;
  #pendingScrollY = 0;
  readonly #renderer: WasmRenderer;
  #eventIntervalId: ReturnType<typeof setInterval> | null = null;
  #presenting = false;
  #presentationQueued = false;
  #presentationRequested = false;
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
      () => this.#requestPresentation(),
      () => this.#assertActiveDocument(),
    );
  }

  /** Open a blank window with a live document. */
  static async create(options: WindowOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;

    const lib = windingLoad();
    const win = lib.openWindow(0, 0, width, height);
    const renderer = await WasmRenderer.create(width, height);

    return new QuoxWindow(lib, win, width, height, renderer);
  }

  /** Start polling native events and presenting requested frames. */
  start(): void {
    if (this.#stopped) return;
    if (this.#eventIntervalId !== null) return;
    this.#eventIntervalId = setInterval(() => this.#pumpEvents(), 16);
  }

  #pumpEvents(): void {
    if (this.#presenting) return;

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
        this.#pendingWidth = mapped.width;
        this.#pendingHeight = mapped.height;
        this.#requestPresentation();
      }

      if (mapped.type === "wheel") {
        this.#pendingScrollX += Math.round(mapped.deltaX * SCROLL_SPEED);
        this.#pendingScrollY += Math.round(mapped.deltaY * SCROLL_SPEED);
        this.#requestPresentation();
      }

      for (const cb of this.#listeners) cb(mapped);
    }
  }

  #requestPresentation(): void {
    if (this.#stopped || this.#disposed) return;
    this.#presentationRequested = true;
    this.#queuePresentation();
  }

  #assertActiveDocument(): void {
    if (this.#stopped || this.#disposed || this.#rendererFreed) {
      throw new Error("window is not active");
    }
    if (this.#presenting) {
      throw new Error("document is unavailable while presentation is in progress");
    }
  }

  #queuePresentation(): void {
    if (this.#presentationQueued) return;
    this.#presentationQueued = true;
    queueMicrotask(() => {
      this.#presentationQueued = false;
      void this.#presentIfRequested();
    });
  }

  async #presentIfRequested(): Promise<void> {
    if (this.#stopped || this.#disposed || this.#presenting || !this.#presentationRequested) return;

    this.#presentationRequested = false;
    this.#presenting = true;
    try {
      this.#applyPendingRendererState();
      const rgba = await this.#renderer.render();
      if (!this.#stopped && !this.#disposed) {
        this.#win.blit(rgba, this.#width, this.#height);
      }
    } finally {
      this.#presenting = false;
      if (this.#stopped) {
        this.#releaseRenderer();
      } else if (this.#presentationRequested) {
        this.#queuePresentation();
      }
    }
  }

  #applyPendingRendererState(): void {
    if (this.#pendingWidth !== null && this.#pendingHeight !== null) {
      this.#renderer.resize(this.#pendingWidth, this.#pendingHeight);
      this.#pendingWidth = null;
      this.#pendingHeight = null;
    }

    if (this.#pendingScrollX !== 0 || this.#pendingScrollY !== 0) {
      this.#renderer.scroll(this.#pendingScrollX, this.#pendingScrollY);
      this.#pendingScrollX = 0;
      this.#pendingScrollY = 0;
    }
  }

  /** Register a callback that is invoked for every input event. */
  addEventListener(callback: (event: QuoxInputEvent) => void): void {
    this.#listeners.push(callback);
  }

  /** Remove a previously registered input event callback. */
  removeEventListener(callback: (event: QuoxInputEvent) => void): void {
    const idx = this.#listeners.indexOf(callback);
    if (idx >= 0) this.#listeners.splice(idx, 1);
  }

  /** Stop event polling and free WASM resources. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#eventIntervalId !== null) {
      clearInterval(this.#eventIntervalId);
      this.#eventIntervalId = null;
    }
    if (!this.#presenting) {
      this.#releaseRenderer();
    }
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

/** Open a blank native window with a live mutable document. */
export async function openWindow(options?: WindowOptions): Promise<QuoxWindow> {
  const win = await QuoxWindow.create(options);
  win.start();
  return win;
}

/**
 * Render a Preact component tree to a native window.
 *
 * The component is serialised to an HTML fragment and inserted into the live
 * document body.
 */
export async function renderToWindow(jsx: VNode, options?: WindowOptions): Promise<QuoxWindow> {
  const { render: renderToString } = await import("preact-render-to-string");
  const win = await openWindow(options);
  win.document.body.innerHTML = renderToString(jsx);
  return win;
}

if (import.meta.main) {
  const win = await openWindow();
  win.document.body.innerHTML = "<h1>Hello from Blitz WASM + X11</h1>";
  console.log("Window open:", win);
}
