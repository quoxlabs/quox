export type UIEvent =
  | KeyDownEvent
  | KeyUpEvent
  | TextInputEvent
  | AppleStandardKeybindingEvent
  | ButtonEvent
  | MoveEvent
  | WheelEvent
  | ResizeEvent
  | CloseEvent
  | EnterLeaveEvent
  | FocusChangeEvent
  | VisibilityEvent
  | FullscreenChangeEvent
  | FullscreenErrorEvent;
export type UIEventType = UIEvent["type"];

export interface WindowEvent<T extends string = string> {
  type: T;
  /** The live Winding window that originated this event. */
  window: Window;
}
export interface KeyModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Command on Darwin; Control elsewhere, excluding synthetic AltGr Control. */
  accelKey: boolean;
  /** Active Caps Lock state. */
  capsLock: boolean;
  /** Whether the active keyboard level is AltGraph/AltGr. */
  altGraphKey: boolean;
}
/** DOM KeyboardEvent.location-compatible key location. */
export type KeyLocation = 0 | 1 | 2 | 3;

/**
 * Describes which layer owns a keydown's editing behavior.
 *
 * `text-input` and `platform` keydowns remain observable, but consumers must
 * suppress their editor's ordinary keyboard default. A `text-input` key may be
 * followed by committed text or an AppKit command; a `platform` key is owned entirely
 * by the operating system and has no semantic editing follow-up.
 */
export type KeyEditDisposition = "key-default" | "text-input" | "platform";

export interface KeyEventBase extends WindowEvent<"keydown" | "keyup">, KeyModifiers {
  /** Native, unnormalized platform key identifier. */
  keycode: number;
  /** DOM KeyboardEvent.code-style physical key identifier, or `Unidentified`. */
  code: string;
  /** Layout-aware DOM KeyboardEvent.key-style value, or `Unidentified`. */
  key: string;
  /** Standard, left, right, or numeric-keypad location. */
  location: KeyLocation;
}

export interface KeyDownEvent extends KeyEventBase {
  type: "keydown";
  /** False for the initial press and true for an operating-system repeat. */
  repeat: boolean;
  editDisposition: KeyEditDisposition;
}

export interface KeyUpEvent extends KeyEventBase {
  type: "keyup";
  /** Key releases are never repeat events. */
  repeat: false;
}

export type KeyEvent = KeyDownEvent | KeyUpEvent;

/** Non-empty text committed by the active keyboard layout. */
export interface TextInputEvent extends WindowEvent<"textinput"> {
  text: string;
}
export interface AppleStandardKeybindingEvent extends WindowEvent<"apple-standard-keybinding"> {
  /** Original AppKit action selector, for example `deleteBackward:`. */
  command: string;
}
export interface ButtonEvent extends WindowEvent<"mousedown" | "mouseup"> {
  type: "mousedown" | "mouseup";
  button: "left" | "middle" | "right";
}
export interface MoveEvent extends WindowEvent<"mousemove"> {
  type: "mousemove";
  x: number;
  y: number;
}
export interface WheelEvent extends WindowEvent<"wheel"> {
  type: "wheel";
  deltaX: number;
  deltaY: number;
}
export interface ResizeEvent extends WindowEvent<"resize"> {
  type: "resize";
  width: number;
  height: number;
}
export interface CloseEvent extends WindowEvent<"close"> {
  type: "close";
}
/** Fired when the pointer enters/leaves the window's bounds. */
export interface EnterLeaveEvent extends WindowEvent<"mouseenter" | "mouseleave"> {
  type: "mouseenter" | "mouseleave";
}
/** Fired when the window (not a DOM element) gains/loses OS-level input focus. */
export interface FocusChangeEvent extends WindowEvent<"focus" | "blur"> {
  type: "focus" | "blur";
}
/** Fired when the window is minimized/restored. */
export interface VisibilityEvent extends WindowEvent<"visibilitychange"> {
  type: "visibilitychange";
  visible: boolean;
}

/** Fired after the operating system confirms a fullscreen transition. */
export interface FullscreenChangeEvent extends WindowEvent<"fullscreenchange"> {
  fullscreen: boolean;
}

/** Fired when the operating system rejects a fullscreen transition. */
export interface FullscreenErrorEvent extends WindowEvent<"fullscreenerror"> {
  requestedFullscreen: boolean;
  message: string;
}

export interface Window {
  [Symbol.dispose](): void;
  close(): void;
  /** Set the native window title. */
  setTitle(title: string): void;
  /** Whether this backend can request native fullscreen presentation. */
  readonly fullscreenEnabled: boolean;
  /** Request entry to or exit from native fullscreen presentation. */
  setFullscreen(fullscreen: boolean): void;
  /** Blit (bit-block transfer) an RGBA pixel buffer to the window. Width and height must match the window dimensions. */
  blit(rgba: Uint8Array, width: number, height: number): void;
}

export interface Library {
  [Symbol.dispose](): void;
  openWindow(): Window;
  openWindow(x: number, y: number): Window;
  openWindow(x: number, y: number, w: number, h: number): Window;
  event(): UIEvent | undefined;
  close(): void;
}

export type LoadLibrary = () => Library;
