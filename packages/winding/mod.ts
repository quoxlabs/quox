export type {
  AppleStandardKeybindingEvent,
  ButtonEvent,
  CloseEvent,
  EnterLeaveEvent,
  FocusChangeEvent,
  ImeCursorRange,
  ImeEvent,
  KeyDownEvent,
  KeyEditDisposition,
  KeyEvent,
  KeyEventBase,
  KeyLocation,
  KeyModifiers,
  KeyUpEvent,
  Library,
  LoadLibrary,
  MouseButton,
  MoveEvent,
  PointerEventBase,
  PointerModifiers,
  ResizeEvent,
  UIEvent,
  UIEventType,
  VisibilityEvent,
  WheelEvent,
  Window,
  WindowEvent,
} from "./types.ts";
import type { LoadLibrary } from "./types.ts";
import { load as X11Load } from "./x11/mod.ts";
import { load as Win32Load } from "./win32/mod.ts";
import { load as WaylandLoad } from "./wayland/mod.ts";
import { load as DarwinLoad } from "./darwin/mod.ts";

export const load: LoadLibrary = () => {
  if (Deno.permissions.requestSync({ name: "ffi" }).state !== "granted") {
    throw new Error("winding cannot run without FFI access");
  }
  if (Deno.build.os === "windows") return Win32Load();
  if (Deno.build.os === "darwin") return DarwinLoad();
  // Prefer Wayland when WAYLAND_DISPLAY is set; fall back to X11 otherwise.
  if (
    Deno.permissions.querySync({ name: "env", variable: "WAYLAND_DISPLAY" }).state === "granted" &&
    Deno.env.get("WAYLAND_DISPLAY")
  ) {
    return WaylandLoad();
  }
  return X11Load();
};
