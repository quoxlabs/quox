import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { eventDispatchInternals, QuoxEvent } from "./event.ts";
import { invokeEventListeners, QuoxEventTarget } from "./event_target.ts";
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
import { runWithImeSynchronization } from "./ime_requests.ts";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { ELEMENT_NODE, QuoxNodeCache, TEXT_NODE } from "./node_cache.ts";
import type { QuoxElement, QuoxNode, QuoxText } from "./node.ts";
import {
  type DomDispatchEventStep,
  DomDispatchInitialStepError,
  DomDispatchRendererPort,
  type DomDispatchStep,
} from "./renderer_port.ts";

type SetNativeTitle = (title: string) => void;
type SyncNativeImeRequests = () => void;
type NodeKindRenderer = WasmRenderer & { node_kind(nodeHandle: number): number };
type InvalidatingTitleRenderer = { set_title(title: string): Uint32Array };
type LegacyHoverRenderer = { clear_hover(): boolean };

const POINTER_BUTTONS_MASK = 0x1f;
const POINTER_MODIFIER_MASK = 0x0f;
const KEY_MODIFIER_MASK = 0x7f;
const KEY_EVENT_PRESSED = 0x01;
const KEY_EVENT_REPEAT = 0x02;
const KEY_EVENT_PREVENT_DEFAULT = 0x08;
const KEY_EVENT_MASK = 0x0f;

function assertEventTimeStamp(value: unknown): number {
  const timeStamp = assertFiniteNumber(value, "timeStamp");
  if (timeStamp < 0) throw new RangeError("quox: timeStamp must be finite and nonnegative");
  return timeStamp;
}

