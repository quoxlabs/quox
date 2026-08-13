export const kernel32functions = {
  GetModuleHandleW: { parameters: ["pointer"], result: "usize" },
  GetLastError: { parameters: [], result: "u32" },
  FormatMessageW: {
    parameters: ["u32", "pointer", "u32", "u32", "pointer", "u32", "pointer"],
    result: "u32",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export const user32functions = {
  GetDC: { parameters: ["pointer"], result: "pointer" },
  GetKeyState: { parameters: ["i32"], result: "i16" },
  GetKeyboardState: { parameters: ["buffer"], result: "bool" },
  GetKeyboardLayout: { parameters: ["u32"], result: "pointer" },
  ToUnicodeEx: {
    parameters: ["u32", "u32", "buffer", "buffer", "i32", "u32", "pointer"],
    result: "i32",
  },
  ReleaseDC: { parameters: ["pointer", "pointer"], result: "i32" },
  SetCapture: { parameters: ["pointer"], result: "pointer" },
  ReleaseCapture: { parameters: [], result: "bool" },
  SetWindowTextW: { parameters: ["pointer", "buffer"], result: "bool" },
  DestroyWindow: { parameters: ["pointer"], result: "bool" },
  LoadCursorW: { parameters: ["pointer", "usize"], result: "usize" },
  TrackMouseEvent: { parameters: ["buffer"], result: "bool" },
  RegisterClassExW: {
    parameters: ["buffer"],
    result: "u16",
  },
  UnregisterClassW: {
    parameters: ["buffer", "usize"],
    result: "bool",
  },
  CreateWindowExW: {
    parameters: [
      "u32",
      "buffer",
      "buffer",
      "u32",
      "u32",
      "u32",
      "u32",
      "u32",
      "pointer",
      "pointer",
      "pointer",
      "usize",
    ],
    result: "pointer",
  },
  PeekMessageW: {
    parameters: ["pointer", "pointer", "u32", "u32", "u32"],
    result: "bool",
  },
  TranslateMessage: { parameters: ["pointer"], result: "bool" },
  DispatchMessageW: {
    parameters: ["pointer"],
    result: "usize",
  },
  DefWindowProcW: {
    parameters: ["pointer", "u32", "usize", "usize"],
    result: "usize",
  },
} as const satisfies Deno.ForeignLibraryInterface;

/** Window message identifiers handled by wndProc. See WinUser.h. */
export enum WM {
  INPUTLANGCHANGEREQUEST = 0x0050,
  INPUTLANGCHANGE = 0x0051,
  KEYDOWN = 0x0100,
  KEYUP = 0x0101,
  CHAR = 0x0102,
  DEADCHAR = 0x0103,
  SYSKEYDOWN = 0x0104,
  SYSKEYUP = 0x0105,
  SYSCHAR = 0x0106,
  SYSDEADCHAR = 0x0107,
  UNICHAR = 0x0109,
  SIZE = 0x0005,
  CLOSE = 0x0010,
  SETFOCUS = 0x0007,
  KILLFOCUS = 0x0008,
  MOUSEMOVE = 0x0200,
  MOUSELEAVE = 0x02A3,
  LBUTTONDOWN = 0x0201,
  LBUTTONUP = 0x0202,
  RBUTTONDOWN = 0x0204,
  RBUTTONUP = 0x0205,
  MBUTTONDOWN = 0x0207,
  MBUTTONUP = 0x0208,
  MOUSEWHEEL = 0x020A,
  MOUSEHWHEEL = 0x020E,
}

/** `ToUnicodeEx` flag that prevents mutation of the kernel keyboard buffer. */
export const TU_NO_STATE_CHANGE = 0x0004;

/** `WM_UNICHAR` capability probe value. */
export const UNICODE_NOCHAR = 0xFFFF;

/** `PeekMessageW` removal flags. */
export const PM_NOREMOVE = 0x0000;
export const PM_REMOVE = 0x0001;
export const PM_NOYIELD = 0x0002;

/** Wheel delta per notch, see WHEEL_DELTA in WinUser.h. */
export const WHEEL_DELTA = 120;

/** `wParam` value for `WM_SIZE` meaning the window was just minimized. See WinUser.h. */
export const SIZE_MINIMIZED = 1;
