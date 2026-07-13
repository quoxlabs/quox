import type {
  AppleStandardKeybindingEvent as WindingAppleStandardKeybindingEvent,
  ButtonEvent as WindingButtonEvent,
  EnterLeaveEvent as WindingEnterLeaveEvent,
  ImeEvent as WindingImeEvent,
  KeyEvent as WindingKeyEvent,
  MoveEvent as WindingMoveEvent,
  PointerCancelEvent as WindingPointerCancelEvent,
  PointerModifiers as WindingPointerModifiers,
  ResizeEvent as WindingResizeEvent,
  UIEvent as WindingUIEvent,
  WheelEvent as WindingWheelEvent,
} from "@quoxlabs/winding";
import { KeyEventFlag, KeyModifierMask, PointerModifierMask } from "../lib/quox.js";
import { wheelDeltaForBlitz } from "./wheel.ts";

export {
  applyImeRequestSnapshot,
  IME_REQUEST_FLAG,
  runWithImeSynchronization,
  synchronizeImeRequests,
} from "./ime_requests.ts";

type WithoutWindow<Event> = Event extends { window: unknown } ? Omit<Event, "window"> : never;

export type QuoxKeyboardEvent = WithoutWindow<WindingKeyEvent>;
export type QuoxImeEvent = WithoutWindow<WindingImeEvent>;
export type QuoxAppleStandardKeybindingEvent = WithoutWindow<WindingAppleStandardKeybindingEvent>;

export type QuoxMouseMoveEvent = WithoutWindow<WindingMoveEvent>;
export type QuoxPointerCancelEvent = WithoutWindow<WindingPointerCancelEvent>;
export type QuoxMouseButtonEvent = Omit<WithoutWindow<WindingButtonEvent>, "button"> & {
  button: number;
};
export type QuoxMouseWheelEvent = WithoutWindow<WindingWheelEvent>;
export type QuoxResizeEvent = WithoutWindow<WindingResizeEvent>;
export type QuoxCloseEvent = { type: "close" };
export type QuoxMouseEnterLeaveEvent = WithoutWindow<WindingEnterLeaveEvent>;
export type QuoxFocusChangeEvent = { type: "focus" | "blur" };
export type QuoxVisibilityEvent = { type: "visibilitychange"; visible: boolean };

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxPointerCancelEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent
  | QuoxImeEvent
  | QuoxAppleStandardKeybindingEvent
  | QuoxResizeEvent
  | QuoxCloseEvent
  | QuoxMouseEnterLeaveEvent
  | QuoxFocusChangeEvent
  | QuoxVisibilityEvent;

export interface QuoxInputRoutePort {
  pointerMove(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): void;
  pointerCancel(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    canceledButtons: number,
    modifierBits: number,
    timeStamp: number,
  ): void;
  pointerDown(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
    detail: number,
  ): void;
  pointerUp(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
    detail: number,
  ): void;
  pointerEnter(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): void;
  pointerLeave(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): void;
  wheel(
    x: number,
    y: number,
    screenX: number | null,
    screenY: number | null,
    blitzDeltaX: number,
    blitzDeltaY: number,
    buttons: number,
    modifierBits: number,
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    timeStamp: number,
  ): void;
  key(event: QuoxKeyboardEvent): void;
  ime(event: QuoxImeEvent): void;
  appleCommand(event: QuoxAppleStandardKeybindingEvent): void;
  resize(event: QuoxResizeEvent): void;
  focusChange(event: QuoxFocusChangeEvent): void;
  visibility(event: QuoxVisibilityEvent): void;
}

/** Deterministic, native-independent routing from canonical Quox events to the document port. */
export class QuoxInputRouter {
  #viewportWidth: number;
  #viewportHeight: number;

  constructor(readonly port: QuoxInputRoutePort, viewportWidth = 0, viewportHeight = 0) {
    this.#viewportWidth = viewportWidth;
    this.#viewportHeight = viewportHeight;
  }

