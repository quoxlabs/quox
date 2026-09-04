import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import {
  addDocumentEventListener,
  dispatchFullscreenEvent,
  getDocumentEventHandler,
  invokeEventHandlers,
  removeDocumentEventListener,
  setDocumentEventHandler,
} from "./event_handlers.ts";
import {
  encodeKeyEvent,
  type QuoxAppleStandardKeybindingEvent,
  type QuoxKeyboardEvent,
  type QuoxTextInputEvent,
} from "./input.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import {
  QuoxElement,
  type QuoxEventType,
  type QuoxFullscreenEvent,
  type QuoxFullscreenEventType,
  QuoxNode,
  QuoxText,
} from "./node.ts";

type SetNativeTitle = (title: string) => void;
type SetNativeFullscreen = (fullscreen: boolean) => void;
type NativeFullscreenEnabled = () => boolean;
type DocumentFullscreenEventHandler = (this: QuoxDocument, event: QuoxFullscreenEvent) => unknown;

type FullscreenWaiter = {
  readonly resolve: () => void;
  readonly reject: (reason: TypeError) => void;
};

type FullscreenTransition = {
  readonly fullscreen: boolean;
  readonly target: QuoxElement;
  readonly waiters: FullscreenWaiter[];
  timer?: ReturnType<typeof setTimeout>;
};

const FULLSCREEN_CONFIRMATION_TIMEOUT = 5_000;

