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
  GetFocus: { parameters: [], result: "pointer" },
  GetKeyState: { parameters: ["i32"], result: "i16" },
  GetKeyboardState: { parameters: ["buffer"], result: "i32" },
  GetKeyboardLayout: { parameters: ["u32"], result: "pointer" },
  ToUnicodeEx: {
    parameters: ["u32", "u32", "buffer", "buffer", "i32", "u32", "pointer"],
    result: "i32",
  },
  ClientToScreen: { parameters: ["pointer", "buffer"], result: "i32" },
  GetClientRect: { parameters: ["pointer", "buffer"], result: "i32" },
  ReleaseDC: { parameters: ["pointer", "pointer"], result: "i32" },
  SetCapture: { parameters: ["pointer"], result: "pointer" },
  ReleaseCapture: { parameters: [], result: "i32" },
  SetWindowTextW: { parameters: ["pointer", "buffer"], result: "i32" },
  DestroyWindow: { parameters: ["pointer"], result: "i32" },
  ShowWindow: { parameters: ["pointer", "i32"], result: "i32" },
  LoadCursorW: { parameters: ["pointer", "usize"], result: "usize" },
  TrackMouseEvent: { parameters: ["buffer"], result: "i32" },
  RegisterClassExW: {
    parameters: ["buffer"],
    result: "u16",
  },
  UnregisterClassW: {
    parameters: ["buffer", "usize"],
    result: "i32",
  },
  CreateWindowExW: {
    parameters: [
      "u32",
      "buffer",
      "buffer",
      "u32",
      "i32",
      "i32",
      "i32",
      "i32",
      "pointer",
      "pointer",
      "pointer",
      "usize",
    ],
    result: "pointer",
  },
  PeekMessageW: {
    parameters: ["pointer", "pointer", "u32", "u32", "u32"],
    result: "i32",
  },
  TranslateMessage: { parameters: ["pointer"], result: "i32" },
  DispatchMessageW: {
    parameters: ["pointer"],
    result: "usize",
  },
  DefWindowProcW: {
    parameters: ["pointer", "u32", "usize", "usize"],
    result: "usize",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export const imm32functions = {
  ImmGetContext: { parameters: ["pointer"], result: "pointer" },
  ImmReleaseContext: { parameters: ["pointer", "pointer"], result: "i32" },
  ImmAssociateContextEx: {
    parameters: ["pointer", "pointer", "u32"],
    result: "i32",
  },
  ImmGetCompositionStringW: {
    // `lpBuf` is nullable for the initial size query, so model it as a pointer
    // rather than a Deno `buffer` parameter.
    parameters: ["pointer", "u32", "pointer", "u32"],
    result: "i32",
  },
  ImmSetCandidateWindow: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  ImmSetCompositionWindow: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  ImmNotifyIME: {
    parameters: ["pointer", "u32", "u32", "u32"],
    result: "i32",
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
  IME_STARTCOMPOSITION = 0x010D,
  IME_ENDCOMPOSITION = 0x010E,
  IME_COMPOSITION = 0x010F,
  SIZE = 0x0005,
  CLOSE = 0x0010,
  SETFOCUS = 0x0007,
  KILLFOCUS = 0x0008,
  NCDESTROY = 0x0082,
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
  IME_SETCONTEXT = 0x0281,
  IME_NOTIFY = 0x0282,
  IME_CONTROL = 0x0283,
  IME_COMPOSITIONFULL = 0x0284,
  IME_SELECT = 0x0285,
  IME_CHAR = 0x0286,
  IME_REQUEST = 0x0288,
  IME_KEYDOWN = 0x0290,
  IME_KEYUP = 0x0291,
}

/** `ToUnicodeEx` flag that prevents mutation of the kernel keyboard buffer. */
export const TU_NO_STATE_CHANGE = 0x0004;

/** `WM_UNICHAR` capability probe value. */
export const UNICODE_NOCHAR = 0xFFFF;

/** `WM_IME_COMPOSITION`/`ImmGetCompositionStringW` composition data flags. */
export const GCS_COMPREADSTR = 0x0001;
export const GCS_COMPREADATTR = 0x0002;
export const GCS_COMPREADCLAUSE = 0x0004;
export const GCS_COMPSTR = 0x0008;
export const GCS_COMPATTR = 0x0010;
export const GCS_COMPCLAUSE = 0x0020;
export const GCS_CURSORPOS = 0x0080;
export const GCS_DELTASTART = 0x0100;
export const GCS_RESULTREADSTR = 0x0200;
export const GCS_RESULTREADCLAUSE = 0x0400;
export const GCS_RESULTSTR = 0x0800;
export const GCS_RESULTCLAUSE = 0x1000;
/** `WM_IME_COMPOSITION` flags carrying a transient composition character. */
export const CS_INSERTCHAR = 0x2000;
export const CS_NOMOVECARET = 0x4000;

/** `ImmAssociateContextEx` flags. */
export const IACE_DEFAULT = 0x0010;
export const IACE_IGNORENOCONTEXT = 0x0020;

/** `ImmNotifyIME` composition actions and indexes. */
export const NI_COMPOSITIONSTR = 0x0015;
export const CPS_COMPLETE = 0x0001;
export const CPS_CONVERT = 0x0002;
export const CPS_REVERT = 0x0003;
export const CPS_CANCEL = 0x0004;

/** Candidate/composition window placement styles. */
export const CFS_DEFAULT = 0x0000;
export const CFS_RECT = 0x0001;
export const CFS_POINT = 0x0002;
export const CFS_FORCE_POSITION = 0x0020;
export const CFS_CANDIDATEPOS = 0x0040;
export const CFS_EXCLUDE = 0x0080;

/** `WM_IME_SETCONTEXT` flag for the native composition window. */
export const ISC_SHOWUICOMPOSITIONWINDOW = 0x80000000;

/** `WM_IME_REQUEST` request asking for the current character position. */
export const IMR_QUERYCHARPOSITION = 0x0006;

/** Sizes of the 64-bit Win32 structures encoded by the TypeScript backend. */
export const POINT_SIZE = 8;
export const RECT_SIZE = 16;
export const CANDIDATEFORM_SIZE = 32;
export const COMPOSITIONFORM_SIZE = 28;
export const IMECHARPOSITION_SIZE = 36;

/** `PeekMessageW` removal flags. */
export const PM_NOREMOVE = 0x0000;
export const PM_REMOVE = 0x0001;
export const PM_NOYIELD = 0x0002;

/** Wheel delta per notch, see WHEEL_DELTA in WinUser.h. */
export const WHEEL_DELTA = 120;

/** `wParam` value for `WM_SIZE` meaning the window was just minimized. See WinUser.h. */
export const SIZE_MINIMIZED = 1;
