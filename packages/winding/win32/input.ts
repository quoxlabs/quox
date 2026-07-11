/** Pure Win32 keyboard, AltGr, and WM_CHAR helpers. This module performs no FFI. */

import type { KeyEditDisposition, KeyEvent } from "../types.ts";
import { normalizeCommittedText } from "../input/keyboard.ts";
import { WM } from "./ffi.ts";

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UTF8_ENCODER = new TextEncoder();

/** The fields Winding needs from the 64-bit Win32 MSG layout. */
export interface Win32QueuedMessage {
  /** Zero identifies a thread message rather than a window message. */
  windowId: bigint;
  message: number;
  wParam: bigint;
  lParam: bigint;
}

/** Decode the fixed leading fields of the 48-byte MSG used by 64-bit Deno. */
export function decodeWin32QueuedMessage(buffer: ArrayBuffer): Win32QueuedMessage {
  if (buffer.byteLength < 32) throw new RangeError("winding(win32): truncated MSG buffer");
  const view = new DataView(buffer);
  return {
    windowId: view.getBigUint64(0, true),
    message: view.getUint32(8, true),
    wParam: view.getBigUint64(16, true),
    lParam: view.getBigInt64(24, true),
  };
}

export type Win32QueueDisposition = "dispatch" | "yield" | "quit";

/**
 * Gives the embedding host ownership of thread and foreign-window messages.
 * Once a quit is observed, polling remains stopped so an unremoved/reposted
 * WM_QUIT cannot become a permanent busy-loop obstruction.
 */
export class Win32MessageQueueGate {
  #quitSeen = false;

  get mayPump(): boolean {
    return !this.#quitSeen;
  }

  observe(message: Win32QueuedMessage, ownsWindow: boolean): Win32QueueDisposition {
    if (message.message === WM.QUIT) {
      this.#quitSeen = true;
      return "quit";
    }
    return message.windowId !== 0n && ownsWindow ? "dispatch" : "yield";
  }
}

/** Recover PostQuitMessage's signed int exit code from MSG.wParam. */
export function win32QuitExitCode(wParam: bigint): number {
  return Number(BigInt.asIntN(32, wParam));
}

export interface Win32ClientStateChange {
  /** Present only when minimized/restored visibility changed. */
  visible?: boolean;
  /** Present only when either authoritative client dimension changed. */
  size?: {
    width: number;
    height: number;
    framebufferWidth: number;
    framebufferHeight: number;
    devicePixelRatio: number;
  };
}

/**
 * Tracks client dimensions independently from minimized visibility. Zero is a
 * valid drawable dimension and values are not limited to WM_SIZE's 16-bit words.
 */
export class Win32ClientState {
  #minimized = false;
  #width: number | undefined;
  #height: number | undefined;
  #framebufferWidth: number | undefined;
  #framebufferHeight: number | undefined;
  #devicePixelRatio: number | undefined;

  get minimized(): boolean {
    return this.#minimized;
  }

  observe(
    minimized: boolean,
    framebufferWidth: number,
    framebufferHeight: number,
    devicePixelRatio = 1,
  ): Win32ClientStateChange {
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
      throw new RangeError("winding(win32): invalid device pixel ratio");
    }
    const width = framebufferWidth / devicePixelRatio;
    const height = framebufferHeight / devicePixelRatio;
    const visibilityChanged = minimized !== this.#minimized;
    const sizeChanged = width !== this.#width || height !== this.#height ||
      framebufferWidth !== this.#framebufferWidth || framebufferHeight !== this.#framebufferHeight ||
      devicePixelRatio !== this.#devicePixelRatio;
    this.#minimized = minimized;
    this.#width = width;
    this.#height = height;
    this.#framebufferWidth = framebufferWidth;
    this.#framebufferHeight = framebufferHeight;
    this.#devicePixelRatio = devicePixelRatio;
    return {
      ...(visibilityChanged ? { visible: !minimized } : {}),
      ...(
        sizeChanged ? { size: { width, height, framebufferWidth, framebufferHeight, devicePixelRatio } } : {}
      ),
    };
  }

  contains(x: number, y: number): boolean {
    return this.#width !== undefined && this.#height !== undefined &&
      x >= 0 && y >= 0 && x < this.#width && y < this.#height;
  }
}

