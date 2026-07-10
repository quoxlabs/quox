// @ts-types="../lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import { QuoxDocument, type QuoxImeEvent } from "./document.ts";
import { isVNode, mount, type QuoxRenderable } from "./mount.ts";
import type { QuoxElement, QuoxInnerHTML } from "./node.ts";

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent
  | QuoxImeEvent
  | QuoxResizeEvent
  | QuoxCloseEvent
  | QuoxMouseEnterLeaveEvent
  | QuoxFocusChangeEvent
  | QuoxVisibilityEvent;

export type QuoxMouseMoveEvent = { type: "mousemove"; x: number; y: number };
export type QuoxMouseButtonEvent = { type: "mousedown" | "mouseup"; button: number };
export type QuoxMouseWheelEvent = { type: "wheel"; deltaX: number; deltaY: number };
export type QuoxKeyboardEvent = {
  type: "keydown" | "keyup";
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  accelKey: boolean;
  capsLock: boolean;
  /** Text committed by this keydown, when the backend reports it directly. */
  text?: string;
  repeat: boolean;
};
export type QuoxResizeEvent = { type: "resize"; width: number; height: number };
export type QuoxCloseEvent = { type: "close" };
/** Fired when the pointer enters/leaves the window's bounds. */
export type QuoxMouseEnterLeaveEvent = { type: "mouseenter" | "mouseleave" };
/** Fired when the window (not a DOM element) gains/loses OS-level input focus. */
export type QuoxFocusChangeEvent = { type: "focus" | "blur" };
/** Fired when the window is minimized/restored. */
export type QuoxVisibilityEvent = { type: "visibilitychange"; visible: boolean };

export type QuoxWindowContent = QuoxInnerHTML | QuoxRenderable;

export interface WindowOptions {
  /** Width of the window in pixels (default 800). */
  width?: number;
  /** Height of the window in pixels (default 600). */
  height?: number;
  /** Native window title. Overrides any initial `<title>` in `head`. */
  title?: string;
  /** Initial content for `document.head`: an HTML string, or JSX from any recognized runtime. */
  head?: QuoxWindowContent;
  /** Initial content for `document.body`: an HTML string, or JSX from any recognized runtime. */
  body?: QuoxWindowContent;
}

const DEFAULT_WINDOW_TITLE = "quox";
const BUTTON_INDEX: Record<"left" | "middle" | "right", number> = { left: 0, middle: 1, right: 2 };
/** `MouseEventButtons` bitmask values, indexed by `BUTTON_INDEX`'s ordinal (left/middle/right). */
const BUTTON_INDEX_TO_BIT = [1, 4, 2] as const;
const WHEEL_SCROLL_SPEED = 40;

type RendererImeRequests = {
  take_ime_cursor_area(): Float32Array | undefined;
  take_ime_enabled(): boolean | undefined;
};

/** Anything that isn't itself renderable content (a string, array, or vnode) is an options bag. */
function isWindowOptions(value: QuoxWindowContent | WindowOptions | undefined): value is WindowOptions {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return !isVNode(value);
}

function contentToString(value: QuoxWindowContent | undefined): string {
  return typeof value === "string" ? value : "";
}

