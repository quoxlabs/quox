import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { getElementFunctionProps } from "./handlers.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { QuoxElement, QuoxNode, QuoxText } from "./node.ts";

type SetNativeTitle = (title: string) => void;
type SyncNativeImeRequests = () => void;

type RendererInputBridge = {
  dispatch_pointer_move(x: number, y: number, buttons: number): boolean;
  dispatch_pointer_down(x: number, y: number, button: number, buttons: number): boolean;
  dispatch_pointer_up(x: number, y: number, button: number, buttons: number): boolean;
  dispatch_wheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): boolean;
  dispatch_key_down(
    code: string,
    shiftKey: boolean,
    ctrlKey: boolean,
    altKey: boolean,
    metaKey: boolean,
    capsLock: boolean,
    logicalKey: string | undefined,
    text: string | undefined,
    repeat: boolean,
  ): boolean;
  dispatch_key_up(
    code: string,
    shiftKey: boolean,
    ctrlKey: boolean,
    altKey: boolean,
    metaKey: boolean,
    capsLock: boolean,
    logicalKey?: string,
  ): boolean;
  dispatch_ime_enabled(): boolean;
  dispatch_ime_disabled(): boolean;
  dispatch_ime_preedit(text: string, start?: number, end?: number): boolean;
  dispatch_ime_commit(text: string): boolean;
  clear_hover(): boolean;
  take_click_node(): number | undefined;
  take_double_click_node(): number | undefined;
  take_context_menu_node(): number | undefined;
  take_input_node(): number | undefined;
  take_focus_node(): number | undefined;
  take_blur_node(): number | undefined;
  take_scroll_node(): number | undefined;
};

type InputRenderer = WasmRenderer & RendererInputBridge;

export type QuoxImeEvent =
  | { type: "ime"; kind: "enabled" | "disabled" }
  | {
    type: "ime";
    kind: "preedit";
    text: string;
    /** UTF-8 byte offsets; omitted when the preedit cursor should be hidden. */
    cursorRange?: readonly [number, number];
  }
  | { type: "ime"; kind: "commit"; text: string }
  | {
    type: "ime";
    kind: "deleteSurrounding";
    /** UTF-8 byte count before the cursor. */
    beforeLength: number;
    /** UTF-8 byte count after the cursor. */
    afterLength: number;
  };

/**
 * Maps the DOM event kinds quox can invoke a JS handler for to their JSX prop name.
 * `dblclick`'s prop deliberately doesn't match the raw event name — it mirrors React's
 * actual `onDoubleClick` convention instead.
 */
const EVENT_KIND_TO_PROP = {
  click: "onClick",
  dblclick: "onDoubleClick",
  contextmenu: "onContextMenu",
  input: "onInput",
  focus: "onFocus",
  blur: "onBlur",
  scroll: "onScroll",
} as const;

