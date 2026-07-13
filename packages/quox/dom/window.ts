// @ts-types="../lib/quox.d.ts"
import { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { load as windingLoad } from "@quoxlabs/winding";
import type { Library as WindingLibrary, UIEvent as WindingUIEvent, Window as WindingWindow } from "@quoxlabs/winding";
import { QuoxDocument } from "./document.ts";
import { QuoxEventTarget } from "./event_target.ts";
import {
  mapWindingEvent,
  notifyInputListeners,
  type QuoxInputEvent,
  QuoxInputRouter,
  runWithImeSynchronization,
  synchronizeImeRequests,
} from "./input.ts";
import type { ImeRequestSource } from "./ime_requests.ts";
import { isVNode, mount, type QuoxRenderable } from "./mount.ts";
import type { QuoxElement, QuoxInnerHTML } from "./node.ts";
import { fitRgbaToFramebuffer, FramebufferState } from "./framebuffer.ts";
import { assertPositiveFloat32, assertPositiveUint32, assertUint32 } from "./ffi_numbers.ts";
import {
  BufferedEventSource,
  collectInitializationCleanupErrors,
  INITIALIZATION_EVENT_POLL_INTERVAL_MS,
  InitializationEventPump,
  WindowStartupGate,
} from "./initialization_pump.ts";
import { documentHasActiveDispatch, releaseStoppedRenderer } from "./internals.ts";
import { dispatchNativeWindowFocusEvent } from "./window_focus.ts";

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
  QuoxPointerCancelEvent,
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

export class QuoxWindow extends QuoxEventTarget implements Disposable {
  readonly #lib: WindingLibrary;
  readonly #win: WindingWindow;
  #width: number;
  #height: number;
  readonly #framebuffer: FramebufferState;
  #devicePixelRatio = 1;
  #frameToken: number | undefined;
  readonly #renderer: WasmRenderer;
  readonly #events: BufferedEventSource<WindingUIEvent>;
  readonly #startup = new WindowStartupGate();
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #rendering = false;
  #renderQueued = false;
  #needsRender = false;
  #stopped = false;
  #disposed = false;
  #rendererFreed = false;
  #visible = true;
  readonly #inputListeners: Array<(event: QuoxInputEvent) => void> = [];
  readonly #inputRouter: QuoxInputRouter;
  readonly document: QuoxDocument;

  private constructor(
    lib: WindingLibrary,
    win: WindingWindow,
    width: number,
    height: number,
    renderer: WasmRenderer,
  ) {
    super();
    this.#lib = lib;
    this.#win = win;
    this.#width = width;
    this.#height = height;
    this.#framebuffer = new FramebufferState(width, height);
    this.#renderer = renderer;
    this.#events = new BufferedEventSource(() => this.#lib.event());
    this.document = new QuoxDocument(
      renderer,
      () => this.#requestRender(),
      () => this.#assertActiveDocument(),
      (title) => this.#win.setTitle(title),
      () => this.#syncNativeImeRequests(),
      this,
      () => this.#releaseRenderer(),
      () => !this.#stopped && !this.#disposed && !this.#rendererFreed,
    );
    this.#inputRouter = new QuoxInputRouter(
      {
        pointerMove: (x, y, screenX, screenY, buttons, modifiers, timeStamp) =>
          this.document.dispatchPointerMove(
            x,
            y,
            buttons,
            modifiers,
            timeStamp,
            screenX,
            screenY,
          ),
        pointerCancel: (x, y, screenX, screenY, canceledButtons, modifiers, timeStamp) =>
          this.document.dispatchPointerCancel(
            x,
            y,
            canceledButtons,
            modifiers,
            timeStamp,
            screenX,
            screenY,
          ),
        pointerDown: (x, y, screenX, screenY, button, buttons, modifiers, timeStamp, detail) =>
          this.document.dispatchPointerDown(
            x,
            y,
            button,
            buttons,
            modifiers,
            timeStamp,
            detail,
            screenX,
            screenY,
          ),
        pointerUp: (x, y, screenX, screenY, button, buttons, modifiers, timeStamp, detail) =>
          this.document.dispatchPointerUp(
            x,
            y,
            button,
            buttons,
            modifiers,
            timeStamp,
            detail,
            screenX,
            screenY,
          ),
        pointerEnter: (x, y, screenX, screenY, buttons, modifiers, timeStamp) =>
          this.document.dispatchPointerEnter(
            x,
            y,
            buttons,
            modifiers,
            timeStamp,
            screenX,
            screenY,
          ),
        pointerLeave: (x, y, screenX, screenY, buttons, modifiers, timeStamp) =>
          this.document.dispatchPointerLeave(
            x,
            y,
            buttons,
            modifiers,
            timeStamp,
            screenX,
            screenY,
          ),
        wheel: (
          x,
          y,
          screenX,
          screenY,
          blitzDeltaX,
          blitzDeltaY,
          buttons,
          modifiers,
          deltaX,
          deltaY,
          deltaMode,
          timeStamp,
        ) =>
          this.document.dispatchWheel(
            x,
            y,
            blitzDeltaX,
            blitzDeltaY,
            buttons,
            modifiers,
            deltaX,
            deltaY,
            deltaMode,
            timeStamp,
            screenX,
            screenY,
          ),
        key: (event) => this.document.dispatchKey(event),
        ime: (event) => this.document.dispatchIme(event),
        appleCommand: (event) => this.document.dispatchAppleStandardKeybinding(event),
        resize: (event) => {
          const width = assertUint32(event.width, "width");
          const height = assertUint32(event.height, "height");
          const framebufferWidth = assertUint32(event.framebufferWidth, "framebufferWidth");
          const framebufferHeight = assertUint32(event.framebufferHeight, "framebufferHeight");
          const devicePixelRatio = assertPositiveFloat32(event.devicePixelRatio, "devicePixelRatio");
          this.#width = width;
          this.#height = height;
          this.#framebuffer.update(framebufferWidth, framebufferHeight);
          this.#devicePixelRatio = devicePixelRatio;
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
            width,
            height,
            framebufferWidth,
            framebufferHeight,
            devicePixelRatio,
          );
          this.#requestRender();
        },
        visibility: (event) => {
          this.#visible = event.visible;
          if (event.visible) this.#requestRender();
        },
        focusChange: (event) => dispatchNativeWindowFocusEvent(this, event.type),
      },
      width,
      height,
    );
  }

  /** Open a window and create a WASM renderer with a live document. */
  static async create(options: WindowOptions = {}): Promise<QuoxWindow> {
    const width = assertPositiveUint32(options.width ?? 800, "width");
    const height = assertPositiveUint32(options.height ?? 600, "height");
    const head = contentToString(options.head);
    const body = contentToString(options.body);

    const lib = windingLoad();
    let win: WindingWindow | undefined;
    let renderer: WasmRenderer | undefined;
    let eventPump: InitializationEventPump<WindingUIEvent> | undefined;
    try {
      win = lib.openWindow(0, 0, width, height);
      eventPump = new InitializationEventPump(() => lib.event());
      eventPump.start();
      eventPump.checkpoint();

      renderer = await WasmRenderer.create(width, height, head, body);
      eventPump.checkpoint();
      const quoxWindow = new QuoxWindow(lib, win, width, height, renderer);
      await mountWindowContent(quoxWindow.document.head, options.head);
      eventPump.checkpoint();
      await mountWindowContent(quoxWindow.document.body, options.body);
      eventPump.checkpoint();
      quoxWindow.setTitle(options.title ?? (quoxWindow.document.title || DEFAULT_WINDOW_TITLE));
      quoxWindow.#syncNativeImeRequests();
      quoxWindow.#events.handoff(eventPump.finish());
      return quoxWindow;
    } catch (error) {
      const errors = [error];
      const cleanupOperations: Array<() => void> = [];
      if (renderer !== undefined) {
        const ownedRenderer = renderer;
        cleanupOperations.push(() => ownedRenderer.free());
      }
      if (win !== undefined) {
        const ownedWindow = win;
        cleanupOperations.push(() => ownedWindow.close());
      }
      cleanupOperations.push(() => lib.close());
      collectInitializationCleanupErrors(errors, eventPump, cleanupOperations);
      throw cleanupError(errors, "Quox window initialization failed");
    }
  }

  /** Start native event polling and queue an initial render. */
  start(): void {
    if (this.#stopped || this.#disposed || this.#intervalId !== null) return;
    const intervalId = setInterval(() => {
      this.#pollEvents();
    }, INITIALIZATION_EVENT_POLL_INTERVAL_MS);
    this.#intervalId = intervalId;
    try {
      if (!this.#startup.start(() => this.#pollEvents(), () => this.#requestRender())) {
        clearInterval(intervalId);
        this.#intervalId = null;
        return;
      }
    } catch (error) {
      clearInterval(intervalId);
      this.#intervalId = null;
      throw error;
    }
  }

  #pollEvents(): void {
    // Drain all pending events and forward input events to listeners.
    const listenerErrors: unknown[] = [];
    try {
      let ev: WindingUIEvent | undefined;
      while ((ev = this.#events.read()) !== undefined) {
        const mapped = mapWindingEvent(ev);

        if (this.#inputRouter.route(mapped) === "close") {
          // Notify raw input observers before tearing down so they can react.
          this.#notifyInputListeners(mapped, listenerErrors);
          this[Symbol.dispose]();
          return;
        }

        this.#notifyInputListeners(mapped, listenerErrors);
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

  #notifyInputListeners(event: QuoxInputEvent, errors: unknown[]): void {
    notifyInputListeners(this.#inputListeners, event, (error) => errors.push(error));
  }

  #syncNativeImeRequests(): void {
    if (this.#disposed || this.#rendererFreed) return;
    synchronizeImeRequests(this.#renderer as unknown as ImeRequestSource, this.#win);
  }

  #requestRender(): void {
    if (this.#stopped || this.#disposed) return;

    this.#needsRender = true;
    if (!this.#startup.renderingEnabled || this.#renderQueued) return;

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
    // Keep `#needsRender` set while minimized or without a drawable framebuffer
    // so the next visible, positive resize immediately catches up. Event polling
    // and logical resize routing continue while rendering is suspended.
    if (!this.#visible || !this.#framebuffer.drawable) return;

    this.#rendering = true;
    this.#needsRender = false;
    const renderWidth = this.#width;
    const renderHeight = this.#height;
    const framebuffer = this.#framebuffer.snapshot();
    const renderFrameToken = this.#frameToken;
    let renderFailed = false;
    let renderError: unknown;
    try {
      this.document.flushPendingScrollEvents();
      if (!this.#stopped && !this.#disposed && !this.#rendererFreed) {
        this.document.syncNativeTitle();

        // Render the retained Blitz document via WebGPU in WASM.
        const rgba = fitRgbaToFramebuffer(
          await this.#renderer.render(),
          renderWidth,
          renderHeight,
          framebuffer.width,
          framebuffer.height,
        );

        if (
          !this.#stopped && !this.#disposed && this.#framebuffer.drawable && this.#framebuffer.isCurrent(framebuffer)
        ) {
          // Blit RGBA buffer to the window (conversion to native pixel format is handled by winding).
          this.#win.blit(
            rgba,
            framebuffer.width,
            framebuffer.height,
            renderFrameToken,
          );
        }
      }
    } catch (error) {
      renderFailed = true;
      renderError = error;
    }

    try {
      runWithImeSynchronization(
        () => {
          if (renderFailed) throw renderError;
        },
        () => this.#syncNativeImeRequests(),
      );
    } catch (error) {
      console.error("Quox render failed:", error);
    } finally {
      this.#rendering = false;
      if (this.#needsRender) this.#requestRender();
    }
  }

  /**
   * Observe every normalized native input record after Quox has routed it through the DOM
   * engine. This is a non-cancelable diagnostic/input feed, not DOM `EventTarget` dispatch.
   */
  addInputListener(callback: (event: QuoxInputEvent) => void): void {
    this.#inputListeners.push(callback);
  }

  /** Remove one registration made by `addInputListener`. */
  removeInputListener(callback: (event: QuoxInputEvent) => void): void {
    const idx = this.#inputListeners.indexOf(callback);
    if (idx >= 0) this.#inputListeners.splice(idx, 1);
  }

  /** Set the native window title via `document.title`. */
  setTitle(title: string): void {
    this.document.title = title;
  }

  /** Stop the render loop and free WASM resources. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#startup.cancel();
    this.#events.discardBuffered();

    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }

    this.#releaseRenderer();
  }

  #releaseRenderer(): void {
    if (
      releaseStoppedRenderer(
        this.#stopped,
        documentHasActiveDispatch(this.document),
        this.#rendererFreed,
        () => this.#renderer.free(),
      )
    ) this.#rendererFreed = true;
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