  route(event: QuoxInputEvent): "close" | undefined {
    switch (event.type) {
      case "mousemove":
        this.port.pointerMove(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.buttons,
          encodePointerModifiers(event),
          event.timeStamp,
        );
        return undefined;
      case "pointercancel":
        this.port.pointerCancel(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.canceledButtons,
          encodePointerModifiers(event),
          event.timeStamp,
        );
        return undefined;
      case "mousedown":
        this.port.pointerDown(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.button,
          event.buttons,
          encodePointerModifiers(event),
          event.timeStamp,
          event.detail,
        );
        return undefined;
      case "mouseup":
        this.port.pointerUp(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.button,
          event.buttons,
          encodePointerModifiers(event),
          event.timeStamp,
          event.detail,
        );
        return undefined;
      case "mouseenter":
        this.port.pointerEnter(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.buttons,
          encodePointerModifiers(event),
          event.timeStamp,
        );
        return undefined;
      case "mouseleave":
        this.port.pointerLeave(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          event.buttons,
          encodePointerModifiers(event),
          event.timeStamp,
        );
        return undefined;
      case "wheel": {
        const [deltaX, deltaY] = wheelDeltaForBlitz(
          event.deltaX,
          event.deltaY,
          event.deltaMode,
          this.#viewportWidth,
          this.#viewportHeight,
        );
        this.port.wheel(
          event.x,
          event.y,
          event.screenX,
          event.screenY,
          deltaX,
          deltaY,
          event.buttons,
          encodePointerModifiers(event),
          event.deltaX,
          event.deltaY,
          event.deltaMode,
          event.timeStamp,
        );
        return undefined;
      }
      case "keydown":
      case "keyup":
        this.port.key(event);
        return undefined;
      case "ime":
        this.port.ime(event);
        return undefined;
      case "apple-standard-keybinding":
        this.port.appleCommand(event);
        return undefined;
      case "resize":
        this.#viewportWidth = event.width;
        this.#viewportHeight = event.height;
        this.port.resize(event);
        return undefined;
      case "visibilitychange":
        this.port.visibility(event);
        return undefined;
      case "focus":
      case "blur":
        this.port.focusChange(event);
        return undefined;
      case "close":
        return "close";
      default:
        return assertNever(event);
    }
  }
}

const BUTTON_INDEX: Record<WindingButtonEvent["button"], number> = {
  left: 0,
  middle: 1,
  right: 2,
  back: 3,
  forward: 4,
};

function pointerFields(
  event: WindingPointerModifiers & {
    x: number;
    y: number;
    screenX: number | null;
    screenY: number | null;
    buttons: number;
    timeStamp: number;
  },
) {
  return {
    x: event.x,
    y: event.y,
    screenX: event.screenX,
    screenY: event.screenY,
    buttons: event.buttons,
    timeStamp: event.timeStamp,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    capsLock: event.capsLock,
    altGraphKey: event.altGraphKey,
    fnKey: event.fnKey,
    numLock: event.numLock,
    scrollLock: event.scrollLock,
  };
}

export function encodePointerModifiers(event: WindingPointerModifiers): number {
  let bits = 0;
  if (event.shiftKey) bits |= PointerModifierMask.Shift;
  if (event.ctrlKey) bits |= PointerModifierMask.Control;
  if (event.altKey) bits |= PointerModifierMask.Alt;
  if (event.metaKey) bits |= PointerModifierMask.Meta;
  if (event.capsLock) bits |= PointerModifierMask.CapsLock;
  if (event.altGraphKey) bits |= PointerModifierMask.AltGraph;
  if (event.fnKey) bits |= PointerModifierMask.Fn;
  if (event.numLock) bits |= PointerModifierMask.NumLock;
  if (event.scrollLock) bits |= PointerModifierMask.ScrollLock;
  return bits;
}

function assertNever(_value: never): never {
  throw new TypeError("Unsupported Winding event");
}

