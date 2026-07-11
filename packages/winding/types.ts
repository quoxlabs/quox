export type UIEvent =
  | KeyDownEvent
  | KeyUpEvent
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

export interface WindowEvent<Type extends string = string> {
  type: Type;
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
 * followed by IME or AppKit command events; a `platform` key is owned entirely
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
  /**
   * Whether a native composition/preedit session was active immediately before
   * this native key transition. The initiating key may therefore be false,
   * while subsequent composition and commit keys are true.
   */
  isComposing: boolean;
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

/** Inclusive/exclusive UTF-8 byte offsets into preedit text. */
export type ImeCursorRange = readonly [start: number, end: number];

/** Native text-input offsets and lengths are UTF-8 byte counts. */
export type ImeEvent =
  | (WindowEvent<"ime"> & { kind: "enabled" | "disabled" })
  | (WindowEvent<"ime"> & {
    kind: "preedit";
    text: string;
    /** `null` when the native input method hides or cannot report its cursor. */
    cursorRange: ImeCursorRange | null;
  })
  | (WindowEvent<"ime"> & {
    kind: "commit";
    /** Non-empty committed text. A commit atomically ends the current preedit. */
    text: string;
  })
  | (WindowEvent<"ime"> & {
    kind: "deleteSurrounding";
    /** Number of UTF-8 bytes to delete before the cursor. */
    beforeBytes: number;
    /** Number of UTF-8 bytes to delete after the cursor. */
    afterBytes: number;
  })
  | (WindowEvent<"ime"> & {
    kind: "replace";
    /** Absolute UTF-8 byte range in the application's last surrounding-text snapshot. */
    startBytes: number;
    endBytes: number;
    /** Replacement text; an empty string performs an atomic deletion. */
    text: string;
  });
export interface AppleStandardKeybindingEvent extends WindowEvent<"apple-standard-keybinding"> {
  /** Original AppKit action selector, for example `deleteBackward:`. */
  command: string;
}
export type MouseButton = "left" | "middle" | "right" | "back" | "forward";
export interface PointerModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}
export interface PointerEventBase<Type extends string> extends WindowEvent<Type>, PointerModifiers {
  /** DOM MouseEvent.x/clientX-compatible logical client coordinate. */
  x: number;
  /** DOM MouseEvent.y/clientY-compatible logical client coordinate. */
  y: number;
  /** DOM MouseEvent.buttons-compatible currently pressed button bitmask. */
  buttons: number;
  /** DOM Event.timeStamp-compatible milliseconds relative to the runtime time origin. */
  timeStamp: number;
}
export interface ButtonEvent extends PointerEventBase<"mousedown" | "mouseup"> {
  type: "mousedown" | "mouseup";
  button: MouseButton;
  /** DOM UIEvent.detail-compatible native click count. */
  detail: number;
}
export interface MoveEvent extends PointerEventBase<"mousemove"> {
  type: "mousemove";
}
export interface WheelEvent extends PointerEventBase<"wheel"> {
  type: "wheel";
  /** Scroll right when positive, in `deltaMode` units. */
  deltaX: number;
  /** Scroll down when positive, in `deltaMode` units. */
  deltaY: number;
  /** DOM WheelEvent compatible: 0 = logical pixels, 1 = lines, 2 = pages. */
  deltaMode: 0 | 1 | 2;
}
/**
 * Logical dimensions remain meaningful when a native surface temporarily has
 * no drawable pixels. If either framebuffer dimension is zero, retain this
 * resize but suspend rendering and blitting until a positive resize.
 */
export interface ResizeEvent extends WindowEvent<"resize"> {
  type: "resize";
  /** Logical client width; input and IME coordinates use the same units. */
  width: number;
  /** Logical client height; input and IME coordinates use the same units. */
  height: number;
  /** Exact number of horizontal pixels expected by `Window.blit()`. */
  framebufferWidth: number;
  /** Exact number of vertical pixels expected by `Window.blit()`. */
  framebufferHeight: number;
  /** Backing pixels per logical unit, analogous to the browser's `devicePixelRatio`. */
  devicePixelRatio: number;
  /**
   * Binds an asynchronous frame to the native configure generation that requested it.
   * Backends without configure generations omit this value and ignore it on blit.
   */
  frameToken?: number;
}
export interface CloseEvent extends WindowEvent<"close"> {
  type: "close";
}
/** Fired when the pointer enters/leaves the window's bounds. */
export interface EnterLeaveEvent extends PointerEventBase<"mouseenter" | "mouseleave"> {
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

export interface Window {
  [Symbol.dispose](): void;
  close(): void;
  /** Set the native window title. */
  setTitle(title: string): void;
  /**
   * Blit tightly packed, row-major sRGB RGBA8 pixels whose dimensions match a
   * resize event's framebuffer dimensions. The first pixel is the top-left
   * pixel and alpha is straight (unpremultiplied). The source space remains
   * sRGB across display-profile changes, so a profile change alone does not
   * invalidate the pixels. Pass the event's frame token when rendering
   * asynchronously so stale frames can be dropped.
   */
  blit(rgba: Uint8Array, width: number, height: number, frameToken?: number): void;
  /** Set whether native composition is desired for this window. */
  setImeEnabled(enabled: boolean): void;
  /**
   * Give the native text service the application's current editable text and
   * ordered selection. Offsets are UTF-8 byte boundaries; the application
   * remains authoritative and must refresh this state after edits.
   */
  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void;
  /**
   * Set the IME candidate-window anchor in top-left-origin logical client coordinates.
   */
  setImeCursorArea(x: number, y: number, width: number, height: number): void;
}

export interface Library {
  [Symbol.dispose](): void;
  /**
   * Open a top-level window. `x` and `y` locate its outer frame's top-left
   * relative to the primary display's top-left, and `w` and `h` are outer
   * frame dimensions. All four values use platform logical screen units;
   * displays above or left of the primary display use negative coordinates.
   * Positions must be finite and dimensions must be positive integers. Native
   * coordinate and size limits can be narrower. A window manager or compositor
   * may constrain or ignore the requested frame.
   */
  openWindow(): Window;
  openWindow(x: number, y: number): Window;
  openWindow(x: number, y: number, w: number, h: number): Window;
  event(): UIEvent | undefined;
  close(): void;
}

export type LoadLibrary = () => Library;
