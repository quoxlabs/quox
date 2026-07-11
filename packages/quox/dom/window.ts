// @ts-types="../lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import { QuoxDocument } from "./document.ts";
import {
  applyImeRequestSnapshot,
  mapWindingEvent,
  notifyInputListeners,
  type QuoxInputEvent,
  QuoxInputRouter,
} from "./input.ts";
import { isVNode, mount, type QuoxRenderable } from "./mount.ts";
import type { QuoxElement, QuoxInnerHTML } from "./node.ts";
import { fitRgbaToFramebuffer } from "./framebuffer.ts";

export type {
  QuoxAppleStandardKeybindingEvent,
  QuoxCloseEvent,
  QuoxFocusChangeEvent,
  QuoxImeEvent,
  QuoxInputEvent,
  QuoxKeyboardEvent,
  QuoxMouseButtonEvent,
  QuoxMouseEnterLeaveEvent,
  QuoxMouseMoveEvent,
  QuoxMouseWheelEvent,
  QuoxResizeEvent,
  QuoxVisibilityEvent,
} from "./input.ts";

export type QuoxWindowContent = QuoxInnerHTML | QuoxRenderable;

export interface WindowOptions {
  /** Logical width of the window (default 800). */
  width?: number;
  /** Logical height of the window (default 600). */
  height?: number;
  /** Native window title. Overrides any initial `<title>` in `head`. */
  title?: string;
  /** Initial content for `document.head`: an HTML string, or JSX from any recognized runtime. */
  head?: QuoxWindowContent;
  /** Initial content for `document.body`: an HTML string, or JSX from any recognized runtime. */
  body?: QuoxWindowContent;
}

const DEFAULT_WINDOW_TITLE = "quox";

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

