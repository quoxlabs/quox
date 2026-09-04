import type {
  AppleStandardKeybindingEvent as WindingAppleStandardKeybindingEvent,
  KeyEvent as WindingKeyEvent,
  TextInputEvent as WindingTextInputEvent,
  UIEvent as WindingUIEvent,
} from "@quoxlabs/winding";
import { KeyEventFlag, KeyModifierMask } from "../lib/quox.js";

type WithoutWindow<Event> = Event extends { window: unknown } ? Omit<Event, "window"> : never;

export type QuoxKeyboardEvent = WithoutWindow<WindingKeyEvent>;
export type QuoxTextInputEvent = WithoutWindow<WindingTextInputEvent>;
export type QuoxAppleStandardKeybindingEvent = WithoutWindow<WindingAppleStandardKeybindingEvent>;

export type QuoxMouseMoveEvent = { type: "mousemove"; x: number; y: number };
export type QuoxMouseButtonEvent = { type: "mousedown" | "mouseup"; button: number };
export type QuoxMouseWheelEvent = { type: "wheel"; deltaX: number; deltaY: number };
export type QuoxResizeEvent = { type: "resize"; width: number; height: number };
export type QuoxCloseEvent = { type: "close" };
export type QuoxMouseEnterLeaveEvent = { type: "mouseenter" | "mouseleave" };
export type QuoxFocusChangeEvent = { type: "focus" | "blur" };
export type QuoxVisibilityEvent = { type: "visibilitychange"; visible: boolean };
export type QuoxFullscreenChangeEvent = { type: "fullscreenchange"; fullscreen: boolean };
export type QuoxFullscreenErrorEvent = {
  type: "fullscreenerror";
  requestedFullscreen: boolean;
  message: string;
};

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent
  | QuoxTextInputEvent
  | QuoxAppleStandardKeybindingEvent
  | QuoxResizeEvent
  | QuoxCloseEvent
  | QuoxMouseEnterLeaveEvent
  | QuoxFocusChangeEvent
  | QuoxVisibilityEvent
  | QuoxFullscreenChangeEvent
  | QuoxFullscreenErrorEvent;

export interface QuoxInputRoutePort {
  pointerMove(x: number, y: number, buttons: number): void;
  pointerDown(x: number, y: number, button: number, buttons: number): void;
  pointerUp(x: number, y: number, button: number, buttons: number): void;
  wheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): void;
  key(event: QuoxKeyboardEvent): void;
  textInput(event: QuoxTextInputEvent): void;
  appleCommand(event: QuoxAppleStandardKeybindingEvent): void;
  clearHover(): void;
  resize(event: QuoxResizeEvent): void;
  visibility(event: QuoxVisibilityEvent): void;
  fullscreenChange(event: QuoxFullscreenChangeEvent): void;
  fullscreenError(event: QuoxFullscreenErrorEvent): void;
}

const BUTTON_INDEX_TO_BIT = [1, 4, 2] as const;
const WHEEL_SCROLL_SPEED = 40;

/** Deterministic, native-independent routing from canonical Quox events to the document port. */
export class QuoxInputRouter {
  #buttons = 0;
  #pointerX = 0;
  #pointerY = 0;

  constructor(readonly port: QuoxInputRoutePort) {}

