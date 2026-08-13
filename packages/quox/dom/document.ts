import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { dispatchEventFrame, type QuoxEventFrame } from "./event_handlers.ts";
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
  #suppressNextKeyFollowup = false;

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
    const prevented = this.#dispatchInputEvent(() =>
      this.#renderer.dispatch_key_event(
        encoded.code,
        encoded.key,
        encoded.modifierBits,
        encoded.location,
        encoded.eventFlags,
      )
    );
    this.#suppressNextKeyFollowup = event.type === "keydown" &&
      event.editDisposition === "text-input" && prevented.has("keydown");
  }

  /** Apply an AppKit editing selector through Blitz's platform-command adapter. */
  dispatchAppleStandardKeybinding(event: QuoxAppleStandardKeybindingEvent): void {
    if (this.#suppressNextKeyFollowup) {
      this.#suppressNextKeyFollowup = false;
      return;
    }
    this.#suppressNextKeyFollowup = false;
    this.#dispatchInputEvent(() => this.#renderer.dispatch_apple_standard_keybinding(event.command));
  }

  /** Insert text committed by the active keyboard layout. */
  dispatchTextInput(event: QuoxTextInputEvent): void {
    if (this.#suppressNextKeyFollowup) {
      this.#suppressNextKeyFollowup = false;
      return;
    }
    this.#suppressNextKeyFollowup = false;
    this.#dispatchInputEvent(() => this.#renderer.dispatch_text_input(event.text));
  }

  /** Clear Blitz's hover state, e.g. when the pointer leaves the window entirely. */
  clearHover(): void {
    this.#dispatchInputEvent(() => this.#renderer.clear_hover(), false);
  }

  #dispatchInputEvent(dispatch: () => boolean, drainFiredEvents = true): Set<QuoxEventType> {
    this.#assertActive();
    let renderRequested = dispatch();
    const prevented = new Set<QuoxEventType>();
    const errors: unknown[] = [];

    if (drainFiredEvents) {
      for (;;) {
        const frame = this.#renderer.take_dom_event() as QuoxEventFrame | undefined;
        if (frame === undefined) break;
        const result = dispatchEventFrame(this, frame);
        if (result.defaultPrevented) prevented.add(frame.type);
        errors.push(...result.errors);
        if (this.#renderer.finish_dom_event(frame.token, result.defaultPrevented)) {
          renderRequested = true;
        }
      }
    }

    if (renderRequested) this.#requestRender();
    this.#reportHandlerErrors(errors);
    return prevented;
  }

  #reportHandlerErrors(errors: readonly unknown[]): void {
    if (errors.length === 0) return;
    const error = errors.length === 1 ? errors[0] : new AggregateError(errors, "Quox event handlers failed");
    queueMicrotask(() => {
      throw error;
    });
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