export class QuoxDocument extends QuoxEventTarget {
  readonly #renderer: WasmRenderer;
  readonly #dispatchPort: DomDispatchRendererPort;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  readonly #syncNativeImeRequests: SyncNativeImeRequests;
  readonly #defaultView: QuoxEventTarget | null;
  readonly #onDispatchIdle: () => void;
  readonly #nodes: QuoxNodeCache;
  #lastNativeTitle: string;
  #dispatchDepth = 0;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
    syncNativeImeRequests: SyncNativeImeRequests = () => undefined,
    defaultView: QuoxEventTarget | null = null,
    onDispatchIdle: () => void = () => undefined,
  ) {
    super();
    this.#renderer = renderer;
    this.#dispatchPort = new DomDispatchRendererPort(renderer);
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
    this.#syncNativeImeRequests = syncNativeImeRequests;
    this.#defaultView = defaultView;
    this.#onDispatchIdle = onDispatchIdle;
    this.#nodes = new QuoxNodeCache(this);
    this.#lastNativeTitle = renderer.title();
    attachDocumentInternals(this, {
      renderer,
      requestRender,
      assertActive,
      invalidateNodeHandles: (nodeHandles) => this.#nodes.invalidate(nodeHandles),
      isDispatching: () => this.#dispatchDepth !== 0,
    });
  }

  get defaultView(): QuoxEventTarget | null {
    return this.#defaultView;
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
  dispatchPointerMove(
    x: number,
    y: number,
    buttons: number,
    modifierBits: number,
    timeStamp = performance.now(),
  ): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    timeStamp = assertEventTimeStamp(timeStamp);
    this.#dispatchInputEvent(() => this.#dispatchPort.beginPointerMove(x, y, buttons, modifierBits, timeStamp));
  }

  /** Feed a pointer-down event into Blitz. Drives `:active`, click timing, and focus. */
  dispatchPointerDown(
    x: number,
    y: number,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp = performance.now(),
    detail = 0,
  ): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    button = assertIntegerRange(button, 0, 4, "button");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    timeStamp = assertEventTimeStamp(timeStamp);
    detail = assertUint32(detail, "detail");
    this.#dispatchInputEvent(() =>
      this.#dispatchPort.beginPointerDown(x, y, button, buttons, modifierBits, timeStamp, detail)
    );
  }

  /** Feed a pointer-up event into Blitz. Synthesizes `click`/`dblclick`/`contextmenu`. */
  dispatchPointerUp(
    x: number,
    y: number,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp = performance.now(),
    detail = 0,
  ): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    button = assertIntegerRange(button, 0, 4, "button");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    timeStamp = assertEventTimeStamp(timeStamp);
    detail = assertUint32(detail, "detail");
    this.#dispatchInputEvent(() =>
      this.#dispatchPort.beginPointerUp(x, y, button, buttons, modifierBits, timeStamp, detail)
    );
  }

  /** Feed a wheel event into Blitz, scrolling whatever's hovered (not just the viewport). */
  dispatchWheel(
    x: number,
    y: number,
    blitzDeltaX: number,
    blitzDeltaY: number,
    buttons: number,
    modifierBits: number,
    deltaX = -blitzDeltaX,
    deltaY = -blitzDeltaY,
    deltaMode = 0,
    timeStamp = performance.now(),
  ): void {
    this.#assertActive();
    x = assertFloat32(x, "x");
    y = assertFloat32(y, "y");
    blitzDeltaX = assertFiniteNumber(blitzDeltaX, "blitzDeltaX");
    blitzDeltaY = assertFiniteNumber(blitzDeltaY, "blitzDeltaY");
    deltaX = assertFiniteNumber(deltaX, "deltaX");
    deltaY = assertFiniteNumber(deltaY, "deltaY");
    deltaMode = assertIntegerRange(deltaMode, 0, 2, "deltaMode");
    buttons = assertKnownMask(buttons, POINTER_BUTTONS_MASK, "buttons");
    modifierBits = assertKnownMask(modifierBits, POINTER_MODIFIER_MASK, "modifierBits");
    timeStamp = assertEventTimeStamp(timeStamp);
    this.#dispatchInputEvent(() =>
      this.#dispatchPort.beginWheel(
        x,
        y,
        blitzDeltaX,
        blitzDeltaY,
        deltaX,
        deltaY,
        deltaMode,
        buttons,
        modifierBits,
        timeStamp,
      )
    );
  }

  /** Feed a canonical native key event into Blitz. Character insertion remains a later Commit. */
  dispatchKey(event: QuoxKeyboardEvent): void {
    this.#assertActive();
    const encoded = encodeKeyEvent(event);
    encoded.modifierBits = assertKnownMask(encoded.modifierBits, KEY_MODIFIER_MASK, "modifierBits");
    encoded.keycode = assertUint32(encoded.keycode, "keycode");
    encoded.location = assertIntegerRange(encoded.location, 0, 3, "location");
    encoded.eventFlags = assertKnownMask(encoded.eventFlags, KEY_EVENT_MASK, "eventFlags");
    if (
      (encoded.eventFlags & KEY_EVENT_PRESSED) === 0 &&
      (encoded.eventFlags & (KEY_EVENT_REPEAT | KEY_EVENT_PREVENT_DEFAULT)) !== 0
    ) {
      throw new RangeError("quox: key release flags cannot repeat or suppress a keydown default");
    }
    this.#dispatchInputEvent(() =>
      this.#dispatchPort.beginKeyEvent(
        encoded.code,
        encoded.key,
        encoded.keycode,
        encoded.modifierBits,
        encoded.location,
        encoded.eventFlags,
      )
    );
  }

  /** Apply an AppKit editing selector through Blitz's platform-command adapter. */
  dispatchAppleStandardKeybinding(event: QuoxAppleStandardKeybindingEvent): void {
    this.#dispatchInputEvent(() => this.#dispatchPort.beginAppleStandardKeybinding(event.command));
  }

  /** Feed native IME lifecycle and edit events into Blitz. */
  dispatchIme(event: QuoxImeEvent): void {
    switch (event.kind) {
      case "enabled":
        this.#dispatchInputEvent(() => this.#dispatchPort.beginImeEnabled());
        break;
      case "disabled":
        this.#dispatchInputEvent(() => this.#dispatchPort.beginImeDisabled());
        break;
      case "preedit": {
        this.#assertActive();
        const range = assertUtf8ByteRange(event.text, event.cursorRange);
        const start = range?.[0] ?? undefined;
        const end = range?.[1] ?? undefined;
        this.#dispatchInputEvent(() => this.#dispatchPort.beginImePreedit(event.text, start, end));
        break;
      }
      case "commit":
        this.#dispatchInputEvent(() => this.#dispatchPort.beginImeCommit(event.text));
        break;
      case "deleteSurrounding": {
        this.#assertActive();
        const beforeBytes = assertUint32(event.beforeBytes, "beforeBytes");
        const afterBytes = assertUint32(event.afterBytes, "afterBytes");
        this.#dispatchInputEvent(() => this.#dispatchPort.beginImeDeleteSurrounding(beforeBytes, afterBytes));
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
    this.#assertActive();
    runWithImeSynchronization(() => {
      if ((this.#renderer as unknown as LegacyHoverRenderer).clear_hover()) this.#requestRender();
    }, () => this.#syncNativeImeRequests());
  }

  #dispatchInputEvent(begin: () => DomDispatchStep): void {
    this.#assertActive();
    this.#dispatchDepth += 1;
    let failed = false;
    let failure: unknown;
    let idleFailed = false;
    let idleFailure: unknown;
    try {
      runWithImeSynchronization(
        () => this.#beginAndPumpDispatchFrame(begin),
        () => this.#syncNativeImeRequests(),
      );
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.#dispatchDepth -= 1;
      if (this.#dispatchDepth === 0) {
        try {
          this.#onDispatchIdle();
        } catch (idleError) {
          idleFailed = true;
          idleFailure = idleError;
        }
      }
    }
    if (failed && idleFailed) {
      throw new AggregateError(
        [failure, idleFailure],
        "Quox DOM dispatch and dispatch cleanup both failed",
      );
    }
    if (failed) throw failure;
    if (idleFailed) throw idleFailure;
  }

  #beginAndPumpDispatchFrame(begin: () => DomDispatchStep): void {
    try {
      this.#pumpDispatchFrame(begin());
    } catch (error) {
      if (!(error instanceof DomDispatchInitialStepError)) throw error;
      this.#abortDispatchFrame(error.frameId, error.validationError);
    }
  }

  #pumpDispatchFrame(initialStep: DomDispatchStep): void {
    const frameId = initialStep.frameId;
    let step = initialStep;

    for (;;) {
      if (step.frameId !== frameId) {
        this.#abortDispatchFrame(frameId, new RangeError("quox: DOM dispatch step changed frame"));
      }

      if (step.kind === "complete") {
        if (step.redrawRequested) this.#requestRender();
        return;
      }

      let defaultPrevented: boolean;
      try {
        defaultPrevented = this.#dispatchTrustedEvent(step);
      } catch (error) {
        this.#resumePreventedThenAbort(step, error);
      }

      try {
        step = this.#dispatchPort.resumeDomDispatch(frameId, step.eventId, defaultPrevented!);
      } catch (error) {
        this.#abortDispatchFrame(frameId, error);
      }
    }
  }

  #dispatchTrustedEvent(step: DomDispatchEventStep): boolean {
    // Resolve every handle before listener 1. Mutations during dispatch may invalidate the cache,
    // but this event retains the exact wrapper path with which it began.
    const path: QuoxEventTarget[] = step.path.map((nodeHandle) => this.#nodeForHandle(nodeHandle));
    path.push(this);
    if (this.#defaultView !== null) path.push(this.#defaultView);

    const target = path[0];
    const event = new QuoxEvent(step.type, {
      bubbles: step.bubbles,
      cancelable: step.cancelable,
      composed: step.composed,
    });
    const dispatch = event[eventDispatchInternals];
    dispatch.begin(target, path, true, step.timeStamp);
    try {
      for (let index = path.length - 1; index > 0; index -= 1) {
        path[index][invokeEventListeners](event, "capturing", QuoxEvent.CAPTURING_PHASE);
        if (dispatch.propagationStopped) return dispatch.canceled;
      }

      target[invokeEventListeners](event, "at-target", QuoxEvent.AT_TARGET);
      if (event.bubbles && !dispatch.propagationStopped) {
        for (let index = 1; index < path.length; index += 1) {
          path[index][invokeEventListeners](event, "bubbling", QuoxEvent.BUBBLING_PHASE);
          if (dispatch.propagationStopped) break;
        }
      }
      return dispatch.canceled;
    } finally {
      dispatch.end();
    }
  }

  #resumePreventedThenAbort(step: DomDispatchEventStep, primaryError: unknown): never {
    const errors = [primaryError];
    let redrawRequested = false;
    try {
      const recoveryStep = this.#dispatchPort.resumeDomDispatch(step.frameId, step.eventId, true);
      redrawRequested = recoveryStep.kind === "complete" && recoveryStep.redrawRequested;
    } catch (error) {
      errors.push(error);
    }
    try {
      redrawRequested = this.#dispatchPort.abortDomDispatch(step.frameId) || redrawRequested;
    } catch (error) {
      errors.push(error);
    }
    if (redrawRequested) {
      try {
        this.#requestRender();
      } catch (error) {
        errors.push(error);
      }
    }
    throw dispatchFailure(errors);
  }

  #abortDispatchFrame(frameId: number, primaryError: unknown): never {
    const errors = [primaryError];
    try {
      if (this.#dispatchPort.abortDomDispatch(frameId)) {
        try {
          this.#requestRender();
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    throw dispatchFailure(errors);
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

function dispatchFailure(errors: unknown[]): unknown {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Quox DOM dispatch and renderer recovery both failed");
}
