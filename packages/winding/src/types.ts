export type UIEvent = KeyEvent | ButtonEvent | MoveEvent;
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

export interface Window {
  [Symbol.dispose]: () => void;
  close(): void;
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
