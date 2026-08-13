import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { invokeEventHandlers } from "./event_handlers.ts";
import {
  encodeKeyEvent,
  type QuoxAppleStandardKeybindingEvent,
  type QuoxKeyboardEvent,
  type QuoxTextInputEvent,
} from "./input.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { QuoxElement, type QuoxEventType, QuoxNode, QuoxText } from "./node.ts";

type SetNativeTitle = (title: string) => void;

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

  /** Feed a canonical native key event into Blitz. Character insertion remains a later Commit. */
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

  /** Apply an AppKit editing selector through Blitz's platform-command adapter. */
  dispatchAppleStandardKeybinding(event: QuoxAppleStandardKeybindingEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_apple_standard_keybinding(event.command));
  }

  /** Insert text committed by the active keyboard layout. */
  dispatchTextInput(event: QuoxTextInputEvent): void {
    this.#dispatchInputEvent(() => this.#renderer.dispatch_text_input(event.text));
  }

  /** Clear Blitz's hover state, e.g. when the pointer leaves the window entirely. */
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
