export const kernel32functions = {
  GetModuleHandleW: { parameters: ["pointer"], result: "usize" },
  GetLastError: { parameters: [], result: "u32" },
  FormatMessageW: {
    parameters: ["u32", "pointer", "u32", "u32", "pointer", "u32", "pointer"],
    result: "u32",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export const gdi32functions = {
  SetDIBitsToDevice: {
    parameters: [
      "pointer",
      "i32",
      "i32",
      "u32",
      "u32",
      "i32",
      "i32",
      "u32",
      "u32",
      "buffer",
      "buffer",
      "u32",
    ],
    result: "i32",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export const user32functions = {
  GetDC: { parameters: ["pointer"], result: "pointer" },
  ReleaseDC: { parameters: ["pointer", "pointer"], result: "i32" },
  SetCapture: { parameters: ["pointer"], result: "pointer" },
  ReleaseCapture: { parameters: [], result: "bool" },
  SetWindowTextW: { parameters: ["pointer", "buffer"], result: "bool" },
  LoadCursorW: { parameters: ["pointer", "usize"], result: "usize" },
  RegisterClassExW: {
    parameters: ["buffer"],
    result: "u16",
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
  KEYDOWN = 0x0100,
  KEYUP = 0x0101,
  SYSKEYDOWN = 0x0104,
  SYSKEYUP = 0x0105,
  SIZE = 0x0005,
  CLOSE = 0x0010,
  MOUSEMOVE = 0x0200,
  LBUTTONDOWN = 0x0201,
  LBUTTONUP = 0x0202,
  RBUTTONDOWN = 0x0204,
  RBUTTONUP = 0x0205,
  MBUTTONDOWN = 0x0207,
  MBUTTONUP = 0x0208,
  MOUSEWHEEL = 0x020A,
  MOUSEHWHEEL = 0x020E,
}

/** Wheel delta per notch, see WHEEL_DELTA in WinUser.h. */
export const WHEEL_DELTA = 120;
