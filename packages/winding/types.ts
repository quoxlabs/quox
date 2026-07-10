export type UIEvent =
  | KeyEvent
  | ImeEvent
  | AppleStandardKeybindingEvent
  | ButtonEvent
  | MoveEvent
  | WheelEvent
  | ResizeEvent
  | CloseEvent
  | EnterLeaveEvent
  | FocusChangeEvent
  | VisibilityEvent;
export type UIEventType = UIEvent["type"];

export interface WindowEvent {
  type: string;
  window?: Window;
}
export interface KeyModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Command on Darwin, otherwise Control. */
  accelKey: boolean;
  /** Backends that cannot report Caps Lock state omit it. */
  capsLock?: boolean;
}
/** DOM KeyboardEvent.location-compatible key location. */
export type KeyLocation = 0 | 1 | 2 | 3;
export interface KeyEvent extends WindowEvent, KeyModifiers {
  type: "keydown" | "keyup";
  /** Native, unnormalized platform key identifier. */
  keycode: number;
  /** DOM KeyboardEvent.code-style physical key identifier. */
  code: string;
  /** Layout-aware logical key value, when the backend can resolve it. */
  key?: string;
  /** Standard, left, right, or numeric-keypad location. */
  location?: KeyLocation;
  /** Whether this event is an operating-system key repeat. */
  repeat?: boolean;
  /** Whether the key was delivered while an IME composition is active. */
  isComposing?: boolean;
  /** Text produced by this key, when it can be represented independently of IME events. */
  text?: string;
  /**
   * A following IME or native-command event owns this key's editing action.
   * Consumers must not also apply the key's default text-editing behavior.
   */
  textInputHandled?: boolean;
}
export interface ImeSelection {
  /** Inclusive UTF-8 byte offset into the preedit text. */
  start: number;
  /** Exclusive UTF-8 byte offset into the preedit text. */
  end: number;
}
/** Native text-input offsets and lengths are UTF-8 byte counts. */
export type ImeEvent =
  | (WindowEvent & { type: "ime"; kind: "enabled" | "disabled" })
  | (WindowEvent & {
    type: "ime";
    kind: "preedit";
    text: string;
    /** Omitted when the IME asks the application to hide the preedit cursor. */
    cursorRange?: readonly [number, number];
    /** Darwin-compatible named form; `null` also requests a hidden preedit cursor. */
    selection?: ImeSelection | null;
  })
  | (WindowEvent & { type: "ime"; kind: "commit"; text: string })
  | (WindowEvent & {
    type: "ime";
    kind: "delete-surrounding";
    /** Number of UTF-8 bytes to delete before the cursor. */
    beforeBytes: number;
    /** Number of UTF-8 bytes to delete after the cursor. */
    afterBytes: number;
  })
  | (WindowEvent & {
    type: "ime";
    kind: "deleteSurrounding";
    /** Number of UTF-8 bytes to delete before the cursor. */
    beforeLength: number;
    /** Number of UTF-8 bytes to delete after the cursor. */
    afterLength: number;
  });
export interface AppleStandardKeybindingEvent extends WindowEvent {
  type: "apple-standard-keybinding";
  /** Original AppKit action selector, for example `deleteBackward:`. */
  command: string;
}
export interface ButtonEvent extends WindowEvent {
  type: "mousedown" | "mouseup";
  button: "left" | "middle" | "right";
}
export interface MoveEvent extends WindowEvent {
  type: "mousemove";
  x: number;
  y: number;
}
export interface WheelEvent extends WindowEvent {
  type: "wheel";
  deltaX: number;
  deltaY: number;
}
export interface ResizeEvent extends WindowEvent {
  type: "resize";
  width: number;
  height: number;
}
export interface CloseEvent extends WindowEvent {
  type: "close";
}
/** Fired when the pointer enters/leaves the window's bounds. */
export interface EnterLeaveEvent extends WindowEvent {
  type: "mouseenter" | "mouseleave";
}
/** Fired when the window (not a DOM element) gains/loses OS-level input focus. */
export interface FocusChangeEvent extends WindowEvent {
  type: "focus" | "blur";
}
/** Fired when the window is minimized/restored. */
export interface VisibilityEvent extends WindowEvent {
  type: "visibilitychange";
  visible: boolean;
}

export interface Window {
  [Symbol.dispose]: () => void;
  close(): void;
  /** Set the native window title. */
  setTitle(title: string): void;
  /** Blit (bit-block transfer) an RGBA pixel buffer to the window. Width and height must match the window dimensions. */
  blit(rgba: Uint8Array, width: number, height: number): void;
  /** Enable or disable platform text input when supported. */
  setImeEnabled?(enabled: boolean): void;
  /**
   * Set the IME candidate-window anchor in top-left-origin logical client coordinates.
   */
  setImeCursorArea?(x: number, y: number, width: number, height: number): void;
}

export interface Library {
  [Symbol.dispose]: () => void;
  openWindow(): Window;
  openWindow(x: number, y: number): Window;
  openWindow(x: number, y: number, w: number, h: number): Window;
  event(): UIEvent | undefined;
  close(): void;
}

export type LoadLibrary = () => Library;
