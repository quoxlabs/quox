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
  PointerCancelEvent,
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

type Backend = "win32" | "darwin" | "wayland" | "x11";
type WaylandEnvironmentVariable = "WAYLAND_DISPLAY" | "WAYLAND_SOCKET";

export function selectBackend(
  os: string,
  waylandDisplay: string | undefined,
  waylandSocket: string | undefined,
): Backend {
  if (os === "windows") return "win32";
  if (os === "darwin") return "darwin";
  if (os === "linux" && (Boolean(waylandDisplay) || Boolean(waylandSocket))) return "wayland";
  return "x11";
}

function readableEnvironmentVariable(variable: WaylandEnvironmentVariable): string | undefined {
  if (Deno.permissions.querySync({ name: "env", variable }).state !== "granted") return undefined;
  return Deno.env.get(variable);
}

export const load: LoadLibrary = () => {
  if (Deno.permissions.requestSync({ name: "ffi" }).state !== "granted") {
    throw new Error("winding cannot run without FFI access");
  }

  const os = Deno.build.os;
  const waylandDisplay = os === "linux" ? readableEnvironmentVariable("WAYLAND_DISPLAY") : undefined;
  const waylandSocket = os === "linux" ? readableEnvironmentVariable("WAYLAND_SOCKET") : undefined;
  switch (selectBackend(os, waylandDisplay, waylandSocket)) {
    case "win32":
      return Win32Load();
    case "darwin":
      return DarwinLoad();
    case "wayland":
      return WaylandLoad();
    case "x11":
      return X11Load();
  }
};
