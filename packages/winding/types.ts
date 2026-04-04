export type UIEvent = KeyEvent | ButtonEvent | MoveEvent | WheelEvent | ResizeEvent | CloseEvent;
export type UIEventType = UIEvent["type"];

export interface WindowEvent {
  type: string;
  window?: Window;
}
export interface KeyEvent extends WindowEvent {
  type: "keydown" | "keyup";
  keycode: number;
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
  /** Blit an RGBA pixel buffer to the window. Width and height must match the window dimensions. */
  blit(rgba: Uint8Array, width: number, height: number): void;
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