  route(event: QuoxInputEvent): "close" | undefined {
    switch (event.type) {
      case "mousemove":
        this.#pointerX = event.x;
        this.#pointerY = event.y;
        this.port.pointerMove(event.x, event.y, this.#buttons);
        return undefined;
      case "mousedown":
        this.#buttons |= BUTTON_INDEX_TO_BIT[event.button] ?? 0;
        this.port.pointerDown(this.#pointerX, this.#pointerY, event.button, this.#buttons);
        return undefined;
      case "mouseup":
        this.port.pointerUp(this.#pointerX, this.#pointerY, event.button, this.#buttons);
        this.#buttons &= ~(BUTTON_INDEX_TO_BIT[event.button] ?? 0);
        return undefined;
      case "wheel":
        this.port.wheel(
          this.#pointerX,
          this.#pointerY,
          // Winding uses browser-style positive-right/down deltas, while Blitz
          // subtracts wheel deltas from the current scroll offset.
          -event.deltaX * WHEEL_SCROLL_SPEED,
          -event.deltaY * WHEEL_SCROLL_SPEED,
          this.#buttons,
        );
        return undefined;
      case "keydown":
      case "keyup":
        this.port.key(event);
        return undefined;
      case "textinput":
        this.port.textInput(event);
        return undefined;
      case "apple-standard-keybinding":
        this.port.appleCommand(event);
        return undefined;
      case "mouseleave":
        this.port.clearHover();
        return undefined;
      case "resize":
        this.port.resize(event);
        return undefined;
      case "visibilitychange":
        this.port.visibility(event);
        return undefined;
      case "fullscreenchange":
        this.port.fullscreenChange(event);
        return undefined;
      case "fullscreenerror":
        this.port.fullscreenError(event);
        return undefined;
      case "close":
        return "close";
      case "mouseenter":
      case "focus":
      case "blur":
        return undefined;
      default:
        return assertNever(event);
    }
  }
}

const BUTTON_INDEX: Record<"left" | "middle" | "right", number> = { left: 0, middle: 1, right: 2 };

function assertNever(_value: never): never {
  throw new TypeError("Unsupported Winding event");
}

/** Convert Winding's native-window-bearing event into Quox's public observer event. */
export function mapWindingEvent(event: WindingUIEvent): QuoxInputEvent {
  switch (event.type) {
    case "mousemove":
      return { type: "mousemove", x: event.x, y: event.y };
    case "mousedown":
      return { type: "mousedown", button: BUTTON_INDEX[event.button] };
    case "mouseup":
      return { type: "mouseup", button: BUTTON_INDEX[event.button] };
    case "wheel":
      return { type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY };
    case "keydown": {
      return {
        type: "keydown",
        keycode: event.keycode,
        code: event.code,
        key: event.key,
        location: event.location,
        repeat: event.repeat,
        editDisposition: event.editDisposition,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        accelKey: event.accelKey,
        capsLock: event.capsLock,
        altGraphKey: event.altGraphKey,
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
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        accelKey: event.accelKey,
        capsLock: event.capsLock,
        altGraphKey: event.altGraphKey,
      };
    case "textinput":
      return { type: "textinput", text: event.text };
    case "apple-standard-keybinding":
      return { type: "apple-standard-keybinding", command: event.command };
    case "resize":
      return { type: "resize", width: event.width, height: event.height };
    case "close":
      return { type: "close" };
    case "mouseenter":
      return { type: "mouseenter" };
    case "mouseleave":
      return { type: "mouseleave" };
    case "focus":
      return { type: "focus" };
    case "blur":
      return { type: "blur" };
    case "visibilitychange":
      return { type: "visibilitychange", visible: event.visible };
    case "fullscreenchange":
      return { type: "fullscreenchange", fullscreen: event.fullscreen };
    case "fullscreenerror":
      return {
        type: "fullscreenerror",
        requestedFullscreen: event.requestedFullscreen,
        message: event.message,
      };
    default:
      return assertNever(event);
  }
}

export interface EncodedKeyEvent {
  code: string;
  key: string;
  modifierBits: number;
  location: number;
  eventFlags: number;
}

/** Whether a keydown is the unmodified browser-style fullscreen escape gesture. */
export function isFullscreenExitKey(event: QuoxKeyboardEvent): boolean {
  return event.type === "keydown" &&
    !event.repeat &&
    (event.key === "Escape" || event.key === "F11") &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey;
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

  let eventFlags = 0;
  if (event.type === "keydown") {
    eventFlags |= KeyEventFlag.Pressed;
    if (event.repeat) eventFlags |= KeyEventFlag.Repeat;
    if (event.editDisposition !== "key-default") eventFlags |= KeyEventFlag.PreventDefault;
  }

  return {
    code: event.code,
    key: event.key,
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