async function mountWindowContent(parent: QuoxElement, value: QuoxWindowContent | undefined): Promise<void> {
  if (value === undefined || typeof value === "string") return;
  await mount(parent, value);
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
    case "keyup": {
      const mapped: QuoxKeyboardEvent = {
        type: ev.type,
        key: ev.key ?? String(ev.keycode),
        code: ev.code,
        shiftKey: ev.shiftKey,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        accelKey: ev.accelKey,
        capsLock: ev.capsLock ?? false,
        repeat: ev.repeat ?? false,
      };
      if (ev.text !== undefined) mapped.text = ev.text;
      return mapped;
    }
    case "ime": {
      switch (ev.kind) {
        case "enabled":
        case "disabled":
          return { type: "ime", kind: ev.kind };
        case "preedit": {
          const mapped: QuoxImeEvent = { type: "ime", kind: "preedit", text: ev.text };
          const cursorRange = ev.cursorRange ??
            (ev.selection === undefined || ev.selection === null
              ? undefined
              : [ev.selection.start, ev.selection.end] as const);
          if (cursorRange !== undefined) mapped.cursorRange = cursorRange;
          return mapped;
        }
        case "commit":
          return { type: "ime", kind: "commit", text: ev.text };
        case "deleteSurrounding":
          return {
            type: "ime",
            kind: "deleteSurrounding",
            beforeLength: ev.beforeLength,
            afterLength: ev.afterLength,
          };
      }
      return null;
    }
    case "resize":
      return { type: "resize", width: ev.width, height: ev.height };
    case "close":
      return { type: "close" };
    case "mouseenter":
      return { type: "mouseenter" };
    case "mouseleave":
      return { type: "mouseleave" };
    case "focus":
      return { type: "focus" };
    case "blur":
      return { type: "blur" };
    case "visibilitychange":
      return { type: "visibilitychange", visible: ev.visible };
    case "apple-standard-keybinding":
      // Native AppKit editing commands do not have a QuoxWindow event equivalent.
      return null;
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
  #visible = true;
  #buttonsDown = 0;
  #lastPointerX = 0;
  #lastPointerY = 0;
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
      (title) => this.#win.setTitle(title),
      () => this.#syncNativeImeRequests(),
    );
  }

  /** Open a window and create a WASM renderer with a live document. */
  static async create(options: WindowOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;
    const head = contentToString(options.head);
    const body = contentToString(options.body);

    const lib = windingLoad();
    const win = lib.openWindow(0, 0, width, height);
    const renderer = await WasmRenderer.create(width, height, head, body);
    const quoxWindow = new QuoxWindow(lib, win, width, height, renderer);

    try {
      await mountWindowContent(quoxWindow.document.head, options.head);
      await mountWindowContent(quoxWindow.document.body, options.body);
      quoxWindow.setTitle(options.title ?? (quoxWindow.document.title || DEFAULT_WINDOW_TITLE));
      quoxWindow.#syncNativeImeRequests();
    } catch (error) {
      quoxWindow[Symbol.dispose]();
      throw error;
    }

    return quoxWindow;
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
        this.#notifyListeners(mapped);
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

      if (mapped.type === "mousemove") {
        this.#lastPointerX = mapped.x;
        this.#lastPointerY = mapped.y;
        this.document.dispatchPointerMove(mapped.x, mapped.y, this.#buttonsDown);
      }

      if (mapped.type === "mousedown") {
        this.#buttonsDown |= BUTTON_INDEX_TO_BIT[mapped.button] ?? 0;
        this.document.dispatchPointerDown(this.#lastPointerX, this.#lastPointerY, mapped.button, this.#buttonsDown);
      }

      if (mapped.type === "mouseup") {
        this.document.dispatchPointerUp(this.#lastPointerX, this.#lastPointerY, mapped.button, this.#buttonsDown);
        this.#buttonsDown &= ~(BUTTON_INDEX_TO_BIT[mapped.button] ?? 0);
      }

      if (mapped.type === "wheel") {
        // Scale raw wheel notches (±1) to pixels so the viewport scrolls a
        // comfortable distance per tick.
        this.document.dispatchWheel(
          this.#lastPointerX,
          this.#lastPointerY,
          mapped.deltaX * WHEEL_SCROLL_SPEED,
          mapped.deltaY * WHEEL_SCROLL_SPEED,
          this.#buttonsDown,
        );
      }

      if (mapped.type === "mouseleave") {
        // The pointer left the window entirely, so no further `mousemove` will arrive to
        // naturally clear whatever was last hovered.
        this.document.clearHover();
      }

      if (
        mapped.type === "keydown" &&
        ev.type === "keydown" &&
        ev.text !== undefined &&
        ev.textInputHandled !== true
      ) {
        try {
          this.document.dispatchKeyDown(
            mapped.code,
            mapped.shiftKey,
            mapped.ctrlKey,
            mapped.altKey,
            mapped.metaKey,
            mapped.capsLock,
            ev.key,
            ev.text,
            ev.repeat ?? false,
          );
          this.#notifyListeners(mapped);
        } finally {
          // Keep character insertion separate from KeyDown. This lets Blitz expose
          // the keyboard event first while Commit remains the single DOM input source.
          this.document.dispatchIme({ type: "ime", kind: "commit", text: ev.text });
        }
        continue;
      }

      if (mapped.type === "keydown" && ev.type === "keydown") {
        this.document.dispatchKeyDown(
          mapped.code,
          mapped.shiftKey,
          mapped.ctrlKey,
          mapped.altKey,
          mapped.metaKey,
          mapped.capsLock,
          ev.key,
          ev.text,
          ev.repeat ?? false,
        );
      }

      if (mapped.type === "keyup" && ev.type === "keyup") {
        this.document.dispatchKeyUp(
          mapped.code,
          mapped.shiftKey,
          mapped.ctrlKey,
          mapped.altKey,
          mapped.metaKey,
          mapped.capsLock,
          ev.key,
        );
      }

      if (mapped.type === "ime") this.document.dispatchIme(mapped);

      if (mapped.type === "visibilitychange") {
        this.#visible = mapped.visible;
        if (mapped.visible) this.#requestRender();
      }

      this.#notifyListeners(mapped);
    }
  }

  #notifyListeners(event: QuoxInputEvent): void {
    for (const cb of this.#listeners) cb(event);
  }

  #syncNativeImeRequests(): void {
    if (this.#disposed || this.#rendererFreed) return;

    const renderer = this.#renderer as WasmRenderer & RendererImeRequests;

    // Cursor geometry must reach the native backend before an accompanying enable
    // request, otherwise an IME can briefly open its candidate window at the origin.
    const cursorArea = renderer.take_ime_cursor_area();
    if (cursorArea !== undefined && cursorArea.length >= 4) {
      this.#win.setImeCursorArea?.(cursorArea[0], cursorArea[1], cursorArea[2], cursorArea[3]);
    }

    const enabled = renderer.take_ime_enabled();
    if (enabled !== undefined) this.#win.setImeEnabled?.(enabled);
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
    // Skip the actual render while minimized, but leave `#needsRender` set so becoming
    // visible again immediately catches up. Event polling itself is never gated.
    if (!this.#visible) return;

    this.#rendering = true;
    this.#needsRender = false;
    const renderWidth = this.#width;
    const renderHeight = this.#height;
    try {
      this.document.syncNativeTitle();

      // Render the retained Blitz document via WebGPU in WASM.
      const rgba = await this.#renderer.render();
      this.#syncNativeImeRequests();

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

  /** Set the native window title via `document.title`. */
  setTitle(title: string): void {
    this.document.title = title;
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
 *
 * Accepts either a `WindowOptions` bag, or content (an HTML string or JSX) as shorthand for
 * `{ body: content }`.
 */
export async function openWindow(arg?: QuoxWindowContent | WindowOptions): Promise<QuoxWindow> {
  const options = isWindowOptions(arg) ? arg : { body: arg };
  const win = await QuoxWindow.create(options);
  win.start();
  return win;
}