export class QuoxDocument {
  readonly #renderer: InputRenderer;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  readonly #syncNativeImeRequests: SyncNativeImeRequests;
  #lastNativeTitle: string;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
    syncNativeImeRequests: SyncNativeImeRequests = () => undefined,
  ) {
    this.#renderer = renderer as InputRenderer;
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
    this.#syncNativeImeRequests = syncNativeImeRequests;
    this.#lastNativeTitle = renderer.title();
    attachDocumentInternals(this, { renderer, requestRender, assertActive });
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

  /**
   * Push the live `<title>` text to the native window if it changed since the last push. Called
   * once per render pass so title-affecting DOM edits (e.g. appending a `<title>` element, or
   * editing one via `textContent`/`innerHTML`) reach the OS without every DOM mutation in the
   * document paying for a `<head>` lookup.
   */
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

  /** Feed a pointer-move event into Blitz. Drives hover/`:hover` and cursor resolution. */
  dispatchPointerMove(x: number, y: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_move(x, y, buttons));
  }

  /** Feed a pointer-down event into Blitz. Drives `:active`, click timing, and focus. */
  dispatchPointerDown(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_down(x, y, button, buttons));
  }

  /** Feed a pointer-up event into Blitz. Synthesizes `click`/`dblclick`/`contextmenu`. */
  dispatchPointerUp(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_up(x, y, button, buttons));
  }

  /** Feed a wheel event into Blitz, scrolling whatever's hovered (not just the viewport). */
  dispatchWheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_wheel(x, y, deltaX, deltaY, buttons));
  }

  /** Feed a keydown event into Blitz. Drives text-input editing and Tab focus traversal. */
  dispatchKeyDown(
    code: string,
    shiftKey: boolean,
    ctrlKey: boolean,
    altKey: boolean,
    metaKey: boolean,
    capsLock: boolean,
    logicalKey?: string,
    text?: string,
    repeat = false,
  ): void {
    this.#dispatchInputEvent(() =>
      this.#renderer.dispatch_key_down(
        code,
        shiftKey,
        ctrlKey,
        altKey,
        metaKey,
        capsLock,
        logicalKey,
        text,
        repeat,
      )
    );
  }

  /** Feed a keyup event into Blitz. */
  dispatchKeyUp(
    code: string,
    shiftKey: boolean,
    ctrlKey: boolean,
    altKey: boolean,
    metaKey: boolean,
    capsLock: boolean,
    logicalKey?: string,
  ): void {
    this.#dispatchInputEvent(() =>
      this.#renderer.dispatch_key_up(code, shiftKey, ctrlKey, altKey, metaKey, capsLock, logicalKey)
    );
  }

  /** Feed native IME lifecycle and edit events into Blitz. */
  dispatchIme(event: QuoxImeEvent): void {
    switch (event.kind) {
      case "enabled":
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_enabled());
        break;
      case "disabled":
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_disabled());
        break;
      case "preedit": {
        const start = event.cursorRange?.[0];
        const end = event.cursorRange?.[1];
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_preedit(event.text, start, end));
        break;
      }
      case "commit":
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_commit(event.text));
        break;
      case "deleteSurrounding":
        // The pinned Blitz input API does not yet expose delete-surrounding. Keep the
        // event observable at the QuoxWindow layer without pretending it was applied.
        this.#dispatchInputEvent(() => false);
        break;
    }
  }

  /** Clear Blitz's hover state, e.g. when the pointer leaves the window entirely. */
  clearHover(): void {
    this.#dispatchInputEvent(() => this.#renderer.clear_hover(), false);
  }

  #dispatchInputEvent(dispatch: () => boolean, drainFiredEvents = true): void {
    this.#assertActive();
    try {
      if (dispatch()) this.#requestRender();
      if (drainFiredEvents) this.#drainFiredEvents();
    } finally {
      this.#syncNativeImeRequests();
    }
  }

  /**
   * After a dispatch call, check which (if any) of the JS-handler-relevant DOM events fired
   * and invoke the matching JSX `onXxx` prop registered on the exact target node. This is
   * target-only — it does not bubble to ancestors the way native DOM event dispatch would.
   */
  #drainFiredEvents(): void {
    this.#invokeHandler(this.#renderer.take_click_node(), "click");
    this.#invokeHandler(this.#renderer.take_double_click_node(), "dblclick");
    this.#invokeHandler(this.#renderer.take_context_menu_node(), "contextmenu");
    this.#invokeHandler(this.#renderer.take_input_node(), "input");
    this.#invokeHandler(this.#renderer.take_focus_node(), "focus");
    this.#invokeHandler(this.#renderer.take_blur_node(), "blur");
    this.#invokeHandler(this.#renderer.take_scroll_node(), "scroll");
  }

  #invokeHandler(nodeId: number | undefined, kind: keyof typeof EVENT_KIND_TO_PROP): void {
    if (nodeId === undefined) return;
    const handlers = getElementFunctionProps(new QuoxNode(this, nodeId));
    handlers?.get(EVENT_KIND_TO_PROP[kind])?.();
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