/** Decode GetClientRect's signed LONG coordinates into authoritative dimensions. */
export function decodeWin32ClientRect(buffer: ArrayBuffer): { width: number; height: number } {
  if (buffer.byteLength < 16) throw new RangeError("winding(win32): truncated RECT buffer");
  const view = new DataView(buffer);
  const width = view.getInt32(8, true) - view.getInt32(0, true);
  const height = view.getInt32(12, true) - view.getInt32(4, true);
  if (width < 0 || height < 0) throw new Error("winding(win32): invalid client rectangle");
  return { width, height };
}

/** Validate top-left logical outer-window geometry accepted by CreateWindowExW. */
export function validateWin32Geometry(x: number, y: number, width: number, height: number): void {
  if (
    !Number.isInteger(x) || !Number.isInteger(y) ||
    x < INT32_MIN || x > INT32_MAX || y < INT32_MIN || y > INT32_MAX
  ) {
    throw new RangeError("winding(win32): window position must fit signed 32-bit logical coordinates");
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 || width > INT32_MAX || height > INT32_MAX
  ) {
    throw new RangeError("winding(win32): outer window dimensions must be positive signed 32-bit integers");
  }
}

/** Decode signed client coordinates packed into a Win32 mouse-message LPARAM. */
export function decodeMouseLParam(lParam: number | bigint): { x: number; y: number } {
  const value = BigInt.asUintN(32, BigInt(lParam));
  return {
    x: Number(BigInt.asIntN(16, value & 0xffffn)),
    y: Number(BigInt.asIntN(16, value >> 16n)),
  };
}

/** Per-HWND boundary state for Win32's explicitly requested leave notifications. */
export class Win32MouseTrackingState {
  #inside = false;
  #trackingLeave = false;

  needsLeaveTracking(pointInsideClient: boolean): boolean {
    return pointInsideClient && !this.#trackingLeave;
  }

  markLeaveTrackingArmed(): void {
    this.#trackingLeave = true;
  }

  observeMove(pointInsideClient: boolean): boolean {
    if (!pointInsideClient || this.#inside) return false;
    this.#inside = true;
    return true;
  }

  observeLeave(): boolean {
    const emit = this.#inside;
    this.reset();
    return emit;
  }

  reset(): void {
    this.#inside = false;
    this.#trackingLeave = false;
  }
}

export type Win32MouseButton = "left" | "middle" | "right" | "back" | "forward";

/** Tracks the one thread-global Win32 capture owner and its pressed-button chord. */
export class Win32MouseCaptureState {
  #owner: bigint | undefined;
  readonly #buttons = new Set<Win32MouseButton>();

  get owner(): bigint | undefined {
    return this.#owner;
  }

  get buttonCount(): number {
    return this.#buttons.size;
  }

  owns(owner: bigint): boolean {
    return this.#owner === owner;
  }

  hasButton(button: Win32MouseButton): boolean {
    return this.#buttons.has(button);
  }

