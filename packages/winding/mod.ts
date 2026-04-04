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

export const load: LoadLibrary = () => {
  if (Deno.build.os === "windows") return Win32Load();
  return X11Load();
};
