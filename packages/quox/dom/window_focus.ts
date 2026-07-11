import { eventDispatchInternals, QuoxEvent } from "./event.ts";
import {
  invokeEventListeners,
  type QuoxEventTarget,
  type ReportEventListenerException,
  reportEventListenerException,
} from "./event_target.ts";
import { QuoxFocusEvent } from "./ui_event.ts";

export type NativeWindowFocusEventType = "focus" | "blur";

/** Dispatch one operating-system focus transition at the browser-style Window target. */
export function dispatchNativeWindowFocusEvent(
  target: QuoxEventTarget,
  type: NativeWindowFocusEventType,
  reportException: ReportEventListenerException = reportEventListenerException,
): void {
  const event = new QuoxFocusEvent(type, {
    bubbles: false,
    cancelable: false,
    composed: true,
    view: target,
    detail: 0,
    relatedTarget: null,
  });
  const dispatch = event[eventDispatchInternals];
  dispatch.begin(target, [target], true);
  try {
    target[invokeEventListeners](event, "at-target", QuoxEvent.AT_TARGET, reportException);
  } finally {
    dispatch.end();
  }
}
