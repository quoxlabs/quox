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
} from "./src/types.ts";
import type { LoadLibrary } from "./src/types.ts";
import { load as X11Load } from "./src/x11/mod.ts";
import { load as Win32Load } from "./src/win32/mod.ts";

export const load: LoadLibrary = () => {
  if (Deno.build.os === "windows") return Win32Load();
  return X11Load();
};
