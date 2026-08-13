import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { getElementFunctionProps } from "./handlers.ts";
import {
  encodeKeyEvent,
  type QuoxAppleStandardKeybindingEvent,
  type QuoxKeyboardEvent,
  type QuoxTextInputEvent,
} from "./input.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { QuoxElement, QuoxNode, QuoxText } from "./node.ts";

type SetNativeTitle = (title: string) => void;

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
  readonly #renderer: WasmRenderer;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  #lastNativeTitle: string;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
  ) {
    this.#renderer = renderer;
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
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

  /** Feed a pointer-move event into the engine. Drives hover/`:hover` and cursor resolution. */
  dispatchPointerMove(x: number, y: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_move(x, y, buttons));
  }

  /** Feed a pointer-down event into the engine. Drives `:active`, click timing, and focus. */
  dispatchPointerDown(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_down(x, y, button, buttons));
  }

  /** Feed a pointer-up event into the engine. Synthesizes `click`/`dblclick`/`contextmenu`. */
  dispatchPointerUp(x: number, y: number, button: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_up(x, y, button, buttons));
  }

  /** Feed a wheel event into the engine, scrolling whatever's hovered (not just the viewport). */
  dispatchWheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_wheel(x, y, deltaX, deltaY, buttons));
  }

  /** Feed a canonical native key event into the engine. Character insertion remains a later Commit. */
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

  /** Apply an AppKit editing selector through the engine's platform-command adapter. */
  dispatchAppleStandardKeybinding(event: QuoxAppleStandardKeybindingEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_apple_standard_keybinding(event.command));
  }

  /** Insert text committed by the active keyboard layout. */
  dispatchTextInput(event: QuoxTextInputEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_text_input(event.text));
  }

  /** Clear the engine's hover state, e.g. when the pointer leaves the window entirely. */
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
