import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { getElementFunctionProps } from "./handlers.ts";
import {
  encodeKeyEvent,
  type QuoxAppleStandardKeybindingEvent,
  type QuoxImeEvent,
  type QuoxKeyboardEvent,
} from "./input.ts";
import {
  assertFiniteNumber,
  assertFloat32,
  assertIntegerRange,
  assertKnownMask,
  assertUint32,
  assertUtf8ByteRange,
} from "./ffi_numbers.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { ELEMENT_NODE, QuoxNodeCache, TEXT_NODE } from "./node_cache.ts";
import type { QuoxElement, QuoxNode, QuoxText } from "./node.ts";

type SetNativeTitle = (title: string) => void;
type SyncNativeImeRequests = () => void;
type NodeKindRenderer = WasmRenderer & { node_kind(nodeHandle: number): number };
type InvalidatingTitleRenderer = WasmRenderer & { set_title(title: string): Uint32Array };

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

const POINTER_BUTTONS_MASK = 0x1f;
const POINTER_MODIFIER_MASK = 0x0f;
const KEY_MODIFIER_MASK = 0x3f;
const KEY_EVENT_PRESSED = 0x01;
const KEY_EVENT_REPEAT = 0x02;
const KEY_EVENT_PREVENT_DEFAULT = 0x08;
const KEY_EVENT_MASK = 0x0f;

export class QuoxDocument {
  readonly #renderer: WasmRenderer;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  readonly #syncNativeImeRequests: SyncNativeImeRequests;
  readonly #nodes: QuoxNodeCache;
  #lastNativeTitle: string;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
    syncNativeImeRequests: SyncNativeImeRequests = () => undefined,
  ) {
    this.#renderer = renderer;
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
    this.#syncNativeImeRequests = syncNativeImeRequests;
    this.#nodes = new QuoxNodeCache(this);
    this.#lastNativeTitle = renderer.title();
    attachDocumentInternals(this, {
      renderer,
      requestRender,
      assertActive,
      invalidateNodeHandles: (nodeHandles) => this.#nodes.invalidate(nodeHandles),
    });
  }

  get title(): string {
    this.#assertActive();
    return this.#renderer.title();
  }

  set title(value: string) {
    this.#assertActive();
    const title = String(value);
    const invalidated = (this.#renderer as unknown as InvalidatingTitleRenderer).set_title(title);
    this.#nodes.invalidate(invalidated);
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
    return this.#nodes.get(this.#renderer.document_element(), ELEMENT_NODE);
  }

  get head(): QuoxElement {
    this.#assertActive();
    return this.#nodes.get(this.#renderer.head(), ELEMENT_NODE);
  }

  get body(): QuoxElement {
    this.#assertActive();
    return this.#nodes.get(this.#renderer.body(), ELEMENT_NODE);
  }

  /**
   * Return the DOM node at the given logical viewport coordinates (the same coordinate
   * space `mousemove` events use), or `null` if nothing is there. Does not distinguish
   * element vs. text hits.
   */
  nodeFromPoint(x: number, y: number): QuoxNode | null {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    const nodeHandle = this.#renderer.node_from_point(x, y);
    return nodeHandle === undefined ? null : this.#nodeForHandle(nodeHandle);
  }

  /** Feed a pointer-move event into Blitz. Drives hover/`:hover` and cursor resolution. */
  dispatchPointerMove(x: number, y: number, buttons: number, modifierBits: number): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_move(x, y, buttons, modifierBits));
  }

  /** Feed a pointer-down event into Blitz. Drives `:active`, click timing, and focus. */
  dispatchPointerDown(x: number, y: number, button: number, buttons: number, modifierBits: number): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    button = assertIntegerRange(button, 0, 4, "button");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_down(x, y, button, buttons, modifierBits));
  }

  /** Feed a pointer-up event into Blitz. Synthesizes `click`/`dblclick`/`contextmenu`. */
  dispatchPointerUp(x: number, y: number, button: number, buttons: number, modifierBits: number): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    button = assertIntegerRange(button, 0, 4, "button");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    this.#dispatchInputEvent(() => this.#renderer.dispatch_pointer_up(x, y, button, buttons, modifierBits));
  }

  /** Feed a wheel event into Blitz, scrolling whatever's hovered (not just the viewport). */
  dispatchWheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number, modifierBits: number): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    deltaX = assertFiniteNumber(deltaX, "deltaX");
    deltaY = assertFiniteNumber(deltaY, "deltaY");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    this.#dispatchInputEvent(() => this.#renderer.dispatch_wheel(x, y, deltaX, deltaY, buttons, modifierBits));
  }

  /** Feed a canonical native key event into Blitz. Character insertion remains a later Commit. */
  dispatchKey(event: QuoxKeyboardEvent): void {
    this.#assertActive();
    const encoded = encodeKeyEvent(event);
    encoded.modifierBits = assertKnownMask(encoded.modifierBits, KEY_MODIFIER_MASK, "modifierBits");
    encoded.location = assertIntegerRange(encoded.location, 0, 3, "location");
    encoded.eventFlags = assertKnownMask(encoded.eventFlags, KEY_EVENT_MASK, "eventFlags");
    if (
      (encoded.eventFlags & KEY_EVENT_PRESSED) === 0 &&
      (encoded.eventFlags & (KEY_EVENT_REPEAT | KEY_EVENT_PREVENT_DEFAULT)) !== 0
    ) {
      throw new RangeError("quox: key release flags cannot repeat or suppress a keydown default");
    }
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
        this.#assertActive();
        const range = assertUtf8ByteRange(event.text, event.cursorRange);
        const start = range?.[0] ?? undefined;
        const end = range?.[1] ?? undefined;
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_preedit(event.text, start, end));
        break;
      }
      case "commit":
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_commit(event.text));
        break;
      case "deleteSurrounding": {
        this.#assertActive();
        const beforeBytes = assertUint32(event.beforeBytes, "beforeBytes");
        const afterBytes = assertUint32(event.afterBytes, "afterBytes");
        this.#dispatchInputEvent(() => this.#renderer.dispatch_ime_delete_surrounding(beforeBytes, afterBytes));
        break;
      }
      case "replace":
        throw new Error("quox: atomic IME replacement is not connected to Blitz yet");
      default:
        return assertNever(event);
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

  #invokeHandler(nodeHandle: number | undefined, kind: keyof typeof EVENT_KIND_TO_PROP): void {
    if (nodeHandle === undefined) return;
    const handlers = getElementFunctionProps(this.#nodeForHandle(nodeHandle));
    handlers?.get(EVENT_KIND_TO_PROP[kind])?.();
  }

  #nodeForHandle(nodeHandle: number): QuoxNode {
    nodeHandle = assertUint32(nodeHandle, "nodeHandle");
    const nodeKind = (this.#renderer as NodeKindRenderer).node_kind(nodeHandle);
    return this.#nodes.get(nodeHandle, nodeKind);
  }

  createElement(tagName: string): QuoxElement {
    this.#assertActive();
    return this.#nodes.get(this.#renderer.create_element(tagName), ELEMENT_NODE);
  }

  createTextNode(text: string): QuoxText {
    this.#assertActive();
    return this.#nodes.get(this.#renderer.create_text_node(text), TEXT_NODE);
  }
}

function assertNever(_value: never): never {
  throw new TypeError("Unsupported Quox IME event");
}