export class QuoxWindow implements Disposable {
  readonly #lib: WindingLibrary;
  readonly #win: WindingWindow;
  #width: number;
  #height: number;
  #framebufferWidth: number;
  #framebufferHeight: number;
  #devicePixelRatio = 1;
  #frameToken: number | undefined;
  readonly #renderer: WasmRenderer;
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #rendering = false;
  #renderQueued = false;
  #needsRender = false;
  #stopped = false;
  #disposed = false;
  #rendererFreed = false;
  #visible = true;
  readonly #listeners: Array<(event: QuoxInputEvent) => void> = [];
  readonly #inputRouter: QuoxInputRouter;
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
    this.#framebufferWidth = width;
    this.#framebufferHeight = height;
    this.#renderer = renderer;
    this.document = new QuoxDocument(
      renderer,
      () => this.#requestRender(),
      () => this.#assertActiveDocument(),
      (title) => this.#win.setTitle(title),
      () => this.#syncNativeImeRequests(),
    );
    this.#inputRouter = new QuoxInputRouter(
      {
        pointerMove: (x, y, buttons, modifiers) => this.document.dispatchPointerMove(x, y, buttons, modifiers),
        pointerDown: (x, y, button, buttons, modifiers) =>
          this.document.dispatchPointerDown(x, y, button, buttons, modifiers),
        pointerUp: (x, y, button, buttons, modifiers) =>
          this.document.dispatchPointerUp(x, y, button, buttons, modifiers),
        wheel: (x, y, deltaX, deltaY, buttons, modifiers) =>
          this.document.dispatchWheel(x, y, deltaX, deltaY, buttons, modifiers),
        key: (event) => this.document.dispatchKey(event),
        ime: (event) => this.document.dispatchIme(event),
        appleCommand: (event) => this.document.dispatchAppleStandardKeybinding(event),
        clearHover: () => this.document.clearHover(),
        resize: (event) => {
          this.#width = event.width;
          this.#height = event.height;
          this.#framebufferWidth = event.framebufferWidth;
          this.#framebufferHeight = event.framebufferHeight;
          this.#devicePixelRatio = event.devicePixelRatio;
          this.#frameToken = event.frameToken;
          (this.#renderer as unknown as {
            resize(
              width: number,
              height: number,
              framebufferWidth: number,
              framebufferHeight: number,
              devicePixelRatio: number,
            ): void;
          }).resize(
            event.width,
            event.height,
            event.framebufferWidth,
            event.framebufferHeight,
            event.devicePixelRatio,
          );
          this.#requestRender();
        },
        visibility: (event) => {
          this.#visible = event.visible;
          if (event.visible) this.#requestRender();
        },
      },
      width,
      height,
    );
  }

  /** Open a window and create a WASM renderer with a live document. */
  static async create(options: WindowOptions = {}): Promise<QuoxWindow> {
    const width = options.width ?? 800;
    const height = options.height ?? 600;
    const head = contentToString(options.head);
    const body = contentToString(options.body);

    const lib = windingLoad();
    let win: WindingWindow | undefined;
    let renderer: WasmRenderer | undefined;
    try {
      win = lib.openWindow(0, 0, width, height);
      renderer = await WasmRenderer.create(width, height, head, body);
      const quoxWindow = new QuoxWindow(lib, win, width, height, renderer);
      await mountWindowContent(quoxWindow.document.head, options.head);
      await mountWindowContent(quoxWindow.document.body, options.body);
      quoxWindow.setTitle(options.title ?? (quoxWindow.document.title || DEFAULT_WINDOW_TITLE));
      quoxWindow.#syncNativeImeRequests();
      return quoxWindow;
    } catch (error) {
      const errors = [error];
      if (renderer !== undefined) {
        const ownedRenderer = renderer;
        captureCleanupError(errors, () => ownedRenderer.free());
      }
      if (win !== undefined) {
        const ownedWindow = win;
        captureCleanupError(errors, () => ownedWindow.close());
      }
      captureCleanupError(errors, () => lib.close());
      throw cleanupError(errors, "Quox window initialization failed");
    }
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
    const listenerErrors: unknown[] = [];
    try {
      let ev: WindingUIEvent | undefined;
      while ((ev = this.#lib.event()) !== undefined) {
        const mapped = mapWindingEvent(ev);

        if (this.#inputRouter.route(mapped) === "close") {
          // Notify listeners before tearing down so they can react.
          this.#notifyListeners(mapped, listenerErrors);
          this[Symbol.dispose]();
          return;
        }

        this.#notifyListeners(mapped, listenerErrors);
      }
    } finally {
      if (listenerErrors.length > 0) {
        const error = listenerErrors.length === 1
          ? listenerErrors[0]
          : new AggregateError(listenerErrors, "Quox input listeners failed");
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  #notifyListeners(event: QuoxInputEvent, errors: unknown[]): void {
    notifyInputListeners(this.#listeners, event, (error) => errors.push(error));
  }

  #syncNativeImeRequests(): void {
    if (this.#disposed || this.#rendererFreed) return;

    const snapshot = this.#renderer.take_ime_requests();
    if (snapshot !== undefined) applyImeRequestSnapshot(this.#win, snapshot);
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
    const renderFramebufferWidth = this.#framebufferWidth;
    const renderFramebufferHeight = this.#framebufferHeight;
    const renderFrameToken = this.#frameToken;
    try {
      this.document.syncNativeTitle();

      // Render the retained Blitz document via WebGPU in WASM.
      const rgba = fitRgbaToFramebuffer(
        await this.#renderer.render(),
        renderWidth,
        renderHeight,
        renderFramebufferWidth,
        renderFramebufferHeight,
      );

      if (!this.#stopped && !this.#disposed) {
        // Blit RGBA buffer to the window (conversion to native pixel format is handled by winding).
        this.#win.blit(
          rgba,
          renderFramebufferWidth,
          renderFramebufferHeight,
          renderFrameToken,
        );
      }
    } catch (err) {
      console.error("Quox render failed:", err);
    } finally {
      this.#syncNativeImeRequests();
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
    const errors: unknown[] = [];
    captureCleanupError(errors, () => this.stop());
    captureCleanupError(errors, () => this.#win.close());
    captureCleanupError(errors, () => this.#lib.close());
    if (errors.length > 0) throw cleanupError(errors, "Quox window shutdown failed");
  }
}

function captureCleanupError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function cleanupError(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
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