/** Convert Winding's native-window-bearing event into Quox's public observer event. */
export function mapWindingEvent(event: WindingUIEvent): QuoxInputEvent {
  switch (event.type) {
    case "mousemove":
      return { type: "mousemove", ...pointerFields(event) };
    case "pointercancel":
      return {
        type: "pointercancel",
        canceledButtons: event.canceledButtons,
        ...pointerFields(event),
        buttons: 0,
      };
    case "mousedown":
      return {
        type: "mousedown",
        button: BUTTON_INDEX[event.button],
        detail: event.detail,
        ...pointerFields(event),
      };
    case "mouseup":
      return {
        type: "mouseup",
        button: BUTTON_INDEX[event.button],
        detail: event.detail,
        ...pointerFields(event),
      };
    case "wheel":
      return {
        type: "wheel",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ...pointerFields(event),
      };
    case "keydown": {
      return {
        type: "keydown",
        keycode: event.keycode,
        code: event.code,
        key: event.key,
        location: event.location,
        repeat: event.repeat,
        isComposing: event.isComposing,
        editDisposition: event.editDisposition,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        accelKey: event.accelKey,
        capsLock: event.capsLock,
        altGraphKey: event.altGraphKey,
        fnKey: event.fnKey,
        numLock: event.numLock,
        scrollLock: event.scrollLock,
      };
    }
    case "keyup":
      return {
        type: "keyup",
        keycode: event.keycode,
        code: event.code,
        key: event.key,
        location: event.location,
        repeat: false,
        isComposing: event.isComposing,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        accelKey: event.accelKey,
        capsLock: event.capsLock,
        altGraphKey: event.altGraphKey,
        fnKey: event.fnKey,
        numLock: event.numLock,
        scrollLock: event.scrollLock,
      };
    case "ime": {
      switch (event.kind) {
        case "enabled":
        case "disabled":
          return { type: "ime", kind: event.kind };
        case "preedit":
          return {
            type: "ime",
            kind: "preedit",
            text: event.text,
            cursorRange: event.cursorRange,
          };
        case "commit":
          return { type: "ime", kind: "commit", text: event.text };
        case "deleteSurrounding":
          return {
            type: "ime",
            kind: "deleteSurrounding",
            beforeBytes: event.beforeBytes,
            afterBytes: event.afterBytes,
          };
        case "replace":
          return {
            type: "ime",
            kind: "replace",
            startBytes: event.startBytes,
            endBytes: event.endBytes,
            text: event.text,
          };
      }
      return assertNever(event);
    }
    case "apple-standard-keybinding":
      return { type: "apple-standard-keybinding", command: event.command };
    case "resize":
      return {
        type: "resize",
        width: event.width,
        height: event.height,
        framebufferWidth: event.framebufferWidth,
        framebufferHeight: event.framebufferHeight,
        devicePixelRatio: event.devicePixelRatio,
        frameToken: event.frameToken,
      };
    case "close":
      return { type: "close" };
    case "mouseenter":
      return { type: "mouseenter", ...pointerFields(event) };
    case "mouseleave":
      return { type: "mouseleave", ...pointerFields(event) };
    case "focus":
      return { type: "focus" };
    case "blur":
      return { type: "blur" };
    case "visibilitychange":
      return { type: "visibilitychange", visible: event.visible };
    default:
      return assertNever(event);
  }
}

export interface EncodedKeyEvent {
  code: string;
  key: string;
  keycode: number;
  modifierBits: number;
  location: number;
  eventFlags: number;
}

/** Encode exact host flags into the compact Quox→WASM key ABI. */
export function encodeKeyEvent(event: QuoxKeyboardEvent): EncodedKeyEvent {
  let modifierBits = 0;
  if (event.shiftKey) modifierBits |= KeyModifierMask.Shift;
  if (event.altKey) modifierBits |= KeyModifierMask.Alt;
  if (event.metaKey) modifierBits |= KeyModifierMask.Meta;
  if (event.capsLock) modifierBits |= KeyModifierMask.CapsLock;
  if (event.altGraphKey) modifierBits |= KeyModifierMask.AltGraph;
  if (event.accelKey) modifierBits |= KeyModifierMask.Accelerator;
  // Kept separate from Accelerator so Rust can preserve the physical DOM modifier without
  // changing Blitz's runtime-platform editor-command projection.
  if (event.ctrlKey) modifierBits |= KeyModifierMask.Control;
  if (event.fnKey) modifierBits |= KeyModifierMask.Fn;
  if (event.numLock) modifierBits |= KeyModifierMask.NumLock;
  if (event.scrollLock) modifierBits |= KeyModifierMask.ScrollLock;

  let eventFlags = event.isComposing ? KeyEventFlag.Composing : 0;
  if (event.type === "keydown") {
    eventFlags |= KeyEventFlag.Pressed;
    if (event.repeat) eventFlags |= KeyEventFlag.Repeat;
    if (event.editDisposition !== "key-default") eventFlags |= KeyEventFlag.PreventDefault;
  }

  return {
    code: event.code,
    key: event.key,
    keycode: event.keycode,
    modifierBits,
    location: event.location,
    eventFlags,
  };
}

export type InputListener = (event: QuoxInputEvent) => void;

/** Isolate observer failures so a key listener cannot strand its queued text-input commit. */
export function notifyInputListeners(
  listeners: readonly InputListener[],
  event: QuoxInputEvent,
  reportError: (error: unknown) => void,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      reportError(error);
    }
  }
}
