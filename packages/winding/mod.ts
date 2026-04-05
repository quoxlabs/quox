export type {
  ButtonEvent,
  CloseEvent,
  KeyEvent,
  Library,
  LoadLibrary,
  MoveEvent,
  ResizeEvent,
  UIEvent,
  UIEventType,
  WheelEvent,
  Window,
  WindowEvent,
} from "./types.ts";
import type { LoadLibrary } from "./types.ts";
import { load as X11Load } from "./x11.ts";
import { load as Win32Load } from "./win32.ts";
import { load as WaylandLoad } from "./wayland.ts";

export const load: LoadLibrary = () => {
  if (Deno.permissions.requestSync({ name: "ffi" }).state !== "granted") {
    throw new Error("quox cannot run without FFI access");
  }
  if (Deno.build.os === "windows") return Win32Load();
  // Prefer Wayland when WAYLAND_DISPLAY is set; fall back to X11 otherwise.
  if (
    Deno.permissions.requestSync({ name: "env", variable: "WAYLAND_DISPLAY" }).state === "granted" &&
    Deno.env.get("WAYLAND_DISPLAY")
  ) {
    return WaylandLoad();
  }
  return X11Load();
};