  recordDown(owner: bigint, button: Win32MouseButton): void {
    if (this.#owner !== owner) this.reset();
    this.#owner = owner;
    this.#buttons.add(button);
  }

  releaseWouldEnd(owner: bigint, button: Win32MouseButton): boolean {
    return this.#owner === owner && this.#buttons.has(button) && this.#buttons.size === 1;
  }

  recordUp(owner: bigint, button: Win32MouseButton): void {
    if (this.#owner !== owner) return;
    this.#buttons.delete(button);
    if (this.#buttons.size === 0) this.#owner = undefined;
  }

  resetOwner(owner: bigint): boolean {
    if (this.#owner !== owner) return false;
    this.reset();
    return true;
  }

  reset(): void {
    this.#owner = undefined;
    this.#buttons.clear();
  }
}

/** Defers unsafe native work until the outer TranslateMessage call has returned. */
export class TranslateMessageReentrancyGuard {
  #depth = 0;
  #deferred: Array<() => void> = [];

  get translating(): boolean {
    return this.#depth > 0;
  }

  begin(): void {
    this.#depth++;
  }

  shouldDefer(inSendMessageFlags: number): boolean {
    return this.#depth > 0 && inSendMessageFlags !== 0;
  }

  defer(operation: () => void): void {
    if (this.#depth === 0) {
      operation();
      return;
    }
    this.#deferred.push(operation);
  }

  end(): void {
    if (this.#depth === 0) throw new Error("winding(win32): unbalanced TranslateMessage guard");
    this.#depth--;
    if (this.#depth !== 0) return;

    const deferred = this.#deferred;
    this.#deferred = [];
    const errors: unknown[] = [];
    for (const operation of deferred) {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to replay deferred Win32 IME messages");
  }

  clear(): void {
    this.#depth = 0;
    this.#deferred = [];
  }
}

/** Tracks persistent HWND↔HIMC association independently from public IME activation. */
export class Win32ImeAssociationState {
  #associated: boolean;

  constructor(initiallyAssociated = true) {
    this.#associated = initiallyAssociated;
  }

  get associated(): boolean {
    return this.#associated;
  }

  reconcile(
    shouldBeAssociated: boolean,
    apply: (associated: boolean) => boolean,
  ): boolean {
    if (this.#associated === shouldBeAssociated) return true;
    if (!apply(shouldBeAssociated)) return false;
    this.#associated = shouldBeAssociated;
    return true;
  }
}

export interface Win32KeyMessageIdentity {
  windowId: bigint;
  message: number;
  virtualKey: number;
  lParam: bigint;
}

/** Require the complete WndProc-visible identity before consuming a prepared key. */
export function matchesWin32KeyMessage(
  prepared: Win32KeyMessageIdentity,
  current: Win32KeyMessageIdentity,
): boolean {
  return prepared.windowId === current.windowId && prepared.message === current.message &&
    prepared.virtualKey === current.virtualKey &&
    BigInt.asUintN(64, prepared.lParam) === BigInt.asUintN(64, current.lParam);
}

/** Virtual-key values used by the Win32 input implementation. */
export const VK = {
  BACK: 0x08,
  TAB: 0x09,
  CLEAR: 0x0c,
  RETURN: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,
  PAUSE: 0x13,
  CAPITAL: 0x14,
  KANA: 0x15,
  JUNJA: 0x17,
  FINAL: 0x18,
  HANJA: 0x19,
  ESCAPE: 0x1b,
  CONVERT: 0x1c,
  NONCONVERT: 0x1d,
  ACCEPT: 0x1e,
  MODECHANGE: 0x1f,
  SPACE: 0x20,
  PRIOR: 0x21,
  NEXT: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  SELECT: 0x29,
  PRINT: 0x2a,
  EXECUTE: 0x2b,
  SNAPSHOT: 0x2c,
  INSERT: 0x2d,
  DELETE: 0x2e,
  HELP: 0x2f,
  LWIN: 0x5b,
  RWIN: 0x5c,
  APPS: 0x5d,
  SLEEP: 0x5f,
  NUMPAD0: 0x60,
  NUMPAD9: 0x69,
  MULTIPLY: 0x6a,
  ADD: 0x6b,
  SEPARATOR: 0x6c,
  SUBTRACT: 0x6d,
  DECIMAL: 0x6e,
  DIVIDE: 0x6f,
  F1: 0x70,
  F24: 0x87,
  NUMLOCK: 0x90,
  SCROLL: 0x91,
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LMENU: 0xa4,
  RMENU: 0xa5,
  BROWSER_BACK: 0xa6,
  BROWSER_FORWARD: 0xa7,
  BROWSER_REFRESH: 0xa8,
  BROWSER_STOP: 0xa9,
  BROWSER_SEARCH: 0xaa,
  BROWSER_FAVORITES: 0xab,
  BROWSER_HOME: 0xac,
  VOLUME_MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf,
  MEDIA_NEXT_TRACK: 0xb0,
  MEDIA_PREV_TRACK: 0xb1,
  MEDIA_STOP: 0xb2,
  MEDIA_PLAY_PAUSE: 0xb3,
  LAUNCH_MAIL: 0xb4,
  LAUNCH_MEDIA_SELECT: 0xb5,
  LAUNCH_APP1: 0xb6,
  LAUNCH_APP2: 0xb7,
  PROCESSKEY: 0xe5,
  PACKET: 0xe7,
  ATTN: 0xf6,
  CRSEL: 0xf7,
  EXSEL: 0xf8,
  EREOF: 0xf9,
  PLAY: 0xfa,
  ZOOM: 0xfb,
  NONAME: 0xfc,
  PA1: 0xfd,
  OEM_CLEAR: 0xfe,
} as const;

/** Windows 10 1607+ flag that makes ToUnicodeEx leave the keyboard buffer unchanged. */
export const TO_UNICODE_NO_STATE_CHANGE = 0x04;

export interface DecodedKeyLParam {
  repeatCount: number;
  scanCode: number;
  /** Scan code with the E0 marker represented in the high byte. */
  extendedScanCode: number;
  isExtended: boolean;
  contextCode: boolean;
  previousKeyState: boolean;
  transitionState: boolean;
  isRepeat: boolean;
}

/** Decode the documented bit fields carried by WM_KEY* and WM_CHAR lParam values. */
export function decodeKeyLParam(lParam: number | bigint): DecodedKeyLParam {
  const raw = BigInt.asUintN(64, BigInt(lParam));
  const scanCode = Number((raw >> 16n) & 0xffn);
  const isExtended = ((raw >> 24n) & 1n) !== 0n;
  const previousKeyState = ((raw >> 30n) & 1n) !== 0n;
  return {
    repeatCount: Number(raw & 0xffffn),
    scanCode,
    extendedScanCode: isExtended ? 0xe000 | scanCode : scanCode,
    isExtended,
    contextCode: ((raw >> 29n) & 1n) !== 0n,
    previousKeyState,
    transitionState: ((raw >> 31n) & 1n) !== 0n,
    isRepeat: previousKeyState,
  };
}

/** Expand one packed native keydown into browser-style per-transition events. */
export function expandWin32KeyRepeats(event: KeyEvent, lParam: number | bigint): KeyEvent[] {
  if (event.type !== "keydown") return [event];
  const decoded = decodeKeyLParam(lParam);
  // A real key message always represents at least one transition. Preserve
  // that transition for malformed/synthetic messages whose low word is zero.
  const count = Math.max(1, decoded.repeatCount);
  return Array.from({ length: count }, (_, index) => ({
    ...event,
    repeat: decoded.previousKeyState || index > 0,
  }));
}

function keyIsDown(state: Uint8Array, virtualKey: number): boolean {
  return (state[virtualKey] & 0x80) !== 0;
}

function keyIsToggled(state: Uint8Array, virtualKey: number): boolean {
  return (state[virtualKey] & 0x01) !== 0;
}

/** AltGr is represented by Windows as the combination Control + right Alt. */
export function isAltGraphActive(state: Uint8Array): boolean {
  return keyIsDown(state, VK.RMENU) &&
    (keyIsDown(state, VK.CONTROL) || keyIsDown(state, VK.LCONTROL) || keyIsDown(state, VK.RCONTROL));
}

export interface Win32KeyboardModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  accelKey: boolean;
  capsLock: boolean;
  altGraphKey: boolean;
}

/** Match browser AltGraph exposure without treating every Ctrl+Alt shortcut as text. */
export function shouldExposeAltGraph(
  modifiers: Win32KeyboardModifiers,
  layoutHasAltGraph: boolean,
  producesText: boolean,
): boolean {
  return layoutHasAltGraph &&
    (modifiers.altGraphKey || (producesText && modifiers.ctrlKey && modifiers.altKey));
}

/** Classify one Win32 keydown using its actual native message ownership. */
export function win32KeyEditDisposition(
  key: string,
  isComposing: boolean,
  modifiers: Win32KeyboardModifiers,
  text: string | undefined,
  systemMessage: boolean,
): KeyEditDisposition {
  // AltGr may arrive through WM_SYSKEYDOWN, but winding consumes the matching
  // WM_SYSCHAR as text instead of leaving it to DefWindowProcW.
  if (systemMessage && !modifiers.altGraphKey) return "platform";
  if (isComposing || key === "Dead" || key === "Process") return "text-input";
  if (text !== undefined && (modifiers.altGraphKey || (!modifiers.ctrlKey && !modifiers.metaKey))) {
    return "text-input";
  }
  return "key-default";
}

/** Read modifier and toggle bits from a 256-byte GetKeyboardState snapshot. */
export function keyboardModifiers(state: Uint8Array): Win32KeyboardModifiers {
  const ctrlKey = keyIsDown(state, VK.CONTROL) || keyIsDown(state, VK.LCONTROL) ||
    keyIsDown(state, VK.RCONTROL);
  const altKey = keyIsDown(state, VK.MENU) || keyIsDown(state, VK.LMENU) || keyIsDown(state, VK.RMENU);
  const altGraphKey = isAltGraphActive(state);
  return {
    shiftKey: keyIsDown(state, VK.SHIFT) || keyIsDown(state, VK.LSHIFT) || keyIsDown(state, VK.RSHIFT),
    ctrlKey,
    altKey,
    metaKey: keyIsDown(state, VK.LWIN) || keyIsDown(state, VK.RWIN),
    // AltGr's synthetic Control must not turn text entry into an accelerator.
    accelKey: ctrlKey && !altGraphKey,
    capsLock: keyIsToggled(state, VK.CAPITAL),
    altGraphKey,
  };
}

/**
 * Build the snapshot supplied to ToUnicodeEx. Ordinary Control/Alt shortcuts
 * should still resolve the underlying printable logical key, while AltGr must
 * retain both of the modifier bits Windows uses to select its layout level.
 */
export function keyboardStateForTranslation(state: Uint8Array, preserveCtrlAlt = isAltGraphActive(state)): Uint8Array {
  const translatedState = Uint8Array.from(state);
  if (preserveCtrlAlt) return translatedState;

  for (
    const virtualKey of [
      VK.CONTROL,
      VK.LCONTROL,
      VK.RCONTROL,
      VK.MENU,
      VK.LMENU,
      VK.RMENU,
    ]
  ) {
    translatedState[virtualKey] &= 0x7f;
  }
  return translatedState;
}

export interface ToUnicodeResult {
  /** ToUnicodeEx's return value: negative is dead, zero is no translation, positive is UTF-16 units. */
  result: number;
  /** The UTF-16 JavaScript string written into the adapter's native buffer. */
  text: string;
}

/** Adapter around ToUnicodeEx, with the active HKL captured by the FFI-backed caller. */
export interface ToUnicodeAdapter {
  toUnicode(
    virtualKey: number,
    scanCode: number,
    keyboardState: Uint8Array,
    flags: number,
  ): ToUnicodeResult;
}

export interface LogicalKeyTranslation {
  key: string;
  /** Printable layout text returned by ToUnicodeEx for this transition. */
  text?: string;
  dead: boolean;
  modifiers: Win32KeyboardModifiers;
}

/** Translate a native key using the active Windows keyboard layout. */
export function translateLogicalKey(
  virtualKey: number,
  lParam: number | bigint,
  keyboardState: Uint8Array,
  adapter: ToUnicodeAdapter,
  preserveCtrlAlt = isAltGraphActive(keyboardState),
): LogicalKeyTranslation {
  const modifiers = keyboardModifiers(keyboardState);
  const state = keyboardStateForTranslation(keyboardState, preserveCtrlAlt);
  const scanCode = decodeKeyLParam(lParam).scanCode;

  let translation: ToUnicodeResult;
  try {
    translation = adapter.toUnicode(virtualKey, scanCode, state, TO_UNICODE_NO_STATE_CHANGE);
  } catch {
    return { key: logicalKeyFromVirtualKey(virtualKey), dead: false, modifiers };
  }

  if (translation.result < 0) return { key: "Dead", dead: true, modifiers };
  const translatedText = translation.result > 0 ? translation.text.slice(0, translation.result) : undefined;
  const text = translatedText === undefined ? undefined : normalizeCommittedText(translatedText);
  if (text === undefined && preserveCtrlAlt) {
    try {
      const fallback = adapter.toUnicode(
        virtualKey,
        scanCode,
        keyboardStateForTranslation(keyboardState, false),
        TO_UNICODE_NO_STATE_CHANGE,
      );
      if (fallback.result < 0) return { key: "Dead", dead: true, modifiers };
      const fallbackText = fallback.result > 0 ? fallback.text.slice(0, fallback.result) : undefined;
      return {
        key: logicalKeyFromVirtualKey(virtualKey, fallbackText),
        dead: false,
        modifiers,
      };
    } catch {
      return { key: logicalKeyFromVirtualKey(virtualKey), dead: false, modifiers };
    }
  }
  return {
    key: logicalKeyFromVirtualKey(virtualKey, translatedText),
    ...(text === undefined ? {} : { text }),
    dead: false,
    modifiers,
  };
}

const NAMED_VIRTUAL_KEYS = new Map<number, string>([
  [VK.BACK, "Backspace"],
  [VK.TAB, "Tab"],
  [VK.CLEAR, "Clear"],
  [VK.RETURN, "Enter"],
  [VK.SHIFT, "Shift"],
  [VK.CONTROL, "Control"],
  [VK.MENU, "Alt"],
  [VK.PAUSE, "Pause"],
  [VK.CAPITAL, "CapsLock"],
  [VK.KANA, "KanaMode"],
  [VK.JUNJA, "JunjaMode"],
  [VK.FINAL, "FinalMode"],
  [VK.HANJA, "HanjaMode"],
  [VK.ESCAPE, "Escape"],
  [VK.CONVERT, "Convert"],
  [VK.NONCONVERT, "NonConvert"],
  [VK.ACCEPT, "Accept"],
  [VK.MODECHANGE, "ModeChange"],
  [VK.SPACE, " "],
  [VK.PRIOR, "PageUp"],
  [VK.NEXT, "PageDown"],
  [VK.END, "End"],
  [VK.HOME, "Home"],
  [VK.LEFT, "ArrowLeft"],
  [VK.UP, "ArrowUp"],
  [VK.RIGHT, "ArrowRight"],
  [VK.DOWN, "ArrowDown"],
  [VK.SELECT, "Select"],
  [VK.PRINT, "Print"],
  [VK.EXECUTE, "Execute"],
  [VK.SNAPSHOT, "PrintScreen"],
  [VK.INSERT, "Insert"],
  [VK.DELETE, "Delete"],
  [VK.HELP, "Help"],
  [VK.LWIN, "Meta"],
  [VK.RWIN, "Meta"],
  [VK.APPS, "ContextMenu"],
  [VK.SLEEP, "Standby"],
  [VK.NUMLOCK, "NumLock"],
  [VK.SCROLL, "ScrollLock"],
  [VK.LSHIFT, "Shift"],
  [VK.RSHIFT, "Shift"],
  [VK.LCONTROL, "Control"],
  [VK.RCONTROL, "Control"],
  [VK.LMENU, "Alt"],
  [VK.RMENU, "AltGraph"],
  [VK.BROWSER_BACK, "BrowserBack"],
  [VK.BROWSER_FORWARD, "BrowserForward"],
  [VK.BROWSER_REFRESH, "BrowserRefresh"],
  [VK.BROWSER_STOP, "BrowserStop"],
  [VK.BROWSER_SEARCH, "BrowserSearch"],
  [VK.BROWSER_FAVORITES, "BrowserFavorites"],
  [VK.BROWSER_HOME, "BrowserHome"],
  [VK.VOLUME_MUTE, "AudioVolumeMute"],
  [VK.VOLUME_DOWN, "AudioVolumeDown"],
  [VK.VOLUME_UP, "AudioVolumeUp"],
  [VK.MEDIA_NEXT_TRACK, "MediaTrackNext"],
  [VK.MEDIA_PREV_TRACK, "MediaTrackPrevious"],
  [VK.MEDIA_STOP, "MediaStop"],
  [VK.MEDIA_PLAY_PAUSE, "MediaPlayPause"],
  [VK.LAUNCH_MAIL, "LaunchMail"],
  [VK.LAUNCH_MEDIA_SELECT, "MediaSelect"],
  [VK.LAUNCH_APP1, "LaunchApplication1"],
  [VK.LAUNCH_APP2, "LaunchApplication2"],
  [VK.PROCESSKEY, "Process"],
  [VK.ATTN, "Attn"],
  [VK.CRSEL, "CrSel"],
  [VK.EXSEL, "ExSel"],
  [VK.EREOF, "EraseEof"],
  [VK.PLAY, "Play"],
  [VK.ZOOM, "ZoomToggle"],
  [VK.PA1, "PA1"],
  [VK.OEM_CLEAR, "Clear"],
]);

/** Map a virtual key and optional ToUnicodeEx output to a DOM-style logical key. */
export function logicalKeyFromVirtualKey(virtualKey: number, translatedText?: string): string {
  const named = NAMED_VIRTUAL_KEYS.get(virtualKey);
  if (named !== undefined) return named;
  if (virtualKey >= VK.F1 && virtualKey <= VK.F24) return `F${virtualKey - VK.F1 + 1}`;
  return translatedText !== undefined && isCommitText(translatedText) ? translatedText : "Unidentified";
}

/** Text accepted from WM_CHAR/ToUnicodeEx. Key controls are dispatched separately. */
export function isCommitText(text: string): boolean {
  return normalizeCommittedText(text) !== undefined;
}

export function win32KeyIdentity(virtualKey: number, lParam: number | bigint): string {
  const scanCode = decodeKeyLParam(lParam).extendedScanCode;
  return scanCode === 0 ? `vk:${virtualKey}` : `scan:${scanCode}:vk:${virtualKey}`;
}

export interface Win32KeyMessage {
  phase: "down" | "up";
  virtualKey: number;
  lParam: number | bigint;
  /** MSG.time, when available. Synthetic Control and right-Alt messages share it. */
  timestamp?: number;
}

function isUnextendedControl(message: Win32KeyMessage): boolean {
  const decoded = decodeKeyLParam(message.lParam);
  return (message.virtualKey === VK.CONTROL || message.virtualKey === VK.LCONTROL) &&
    !decoded.isExtended && decoded.scanCode === 0x1d;
}

function isExtendedRightAlt(message: Win32KeyMessage): boolean {
  const decoded = decodeKeyLParam(message.lParam);
  return (message.virtualKey === VK.MENU || message.virtualKey === VK.RMENU) &&
    decoded.isExtended && decoded.scanCode === 0x38;
}

/**
 * Filters the fake left-Control transition Windows places around AltGr. The
 * caller supplies the next queued key message for the down-pair check.
 */
export class AltGraphControlFilter {
  #syntheticControlDown = false;

  shouldSuppress(current: Win32KeyMessage, next?: Win32KeyMessage): boolean {
    if (current.phase === "up" && this.#syntheticControlDown && isUnextendedControl(current)) {
      this.#syntheticControlDown = false;
      return true;
    }
    if (
      current.phase !== "down" || !isUnextendedControl(current) || next?.phase !== "down" ||
      !isExtendedRightAlt(next)
    ) {
      return false;
    }
    if (current.timestamp !== undefined && next.timestamp !== undefined && current.timestamp !== next.timestamp) {
      return false;
    }
    this.#syntheticControlDown = true;
    return true;
  }

  reset(): void {
    this.#syntheticControlDown = false;
  }
}

export interface DecodedWmChar {
  /** One decoded Unicode scalar, or U+FFFD for malformed UTF-16. */
  text: string;
  /** The repeat count to apply after the scalar has been fully decoded. */
  repeatCount: number;
}

interface PendingHighSurrogate {
  codeUnit: number;
  repeatCount: number;
}

/** Incrementally decodes the UTF-16 code units delivered by WM_CHAR/WM_IME_CHAR. */
export class WmCharDecoder {
  #pendingHigh: PendingHighSurrogate | undefined;

  push(codeUnit: number | bigint, repeatCount = 1): DecodedWmChar[] {
    const unit = Number(BigInt(codeUnit) & 0xffffn);
    const repeat = normalizeRepeatCount(repeatCount);
    const decoded: DecodedWmChar[] = [];

    if (this.#pendingHigh !== undefined) {
      const pending = this.#pendingHigh;
      this.#pendingHigh = undefined;
      if (isLowSurrogate(unit)) {
        const pairedRepeats = Math.min(pending.repeatCount, repeat);
        const codePoint = 0x10000 + ((pending.codeUnit - 0xd800) << 10) + (unit - 0xdc00);
        decoded.push({ text: String.fromCodePoint(codePoint), repeatCount: pairedRepeats });
        if (pending.repeatCount > pairedRepeats) {
          decoded.push({ text: "\ufffd", repeatCount: pending.repeatCount - pairedRepeats });
        }
        if (repeat > pairedRepeats) {
          decoded.push({ text: "\ufffd", repeatCount: repeat - pairedRepeats });
        }
        return decoded;
      }
      decoded.push({ text: "\ufffd", repeatCount: pending.repeatCount });
    }

    if (isHighSurrogate(unit)) {
      this.#pendingHigh = { codeUnit: unit, repeatCount: repeat };
    } else if (isLowSurrogate(unit)) {
      decoded.push({ text: "\ufffd", repeatCount: repeat });
    } else {
      const text = String.fromCharCode(unit);
      if (isCommitText(text)) decoded.push({ text, repeatCount: repeat });
    }
    return decoded;
  }

  /** Recover a final unpaired high surrogate when a stream is interrupted. */
  flush(): DecodedWmChar[] {
    const pending = this.#pendingHigh;
    this.#pendingHigh = undefined;
    return pending === undefined ? [] : [{ text: "\ufffd", repeatCount: pending.repeatCount }];
  }

  reset(): void {
    this.#pendingHigh = undefined;
  }
}

function normalizeRepeatCount(repeatCount: number): number {
  if (!Number.isFinite(repeatCount)) return 1;
  return Math.min(0xffff, Math.max(1, Math.trunc(repeatCount)));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Expand a decoded scalar only after surrogate assembly and control filtering. */
export function repeatedWmCharText(decoded: DecodedWmChar): string {
  return decoded.text.repeat(decoded.repeatCount);
}

export interface InsertOnTypePreedit {
  text: string;
  cursorRange: readonly [start: number, end: number];
}

/**
 * Compatibility state for Korean IMM's documented insert-on-type behavior.
 * Each unmatched WM_CHAR replaces the previous provisional character. Native
 * composition/result data discards it; otherwise END promotes it exactly once
 * so an accepted character is not lost. An explicit cancellation must clear
 * the state before END because that message does not distinguish accept/cancel.
 */
export class InsertOnTypeFallbackState {
  #active = false;
  #pendingText: string | undefined;

  get active(): boolean {
    return this.#active;
  }

  get pendingText(): string | undefined {
    return this.#pendingText;
  }

  start(): void {
    this.#active = true;
    this.#pendingText = undefined;
  }

  update(text: string): InsertOnTypePreedit | undefined {
    if (!this.#active || text.length === 0) return undefined;
    this.#pendingText = text;
    const end = UTF8_ENCODER.encode(text).byteLength;
    return { text, cursorRange: [end, end] };
  }

  /** Native composition text or a definitive result supersedes the fallback. */
  authoritative(): void {
    this.#pendingText = undefined;
  }

  /** Discard provisional text on an explicit cancellation path. */
  cancel(): void {
    this.#active = false;
    this.#pendingText = undefined;
  }

  /** Take a still-provisional character once when native composition ends. */
  finish(): string | undefined {
    const text = this.#pendingText;
    this.#active = false;
    this.#pendingText = undefined;
    return text;
  }
}

/** Prevents IMM32 result strings from being committed again by a following WM_CHAR echo. */
export class ResultEchoSuppressor {
  #pending = "";
  #expiresAt = 0;

  constructor(
    readonly ttlMilliseconds = 500,
    readonly now: () => number = () => performance.now(),
  ) {}

  get pendingText(): string {
    this.#expire();
    return this.#pending;
  }

  expect(text: string): void {
    if (text.length === 0) return;
    this.#expire();
    this.#pending += text;
    this.#expiresAt = this.now() + Math.max(0, this.ttlMilliseconds);
  }

  /** Return true only when the complete decoded WM_CHAR text matches the pending prefix. */
  consume(text: string, repeatCount = 1): boolean {
    this.#expire();
    const incoming = text.repeat(normalizeRepeatCount(repeatCount));
    if (incoming.length === 0 || this.#pending.length === 0 || !this.#pending.startsWith(incoming)) {
      if (incoming.length > 0) this.clear();
      return false;
    }
    this.#pending = this.#pending.slice(incoming.length);
    if (this.#pending.length === 0) this.#expiresAt = 0;
    return true;
  }

  clear(): void {
    this.#pending = "";
    this.#expiresAt = 0;
  }

  #expire(): void {
    if (this.#pending.length > 0 && this.now() > this.#expiresAt) this.clear();
  }
}
