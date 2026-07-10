import type {
  AppleStandardKeybindingEvent as WindingAppleStandardKeybindingEvent,
  ImeEvent as WindingImeEvent,
  KeyEvent as WindingKeyEvent,
  UIEvent as WindingUIEvent,
  Window as WindingWindow,
} from "@quoxlabs/winding";

type WithoutWindow<Event> = Event extends { window: unknown } ? Omit<Event, "window"> : never;

export type QuoxKeyboardEvent = WithoutWindow<WindingKeyEvent>;
export type QuoxImeEvent = WithoutWindow<WindingImeEvent>;
export type QuoxAppleStandardKeybindingEvent = WithoutWindow<WindingAppleStandardKeybindingEvent>;

export type QuoxMouseMoveEvent = { type: "mousemove"; x: number; y: number };
export type QuoxMouseButtonEvent = { type: "mousedown" | "mouseup"; button: number };
export type QuoxMouseWheelEvent = { type: "wheel"; deltaX: number; deltaY: number };
export type QuoxResizeEvent = { type: "resize"; width: number; height: number };
export type QuoxCloseEvent = { type: "close" };
export type QuoxMouseEnterLeaveEvent = { type: "mouseenter" | "mouseleave" };
export type QuoxFocusChangeEvent = { type: "focus" | "blur" };
export type QuoxVisibilityEvent = { type: "visibilitychange"; visible: boolean };

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
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
  pointerMove(x: number, y: number, buttons: number): void;
  pointerDown(x: number, y: number, button: number, buttons: number): void;
  pointerUp(x: number, y: number, button: number, buttons: number): void;
  wheel(x: number, y: number, deltaX: number, deltaY: number, buttons: number): void;
  key(event: QuoxKeyboardEvent): void;
  ime(event: QuoxImeEvent): void;
  appleCommand(event: QuoxAppleStandardKeybindingEvent): void;
  clearHover(): void;
  resize(event: QuoxResizeEvent): void;
  visibility(event: QuoxVisibilityEvent): void;
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
          event.deltaX * WHEEL_SCROLL_SPEED,
          event.deltaY * WHEEL_SCROLL_SPEED,
          this.#buttons,
        );
        return undefined;
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
      case "mouseleave":
        this.port.clearHover();
        return undefined;
      case "resize":
        this.port.resize(event);
        return undefined;
      case "visibilitychange":
        this.port.visibility(event);
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
        isComposing: event.isComposing,
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
        isComposing: event.isComposing,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        accelKey: event.accelKey,
        capsLock: event.capsLock,
        altGraphKey: event.altGraphKey,
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
      }
      return assertNever(event);
    }
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
    default:
      return assertNever(event);
  }
}

// These values are also exported by Rust's KeyModifierMask/KeyEventFlag enums.
// Import the generated enums directly after WASM artifacts can be regenerated.
export const KEY_MODIFIER = {
  shift: 1 << 0,
  alt: 1 << 1,
  meta: 1 << 2,
  capsLock: 1 << 3,
  altGraph: 1 << 4,
  accelerator: 1 << 5,
} as const;

export const KEY_EVENT_FLAG = {
  pressed: 1 << 0,
  repeat: 1 << 1,
  composing: 1 << 2,
  preventDefault: 1 << 3,
} as const;

export interface EncodedKeyEvent {
  code: string;
  key: string;
  modifierBits: number;
  location: number;
  eventFlags: number;
}

/** Encode exact host flags into the compact Quox→WASM key ABI. */
export function encodeKeyEvent(event: QuoxKeyboardEvent): EncodedKeyEvent {
  let modifierBits = 0;
  if (event.shiftKey) modifierBits |= KEY_MODIFIER.shift;
  if (event.altKey) modifierBits |= KEY_MODIFIER.alt;
  if (event.metaKey) modifierBits |= KEY_MODIFIER.meta;
  if (event.capsLock) modifierBits |= KEY_MODIFIER.capsLock;
  if (event.altGraphKey) modifierBits |= KEY_MODIFIER.altGraph;
  if (event.accelKey) modifierBits |= KEY_MODIFIER.accelerator;

  let eventFlags = event.isComposing ? KEY_EVENT_FLAG.composing : 0;
  if (event.type === "keydown") {
    eventFlags |= KEY_EVENT_FLAG.pressed;
    if (event.repeat) eventFlags |= KEY_EVENT_FLAG.repeat;
    if (event.editDisposition !== "key-default") eventFlags |= KEY_EVENT_FLAG.preventDefault;
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

export const IME_REQUEST_FLAG = {
  cursorArea: 1 << 0,
  enabled: 1 << 1,
} as const;

/** Apply one atomic Rust IME-request snapshot, always placing geometry before enabling. */
export function applyImeRequestSnapshot(window: WindingWindow, snapshot: Float32Array): void {
  if (snapshot.length !== 6) {
    throw new RangeError(`invalid IME request snapshot length: ${snapshot.length}`);
  }
  const flags = Math.trunc(snapshot[0]);
  if (!Number.isFinite(snapshot[0]) || flags !== snapshot[0] || (flags & ~3) !== 0) {
    throw new RangeError(`invalid IME request flags: ${snapshot[0]}`);
  }
  if (flags & IME_REQUEST_FLAG.cursorArea) {
    window.setImeCursorArea(snapshot[1], snapshot[2], snapshot[3], snapshot[4]);
  }
  if (flags & IME_REQUEST_FLAG.enabled) {
    window.setImeEnabled(snapshot[5] !== 0);
  }
}
