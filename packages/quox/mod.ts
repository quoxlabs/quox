import { openWindow } from "./dom/window.ts";

export * from "./dom/document.ts";
export { QuoxEvent, type QuoxEventInit, type QuoxEventPhase } from "./dom/event.ts";
export {
  QuoxClipboardEvent,
  type QuoxClipboardEventInit,
  QuoxCompositionEvent,
  type QuoxCompositionEventInit,
  QuoxDataTransfer,
  QuoxDOMInputEvent,
  QuoxDOMKeyboardEvent,
  type QuoxEventModifierInit,
  QuoxFocusEvent,
  type QuoxFocusEventInit,
  type QuoxInputEventInit,
  type QuoxKeyboardEventInit,
  QuoxMouseEvent,
  type QuoxMouseEventInit,
  QuoxPointerEvent,
  type QuoxPointerEventInit,
  QuoxSubmitEvent,
  type QuoxSubmitEventInit,
  QuoxUIEvent,
  type QuoxUIEventInit,
  QuoxWheelEvent,
  type QuoxWheelEventInit,
} from "./dom/ui_event.ts";
export {
  type QuoxAddEventListenerOptions,
  type QuoxEventHandler,
  type QuoxEventListener,
  type QuoxEventListenerObject,
  type QuoxEventListenerOptions,
  type QuoxEventListenerOrEventListenerObject,
  QuoxEventTarget,
} from "./dom/event_target.ts";
export * from "./dom/handlers.ts";
export * from "./dom/mount.ts";
export * from "./dom/node.ts";
export * from "./dom/window.ts";

if (import.meta.main) {
  const win = await openWindow("<h1>Hello from Blitz WASM</h1>");
  console.log("Window open:", win);
}