export class QuoxDocument {
  readonly #renderer: WasmRenderer;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  readonly #setNativeFullscreen: SetNativeFullscreen;
  readonly #nativeFullscreenEnabled: NativeFullscreenEnabled;
  readonly #fullscreenTimeout: number;
  #lastNativeTitle: string;
  #fullscreenElement: QuoxElement | null = null;
  #fullscreenPath: readonly number[] = [];
  #pendingFullscreen: FullscreenTransition | null = null;
  readonly #fullscreenQueue: FullscreenTransition[] = [];
  #lastFullscreenTarget: QuoxElement | null = null;
  #exitLateFullscreen = false;
  #fullscreenDisposed = false;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
    setNativeFullscreen: SetNativeFullscreen = () => {
      throw new Error("native fullscreen is unavailable");
    },
    nativeFullscreenEnabled: NativeFullscreenEnabled = () => false,
    fullscreenTimeout = FULLSCREEN_CONFIRMATION_TIMEOUT,
  ) {
    this.#renderer = renderer;
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
    this.#setNativeFullscreen = setNativeFullscreen;
    this.#nativeFullscreenEnabled = nativeFullscreenEnabled;
    this.#fullscreenTimeout = fullscreenTimeout;
    this.#lastNativeTitle = renderer.title();
    attachDocumentInternals(this, {
      renderer,
      requestRender,
      assertActive,
      requestFullscreen: (element) => this.#requestFullscreen(element),
      didMutate: () => this.#didMutate(),
      handleNativeFullscreenChange: (fullscreen) => this.#handleNativeFullscreenChange(fullscreen),
      handleNativeFullscreenError: (requested, message) => this.#handleNativeFullscreenError(requested, message),
      disposeFullscreen: () => this.#disposeFullscreen(),
    });
  }

  get fullscreenElement(): QuoxElement | null {
    return this.#fullscreenElement;
  }

  get fullscreenEnabled(): boolean {
    try {
      this.#assertActive();
      return !this.#fullscreenDisposed && this.#nativeFullscreenEnabled();
    } catch {
      return false;
    }
  }

  get onfullscreenchange(): DocumentFullscreenEventHandler | null {
    return getDocumentEventHandler(this, "fullscreenchange");
  }

  set onfullscreenchange(handler: DocumentFullscreenEventHandler | null) {
    setDocumentEventHandler(this, "fullscreenchange", handler);
  }

  get onfullscreenerror(): DocumentFullscreenEventHandler | null {
    return getDocumentEventHandler(this, "fullscreenerror");
  }

  set onfullscreenerror(handler: DocumentFullscreenEventHandler | null) {
    setDocumentEventHandler(this, "fullscreenerror", handler);
  }

  addEventListener(type: QuoxFullscreenEventType, listener: DocumentFullscreenEventHandler): void {
    addDocumentEventListener(this, type, listener);
  }

  removeEventListener(type: QuoxFullscreenEventType, listener: DocumentFullscreenEventHandler): void {
    removeDocumentEventListener(this, type, listener);
  }

  #requestFullscreen(element: QuoxElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!this.#validateFullscreenTarget(element, waiter)) return;
      if (sameElement(this.#fullscreenElement, element) && this.#pendingFullscreen === null) {
        resolve();
        return;
      }
      if (this.#fullscreenElement !== null && !sameElement(this.#fullscreenElement, element)) {
        this.#rejectFullscreen(waiter, element, "A different element is already fullscreen");
        return;
      }
      const pending = this.#pendingFullscreen;
      if (pending?.fullscreen === true) {
        if (!sameElement(pending.target, element)) {
          this.#rejectFullscreen(waiter, element, "A different element is entering fullscreen");
          return;
        }
        if (this.#fullscreenQueue.length === 0) {
          pending.waiters.push(waiter);
          return;
        }
      }
      const queued = this.#fullscreenQueue.at(-1);
      if (queued?.fullscreen === true && sameElement(queued.target, element)) queued.waiters.push(waiter);
      else this.#fullscreenQueue.push({ fullscreen: true, target: element, waiters: [waiter] });
      this.#pumpFullscreenQueue();
    });
  }

  exitFullscreen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      try {
        this.#assertActive();
      } catch {
        this.#rejectFullscreen(waiter, null, "Document is not active");
        return;
      }
      if (this.#fullscreenDisposed) {
        this.#rejectFullscreen(waiter, null, "Document is not active");
        return;
      }
      const entering = this.#pendingFullscreen?.fullscreen === true
        ? this.#pendingFullscreen.target
        : this.#fullscreenQueue.find((transition) => transition.fullscreen)?.target;
      const target = this.#fullscreenElement ?? entering;
      if (target === null || target === undefined) {
        this.#rejectFullscreen(waiter, null, "Document is not fullscreen");
        return;
      }
      const pending = this.#pendingFullscreen;
      if (pending?.fullscreen === false && this.#fullscreenQueue.length === 0) {
        pending.waiters.push(waiter);
        return;
      }
      const queued = this.#fullscreenQueue.at(-1);
      if (queued?.fullscreen === false) queued.waiters.push(waiter);
      else this.#fullscreenQueue.push({ fullscreen: false, target, waiters: [waiter] });
      this.#pumpFullscreenQueue();
    });
  }

  #handleNativeFullscreenChange(fullscreen: boolean): void {
    if (this.#fullscreenDisposed) return;
    const pending = this.#pendingFullscreen;
    if (pending !== null) {
      this.#finishPendingTimer(pending);
      this.#pendingFullscreen = null;
      if (pending.fullscreen !== fullscreen) {
        this.#failTransition(pending, "Native fullscreen request was denied");
      } else if (fullscreen && !this.#isConnected(pending.target)) {
        this.#failTransition(pending, "Fullscreen element was detached before confirmation");
        this.#requestNativeExitWithoutPromise();
      } else {
        try {
          if (fullscreen || this.#fullscreenElement !== null) {
            this.#applyFullscreenState(fullscreen, pending.target);
          }
          for (const waiter of pending.waiters) waiter.resolve();
        } catch (error) {
          this.#failTransition(pending, error instanceof Error ? error.message : String(error));
          if (fullscreen) this.#requestNativeExitWithoutPromise();
        }
      }
      this.#pumpFullscreenQueue();
      return;
    }

    if (fullscreen) {
      const target = this.#connectedTarget(this.#lastFullscreenTarget) ?? this.documentElement;
      if (!sameElement(this.#fullscreenElement, target)) this.#applyFullscreenState(true, target);
      if (this.#exitLateFullscreen) {
        this.#exitLateFullscreen = false;
        this.#requestNativeExitWithoutPromise(target);
      }
    } else if (this.#fullscreenElement !== null) {
      this.#applyFullscreenState(false, this.#fullscreenElement);
    }
  }

  #handleNativeFullscreenError(requestedFullscreen: boolean, message: string): void {
    if (this.#fullscreenDisposed) return;
    const pending = this.#pendingFullscreen;
    if (pending === null || pending.fullscreen !== requestedFullscreen) {
      this.#dispatchFullscreenEvent(this.#fullscreenElement, "fullscreenerror");
      return;
    }
    this.#finishPendingTimer(pending);
    this.#pendingFullscreen = null;
    if (requestedFullscreen) this.#exitLateFullscreen = false;
    this.#failTransition(pending, message);
    this.#pumpFullscreenQueue();
  }

  #didMutate(): void {
    if (this.#fullscreenElement !== null) {
      const nextPath = [...this.#renderer.element_path(this.#fullscreenElement.nodeId)];
      if (nextPath.length === 0 || !samePath(this.#fullscreenPath, nextPath)) {
        const target = this.#fullscreenElement;
        this.#applyFullscreenState(false, target);
        this.#requestNativeExitWithoutPromise(target);
      } else {
        this.#renderer.refresh_fullscreen_element();
      }
    } else if (this.#pendingFullscreen?.fullscreen && !this.#isConnected(this.#pendingFullscreen.target)) {
      const pending = this.#pendingFullscreen;
      this.#finishPendingTimer(pending);
      this.#pendingFullscreen = null;
      this.#exitLateFullscreen = true;
      this.#failTransition(pending, "Fullscreen element was detached");
      this.#pumpFullscreenQueue();
    }
    this.#requestRender();
  }

  #disposeFullscreen(): void {
    if (this.#fullscreenDisposed) return;
    if (this.#fullscreenElement !== null || this.#pendingFullscreen?.fullscreen === true) {
      try {
        this.#setNativeFullscreen(false);
      } catch {
        // The native window is about to be stopped or disposed regardless.
      }
    }
    this.#fullscreenDisposed = true;
    const error = new TypeError("Document is not active");
    if (this.#pendingFullscreen !== null) {
      this.#finishPendingTimer(this.#pendingFullscreen);
      for (const waiter of this.#pendingFullscreen.waiters) waiter.reject(error);
      this.#pendingFullscreen = null;
    }
    for (const transition of this.#fullscreenQueue.splice(0)) {
      for (const waiter of transition.waiters) waiter.reject(error);
    }
    if (this.#fullscreenElement !== null) {
      this.#renderer.clear_fullscreen_element();
      this.#fullscreenElement = null;
      this.#fullscreenPath = [];
    }
  }

  #validateFullscreenTarget(element: QuoxElement, waiter: FullscreenWaiter): boolean {
    try {
      this.#assertActive();
    } catch {
      this.#rejectFullscreen(waiter, null, "Document is not active");
      return false;
    }
    if (this.#fullscreenDisposed) {
      this.#rejectFullscreen(waiter, null, "Document is not active");
      return false;
    }
    if (element.ownerDocument !== this || !this.#isConnected(element)) {
      this.#rejectFullscreen(waiter, element, "Fullscreen element is not connected to the active document");
      return false;
    }
    let enabled = false;
    try {
      enabled = this.#nativeFullscreenEnabled();
    } catch {
      // Expose backend capability failures through the Fullscreen API surface.
    }
    if (!enabled) {
      this.#rejectFullscreen(waiter, element, "Fullscreen is not supported");
      return false;
    }
    return true;
  }

  #isConnected(element: QuoxElement): boolean {
    return element.ownerDocument === this && this.#renderer.is_connected_element(element.nodeId);
  }

  #connectedTarget(element: QuoxElement | null): QuoxElement | null {
    return element !== null && this.#isConnected(element) ? element : null;
  }

  #pumpFullscreenQueue(): void {
    if (this.#pendingFullscreen !== null || this.#fullscreenDisposed) return;
    const transition = this.#fullscreenQueue.shift();
    if (transition === undefined) return;

    if (transition.fullscreen) {
      if (!this.#isConnected(transition.target)) {
        this.#failTransition(transition, "Fullscreen element is not connected");
        this.#pumpFullscreenQueue();
        return;
      }
      if (this.#fullscreenElement !== null) {
        if (sameElement(this.#fullscreenElement, transition.target)) {
          for (const waiter of transition.waiters) waiter.resolve();
        } else {
          this.#failTransition(transition, "A different element is already fullscreen");
        }
        this.#pumpFullscreenQueue();
        return;
      }
    } else if (this.#fullscreenElement === null) {
      this.#failTransition(transition, "Document is not fullscreen");
      this.#pumpFullscreenQueue();
      return;
    }

    this.#lastFullscreenTarget = transition.target;
    if (transition.fullscreen) this.#exitLateFullscreen = false;
    this.#pendingFullscreen = transition;
    try {
      this.#setNativeFullscreen(transition.fullscreen);
    } catch (error) {
      this.#pendingFullscreen = null;
      this.#failTransition(transition, error instanceof Error ? error.message : String(error));
      this.#pumpFullscreenQueue();
      return;
    }
    transition.timer = setTimeout(() => {
      if (this.#pendingFullscreen !== transition) return;
      this.#pendingFullscreen = null;
      if (transition.fullscreen && this.#fullscreenQueue.some((queued) => !queued.fullscreen)) {
        this.#exitLateFullscreen = true;
      }
      this.#failTransition(transition, "Native fullscreen confirmation timed out");
      this.#pumpFullscreenQueue();
    }, this.#fullscreenTimeout);
  }

  #requestNativeExitWithoutPromise(target = this.#lastFullscreenTarget ?? this.documentElement): void {
    if (this.#pendingFullscreen !== null) return;
    const transition: FullscreenTransition = { fullscreen: false, target, waiters: [] };
    this.#pendingFullscreen = transition;
    try {
      this.#setNativeFullscreen(false);
    } catch {
      this.#pendingFullscreen = null;
      this.#dispatchFullscreenEvent(this.#connectedTarget(target), "fullscreenerror");
      return;
    }
    transition.timer = setTimeout(() => {
      if (this.#pendingFullscreen !== transition) return;
      this.#pendingFullscreen = null;
      this.#dispatchFullscreenEvent(this.#connectedTarget(target), "fullscreenerror");
      this.#pumpFullscreenQueue();
    }, this.#fullscreenTimeout);
  }

  #applyFullscreenState(fullscreen: boolean, target: QuoxElement): void {
    const connected = this.#connectedTarget(target);
    const path = connected === null ? [] : [...this.#renderer.element_path(target.nodeId)];
    if (fullscreen) {
      this.#renderer.set_fullscreen_element(target.nodeId);
      this.#fullscreenElement = target;
      this.#fullscreenPath = path;
    } else {
      this.#renderer.clear_fullscreen_element();
      this.#fullscreenElement = null;
      this.#fullscreenPath = [];
    }
    this.#requestRender();
    this.#dispatchFullscreenEvent(connected, "fullscreenchange", path);
  }

  #failTransition(transition: FullscreenTransition, message: string): void {
    const error = new TypeError(message);
    for (const waiter of transition.waiters) waiter.reject(error);
    this.#dispatchFullscreenEvent(this.#connectedTarget(transition.target), "fullscreenerror");
  }

  #rejectFullscreen(waiter: FullscreenWaiter, target: QuoxElement | null, message: string): void {
    waiter.reject(new TypeError(message));
    this.#dispatchFullscreenEvent(this.#connectedTarget(target), "fullscreenerror");
  }

  #finishPendingTimer(transition: FullscreenTransition): void {
    if (transition.timer !== undefined) clearTimeout(transition.timer);
  }

  #dispatchFullscreenEvent(
    target: QuoxElement | null,
    type: QuoxFullscreenEventType,
    knownPath?: readonly number[],
  ): void {
    const path = knownPath ?? (target === null ? [] : [...this.#renderer.element_path(target.nodeId)]);
    try {
      dispatchFullscreenEvent(this, target, path, type);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  get title(): string {
    this.#assertActive();
    return this.#renderer.title();
  }

  set title(value: string) {
    this.#assertActive();
    const title = String(value);
    this.#renderer.set_title(title);
    this.#lastNativeTitle = title;
    this.#setNativeTitle(title);
    this.#requestRender();
  }

  /** Synchronize the window title with the document's current `<title>` text. */
  syncNativeTitle(): void {
    this.#assertActive();
    const title = this.#renderer.title();
    if (title !== this.#lastNativeTitle) {
      this.#lastNativeTitle = title;
      this.#setNativeTitle(title);
    }
  }

  get documentElement(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.document_element());
  }

  get head(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.head());
  }

  get body(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.body());
  }

  /**
   * Return the DOM node at the given viewport-pixel coordinates (the same coordinate
   * space `mousemove` events use), or `null` if nothing is there. Does not distinguish
   * element vs. text hits.
   */
  nodeFromPoint(x: number, y: number): QuoxNode | null {
    this.#assertActive();
    const nodeId = this.#renderer.node_from_point(x, y);
    return nodeId === undefined ? null : new QuoxNode(this, nodeId);
  }

  /** Dispatch a pointer-move event, updating hover styles and the cursor. */
  dispatchPointerMove(x: number, y: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_move(x, y, buttons));
  }

  /** Dispatch a pointer-down event, updating `:active`, focus, and click interactions. */
  dispatchPointerDown(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_down(x, y, button, buttons));
  }

  /** Dispatch a pointer-up event, potentially firing `click`, `dblclick`, or `contextmenu`. */
  dispatchPointerUp(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_up(x, y, button, buttons));
  }

  /** Dispatch a wheel event, scrolling the content under the pointer. */
  dispatchWheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_wheel(x, y, deltaX, deltaY, buttons));
  }

  /** Dispatch a keyboard event. Use `dispatchTextInput` separately for text committed by the keyboard layout. */
  dispatchKey(event: QuoxKeyboardEvent): void {
    const encoded = encodeKeyEvent(event);
    this.#dispatchInputEvent(() =>
      this.#renderer.dispatch_key_event(
        encoded.code,
        encoded.key,
        encoded.modifierBits,
        encoded.location,
        encoded.eventFlags,
      )
    );
  }

  /** Dispatch a standard macOS editing command identified by its AppKit selector. */
  dispatchAppleStandardKeybinding(event: QuoxAppleStandardKeybindingEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_apple_standard_keybinding(event.command));
  }

  /** Insert text committed by the active keyboard layout. */
  dispatchTextInput(event: QuoxTextInputEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_text_input(event.text));
  }

  /** Clear hover styles and reset the cursor, such as when the pointer leaves the window. */
  clearHover(): void {
    this.#dispatchInputEvent(() => this.#renderer.clear_hover(), false);
  }

  #dispatchInputEvent(dispatch: () => boolean, drainFiredEvents = true): void {
    this.#assertActive();
    if (dispatch()) this.#requestRender();
    if (drainFiredEvents) this.#drainFiredEvents();
  }

  /**
   * After a dispatch call, check which (if any) of the JS-handler-relevant DOM events fired
   * and invoke matching `on*` handlers target-to-root along Blitz's frozen element path.
   */
  #drainFiredEvents(): void {
    this.#invokeHandlers(this.#renderer.take_click_path(), "click");
    this.#invokeHandlers(this.#renderer.take_double_click_path(), "dblclick");
    this.#invokeHandlers(this.#renderer.take_context_menu_path(), "contextmenu");
    this.#invokeHandlers(this.#renderer.take_input_path(), "input");
    this.#invokeHandlers(this.#renderer.take_focus_path(), "focus");
    this.#invokeHandlers(this.#renderer.take_blur_path(), "blur");
    this.#invokeHandlers(this.#renderer.take_scroll_path(), "scroll");
  }

  #invokeHandlers(path: Uint32Array, type: QuoxEventType): void {
    if (path.length === 0) return;
    invokeEventHandlers(this, path, type);
  }

  createElement(tagName: string): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.create_element(tagName));
  }

  createTextNode(text: string): QuoxText {
    this.#assertActive();
    return new QuoxText(this, this.#renderer.create_text_node(text));
  }
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameElement(left: QuoxElement | null, right: QuoxElement): boolean {
  return left !== null && left.ownerDocument === right.ownerDocument && left.nodeId === right.nodeId;
}
