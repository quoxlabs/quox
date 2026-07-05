export type UIEvent = KeyEvent | ButtonEvent | MoveEvent | WheelEvent | ResizeEvent | CloseEvent;
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
}
export interface KeyEvent extends WindowEvent, KeyModifiers {
  type: "keydown" | "keyup";
  /** Native, unnormalized platform key identifier. */
  keycode: number;
  /** DOM KeyboardEvent.code-style physical key identifier. */
  code: string;
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

export interface Window {
  [Symbol.dispose]: () => void;
  close(): void;
  /** Set the native window title. */
  setTitle(title: string): void;
  /** Create a presentable WebGPU surface for this native window. Requires `--unstable-webgpu`. */
  windowSurface(): Deno.UnsafeWindowSurface;
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
