// @ts-types="../lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import { QuoxDocument } from "./document.ts";
import { mapWindingEvent, notifyInputListeners, type QuoxInputEvent, QuoxInputRouter } from "./input.ts";
import { isVNode, mount, type QuoxRenderable } from "./mount.ts";
import type { QuoxElement, QuoxInnerHTML } from "./node.ts";

export type {
  QuoxAppleStandardKeybindingEvent,
  QuoxCloseEvent,
  QuoxFocusChangeEvent,
  QuoxInputEvent,
  QuoxKeyboardEvent,
  QuoxMouseButtonEvent,
  QuoxMouseEnterLeaveEvent,
  QuoxMouseMoveEvent,
  QuoxMouseWheelEvent,
  QuoxResizeEvent,
  QuoxTextInputEvent,
  QuoxVisibilityEvent,
} from "./input.ts";

export type QuoxWindowContent = QuoxInnerHTML | QuoxRenderable;
type SurfaceRenderTarget = Pick<Deno.UnsafeWindowSurface, "width" | "height" | "getContext">;

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
  readonly #renderer: WasmRenderer;
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #rendering = false;
  #renderQueued = false;
  #needsRender = false;
  #stopped = false;
  #disposed = false;
  #rendererFreed = false;
  #surface: Deno.UnsafeWindowSurface | null = null;
  #surfaceRenderTarget: SurfaceRenderTarget | null = null;
  #surfaceContext: GPUCanvasContext | null = null;
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
    this.#renderer = renderer;
    this.document = new QuoxDocument(
      renderer,
      () => this.#requestRender(),
      () => this.#assertActiveDocument(),
      (title) => this.#win.setTitle(title),
    );
    this.#inputRouter = new QuoxInputRouter({
      pointerMove: (x, y, buttons) => this.document.dispatchPointerMove(x, y, buttons),
      pointerDown: (x, y, button, buttons) => this.document.dispatchPointerDown(x, y, button, buttons),
      pointerUp: (x, y, button, buttons) => this.document.dispatchPointerUp(x, y, button, buttons),
      wheel: (x, y, deltaX, deltaY, buttons) => this.document.dispatchWheel(x, y, deltaX, deltaY, buttons),
      key: (event) => this.document.dispatchKey(event),
      textInput: (event) => this.document.dispatchTextInput(event),
      appleCommand: (event) => this.document.dispatchAppleStandardKeybinding(event),
      clearHover: () => this.document.clearHover(),
      resize: (event) => {
        this.#width = event.width;
        this.#height = event.height;
        this.#renderer.resize(event.width, event.height);
        this.#resetSurfaceTarget(event.width, event.height);
        this.#requestRender();
      },
      visibility: (event) => {
        this.#visible = event.visible;
        if (event.visible) this.#requestRender();
      },
    });
  }

  /** Create a window with a live document without starting event processing. */
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

  /** Begin processing window events and render the initial document. */
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

      const { surface, target } = this.#surfaceTarget();
      this.#resizeSurfaceTarget(target, renderWidth, renderHeight);
      await this.#renderer.render_to_canvas(target);
      if (!this.#stopped && !this.#disposed) {
        surface.present();
      }
    } catch (err) {
      console.error("Quox render failed:", err);
    } finally {
      this.#rendering = false;
      if (this.#needsRender) this.#requestRender();
    }
  }

  #surfaceTarget(): { surface: Deno.UnsafeWindowSurface; target: SurfaceRenderTarget } {
    if (this.#surface === null || this.#surfaceRenderTarget === null) {
      const surface = this.#win.windowSurface();
      const target: SurfaceRenderTarget = {
        width: surface.width,
        height: surface.height,
        getContext: (contextId, options) => {
          const context = surface.getContext(contextId, options) as GPUCanvasContext | null;
          this.#surfaceContext = context;
          return context;
        },
      };
      this.#surface = surface;
      this.#surfaceRenderTarget = target;
      return { surface, target };
    }
    return { surface: this.#surface, target: this.#surfaceRenderTarget };
  }

  #resizeSurfaceTarget(target: SurfaceRenderTarget, width: number, height: number): void {
    target.width = width;
    target.height = height;
  }

  #resetSurfaceTarget(width: number, height: number): void {
    this.#renderer.reset_surface();
    this.#surfaceContext?.unconfigure();
    this.#surfaceContext = null;

    if (this.#surface !== null) {
      this.#surface.width = width;
      this.#surface.height = height;
    }
    if (this.#surfaceRenderTarget !== null) {
      this.#resizeSurfaceTarget(this.#surfaceRenderTarget, width, height);
    }
  }

  /** Register a callback that is invoked for each window event. */
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

  /** Stop processing events and rendering, making the document inactive. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;

    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }

    this.#resetSurfaceTarget(this.#width, this.#height);
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
 * Open a native window with a live DOM-like document.
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
