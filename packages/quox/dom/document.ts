import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { eventDispatchInternals, QuoxEvent } from "./event.ts";
import { eventTargetPath, invokeEventListeners, QuoxEventTarget } from "./event_target.ts";
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
import { ELEMENT_NODE, GENERIC_ELEMENT_INTERFACE, QuoxNodeCache, TEXT_NODE } from "./node_cache.ts";
import { QuoxElement, type QuoxInputElement, type QuoxNode, type QuoxText, type QuoxTextAreaElement } from "./node.ts";
import {
  type DomDispatchEventStep,
  type DomDispatchFocusPayload,
  DomDispatchInitialStepError,
  type DomDispatchInputPayload,
  type DomDispatchKeyboardPayload,
  type DomDispatchMousePayload,
  type DomDispatchPointerPayload,
  DomDispatchRendererPort,
  type DomDispatchStep,
  type DomDispatchWheelPayload,
} from "./renderer_port.ts";
import {
  createTrustedMouseEventInit,
  QuoxDOMInputEvent,
  QuoxDOMKeyboardEvent,
  QuoxFocusEvent,
  QuoxMouseEvent,
  type QuoxMouseEventInit,
  QuoxPointerEvent,
  QuoxWheelEvent,
} from "./ui_event.ts";

type SetNativeTitle = (title: string) => void;
type SyncNativeImeRequests = () => void;
type IsActive = () => boolean;
type NodeKindRenderer = WasmRenderer & { node_kind(nodeHandle: number): number };
type SyntheticEventPathRenderer = WasmRenderer & {
  synthetic_event_path(nodeHandle: number): Uint32Array;
};
type InvalidatingTitleRenderer = { set_title(title: string): Uint32Array };
type LegacyHoverRenderer = { clear_hover(): boolean };
type ElementInterfaceRenderer = { element_interface(nodeHandle: number): number };
type ActiveElementRenderer = { active_element(): number | undefined };

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
  readonly #isActive: IsActive;
  readonly #nodes: QuoxNodeCache;
  #pendingScrollTargets: QuoxEventTarget[] = [];
  #pendingScrollTargetSet = new Set<QuoxEventTarget>();
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
    isActive?: IsActive,
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
    this.#isActive = isActive ?? (() => {
      try {
        assertActive();
        return true;
      } catch {
        return false;
      }
    });
    this.#nodes = new QuoxNodeCache(this);
    this.#lastNativeTitle = renderer.title();
    attachDocumentInternals(this, {
      renderer,
      requestRender,
      assertActive,
      invalidateNodeHandles: (nodeHandles) => this.#nodes.invalidate(nodeHandles),
      queueScrollEvent: (nodeHandle) => {
        if (this.#queuePendingScrollTarget(nodeHandle)) this.#requestRender();
      },
      isDispatching: () => this.#dispatchDepth !== 0,
      focusElement: (nodeHandle) => {
        this.#dispatchInputEvent(() => this.#dispatchPort.beginFocus(nodeHandle));
      },
      blurElement: (nodeHandle) => {
        this.#dispatchInputEvent(() => this.#dispatchPort.beginBlur(nodeHandle));
      },
      syntheticEventPath: (nodeHandle, event) => this.#syntheticEventPath(nodeHandle, event),
    });
  }

  get defaultView(): QuoxEventTarget | null {
    return this.#defaultView;
  }

  override [eventTargetPath](event: QuoxEvent): readonly QuoxEventTarget[] {
    return this.#defaultView === null || event.type === "load" ? [this] : [this, this.#defaultView];
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

  /** Dispatch CSSOM View's coalesced scroll list at the next rendering opportunity. */
  flushPendingScrollEvents(): void {
    this.#assertActive();
    if (this.#pendingScrollTargets.length === 0) return;
    this.#dispatchDepth += 1;
    let failed = false;
    let failure: unknown;
    let idleFailed = false;
    let idleFailure: unknown;
    try {
      for (let index = 0; index < this.#pendingScrollTargets.length; index += 1) {
        if (!this.#isActive()) break;
        const target = this.#pendingScrollTargets[index];
        const event = new QuoxEvent("scroll", { bubbles: target === this });
        const path = target === this || this.#nodes.isCurrent(target as QuoxNode)
          ? Array.from(target[eventTargetPath](event))
          : [target];
        this.#dispatchTrustedEventOnPath(event, target, path, performance.now());
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.#pendingScrollTargets = [];
      this.#pendingScrollTargetSet = new Set();
      this.#dispatchDepth -= 1;
      if (this.#dispatchDepth === 0) {
        try {
          this.#onDispatchIdle();
        } catch (error) {
          idleFailed = true;
          idleFailure = error;
        }
      }
    }
    if (failed && idleFailed) {
      throw new AggregateError(
        [failure, idleFailure],
        "Quox scroll dispatch and dispatch cleanup both failed",
      );
    }
    if (failed) throw failure;
    if (idleFailed) throw idleFailure;
  }

  get documentElement(): QuoxElement {
    this.#assertActive();
    return this.#elementForHandle(this.#renderer.document_element());
  }

  get head(): QuoxElement {
    this.#assertActive();
    return this.#elementForHandle(this.#renderer.head());
  }

  get body(): QuoxElement {
    this.#assertActive();
    return this.#elementForHandle(this.#renderer.body());
  }

  get activeElement(): QuoxElement | null {
    this.#assertActive();
    const nodeHandle = (this.#renderer as unknown as ActiveElementRenderer).active_element();
    return nodeHandle === undefined ? null : this.#elementForHandle(nodeHandle);
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
    detail = assertIntegerRange(detail, 0, 0x7fff_ffff, "detail");
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
    detail = assertIntegerRange(detail, 0, 0x7fff_ffff, "detail");
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
      if (step.type === "scroll") {
        try {
          this.#queuePendingScrollTarget(step.target);
        } catch (error) {
          this.#resumePreventedThenAbort(step, error);
        }
        defaultPrevented = false;
      } else {
        try {
          defaultPrevented = this.#dispatchTrustedEvent(step);
        } catch (error) {
          this.#resumePreventedThenAbort(step, error);
        }
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
    const event = this.#createTrustedEvent(step);
    return this.#dispatchTrustedEventOnPath(event, target, path, step.timeStamp);
  }

  #dispatchTrustedEventOnPath(
    event: QuoxEvent,
    target: QuoxEventTarget,
    path: readonly QuoxEventTarget[],
    timeStamp: number,
  ): boolean {
    const dispatch = event[eventDispatchInternals];
    dispatch.begin(target, path, true, timeStamp);
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

  #queuePendingScrollTarget(nodeHandle: number): boolean {
    const element = this.#nodeForHandle(nodeHandle);
    if (!(element instanceof QuoxElement)) {
      throw new TypeError("quox: a trusted scroll target must be an element");
    }
    const target = nodeHandle === this.#renderer.document_element() ? this : element;
    if (this.#pendingScrollTargetSet.has(target)) return false;
    this.#pendingScrollTargetSet.add(target);
    this.#pendingScrollTargets.push(target);
    return true;
  }

  #createTrustedEvent(step: DomDispatchEventStep): QuoxEvent {
    const eventInit = {
      bubbles: step.bubbles,
      cancelable: step.cancelable,
      composed: step.composed,
    };

    switch (step.type) {
      case "pointermove":
      case "pointerdown":
      case "pointerup":
      case "pointerenter":
      case "pointerleave":
      case "pointerover":
      case "pointerout":
      case "click":
      case "auxclick":
      case "contextmenu": {
        const payload = step.payload as DomDispatchPointerPayload;
        return new QuoxPointerEvent(
          step.type,
          this.#trustedMouseInit(step, payload, {
            pointerId: payload.pointerId,
            pointerType: payload.pointerType,
            isPrimary: payload.isPrimary,
            width: payload.width,
            height: payload.height,
            pressure: payload.pressure,
            tangentialPressure: payload.tangentialPressure,
            tiltX: payload.tiltX,
            tiltY: payload.tiltY,
            twist: payload.twist,
            altitudeAngle: payload.altitudeAngle,
            azimuthAngle: payload.azimuthAngle,
            persistentDeviceId: payload.persistentDeviceId,
          }),
        );
      }
      case "mousemove":
      case "mousedown":
      case "mouseup":
      case "mouseenter":
      case "mouseleave":
      case "mouseover":
      case "mouseout":
      case "dblclick":
        return new QuoxMouseEvent(
          step.type,
          this.#trustedMouseInit(step, step.payload as DomDispatchMousePayload),
        );
      case "wheel": {
        const payload = step.payload as DomDispatchWheelPayload;
        return new QuoxWheelEvent(
          step.type,
          this.#trustedMouseInit(step, payload, {
            deltaX: payload.deltaX,
            deltaY: payload.deltaY,
            deltaZ: payload.deltaZ,
            deltaMode: payload.deltaMode,
          }),
        );
      }
      case "keypress":
      case "keydown":
      case "keyup": {
        const payload = step.payload as DomDispatchKeyboardPayload;
        return new QuoxDOMKeyboardEvent(step.type, {
          ...eventInit,
          view: this.#defaultView,
          key: payload.key,
          code: payload.code,
          location: payload.location,
          repeat: payload.repeat,
          isComposing: payload.isComposing,
          keyCode: payload.keyCode,
          shiftKey: payload.shiftKey,
          ctrlKey: payload.ctrlKey,
          altKey: payload.altKey,
          metaKey: payload.metaKey,
          modifierCapsLock: payload.capsLock,
          modifierAltGraph: payload.altGraphKey,
        });
      }
      case "input": {
        const payload = step.payload as DomDispatchInputPayload;
        return new QuoxDOMInputEvent(step.type, {
          ...eventInit,
          view: this.#defaultView,
          data: payload.data,
          inputType: payload.inputType,
          isComposing: payload.isComposing,
        });
      }
      case "focus":
      case "blur":
      case "focusin":
      case "focusout": {
        const payload = step.payload as DomDispatchFocusPayload;
        return new QuoxFocusEvent(step.type, {
          ...eventInit,
          view: this.#defaultView,
          relatedTarget: this.#relatedTarget(payload.relatedTarget),
        });
      }
      case "scroll":
        return new QuoxEvent(step.type, eventInit);
      default:
        return assertNever(step.type);
    }
  }

  #trustedMouseInit<Extra extends object = Record<never, never>>(
    step: DomDispatchEventStep,
    payload: DomDispatchMousePayload,
    extra?: Extra,
  ): QuoxMouseEventInit & Extra {
    return createTrustedMouseEventInit(
      {
        bubbles: step.bubbles,
        cancelable: step.cancelable,
        composed: step.composed,
        view: this.#defaultView,
        screenX: payload.screenX,
        screenY: payload.screenY,
        clientX: payload.clientX,
        clientY: payload.clientY,
        button: payload.button,
        buttons: payload.buttons,
        detail: payload.detail,
        shiftKey: payload.shiftKey,
        ctrlKey: payload.ctrlKey,
        altKey: payload.altKey,
        metaKey: payload.metaKey,
        relatedTarget: this.#relatedTarget(payload.relatedTarget),
        ...extra,
      },
      {
        pageX: payload.pageX,
        pageY: payload.pageY,
        offsetX: payload.offsetX,
        offsetY: payload.offsetY,
      },
    ) as QuoxMouseEventInit & Extra;
  }

  #relatedTarget(nodeHandle: number | null): QuoxEventTarget | null {
    return nodeHandle === null ? null : this.#nodeForHandle(nodeHandle);
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
    return nodeKind === ELEMENT_NODE ? this.#elementForHandle(nodeHandle) : this.#nodes.get(nodeHandle, nodeKind);
  }

  #elementForHandle(nodeHandle: number): QuoxElement {
    nodeHandle = assertUint32(nodeHandle, "nodeHandle");
    // Keeping the fallback makes source-level tests and older embedders fail soft as generic
    // elements. Current Quox WASM always supplies the interface query.
    const interfaceQuery = (this.#renderer as unknown as Partial<ElementInterfaceRenderer>)
      .element_interface;
    const elementInterface = typeof interfaceQuery === "function"
      ? interfaceQuery.call(this.#renderer, nodeHandle)
      : GENERIC_ELEMENT_INTERFACE;
    return this.#nodes.get(nodeHandle, ELEMENT_NODE, elementInterface);
  }

  #syntheticEventPath(nodeHandle: number, event: QuoxEvent): readonly QuoxEventTarget[] {
    this.#assertActive();
    nodeHandle = assertUint32(nodeHandle, "nodeHandle");
    const rawPath = (this.#renderer as SyntheticEventPathRenderer).synthetic_event_path(nodeHandle);
    if (
      Object.getPrototypeOf(rawPath) !== Uint32Array.prototype ||
      rawPath.length === 0 ||
      rawPath[0] !== nodeHandle
    ) {
      throw new TypeError("quox: renderer returned an invalid synthetic event path");
    }

    const path: QuoxEventTarget[] = [];
    const seen = new Set<number>();
    for (let index = 0; index < rawPath.length; index += 1) {
      const handle = rawPath[index];
      if (handle === 0) {
        if (index !== rawPath.length - 1) {
          throw new TypeError("quox: document marker must end a synthetic event path");
        }
        path.push(this);
        if (this.#defaultView !== null && event.type !== "load") path.push(this.#defaultView);
      } else {
        if (seen.has(handle)) {
          throw new TypeError("quox: synthetic event path must not repeat a node handle");
        }
        seen.add(handle);
        path.push(this.#nodeForHandle(handle));
      }
    }
    return path;
  }

  createElement(tagName: "input"): QuoxInputElement;
  createElement(tagName: "textarea"): QuoxTextAreaElement;
  createElement(tagName: string): QuoxElement;
  createElement(tagName: string): QuoxElement {
    this.#assertActive();
    return this.#elementForHandle(this.#renderer.create_element(tagName));
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
