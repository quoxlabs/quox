/** Pure Win32 keyboard and IME helpers. This module intentionally performs no FFI. */

const UTF8_ENCODER = new TextEncoder();
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;

/** Small testable FIFO used when one native message expands to several semantic events. */
export class SemanticEventQueue<Event> {
  readonly #events: Event[] = [];

  get length(): number {
    return this.#events.length;
  }

  push(event: Event): void {
    this.#events.push(event);
  }

  shift(): Event | undefined {
    return this.#events.shift();
  }
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

/** Candidate window excludes the supplied rectangle. */
export const CFS_EXCLUDE = 0x0080;
/** Composition window uses the supplied point. */
export const CFS_POINT = 0x0002;

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

export type KeyLocation = "standard" | "left" | "right" | "numpad";

/** Resolve a DOM KeyboardEvent.location-style value from the physical code. */
export function keyLocation(code: string): KeyLocation {
  if (code.startsWith("Numpad")) return "numpad";
  if (code.endsWith("Left")) return "left";
  if (code.endsWith("Right")) return "right";
  return "standard";
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
export function keyboardStateForTranslation(state: Uint8Array, altGraphKey = isAltGraphActive(state)): Uint8Array {
  const translatedState = Uint8Array.from(state);
  if (altGraphKey) return translatedState;

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
  dead: boolean;
  modifiers: Win32KeyboardModifiers;
}

/** Translate a native key using the active Windows keyboard layout. */
export function translateLogicalKey(
  virtualKey: number,
  lParam: number | bigint,
  keyboardState: Uint8Array,
  adapter: ToUnicodeAdapter,
): LogicalKeyTranslation {
  const modifiers = keyboardModifiers(keyboardState);
  const state = keyboardStateForTranslation(keyboardState, modifiers.altGraphKey);
  const scanCode = decodeKeyLParam(lParam).scanCode;

  let translation: ToUnicodeResult;
  try {
    translation = adapter.toUnicode(virtualKey, scanCode, state, TO_UNICODE_NO_STATE_CHANGE);
  } catch {
    return { key: logicalKeyFromVirtualKey(virtualKey), dead: false, modifiers };
  }

  if (translation.result < 0) return { key: "Dead", dead: true, modifiers };
  const translatedText = translation.result > 0 ? translation.text.slice(0, translation.result) : undefined;
  return {
    key: logicalKeyFromVirtualKey(virtualKey, translatedText),
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
  if (text.length === 0) return false;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

function keyIdentity(virtualKey: number, lParam: number | bigint): string {
  const scanCode = decodeKeyLParam(lParam).extendedScanCode;
  return scanCode === 0 ? `vk:${virtualKey}` : `scan:${scanCode}:vk:${virtualKey}`;
}

/** Retains the layout-resolved key value so keyup matches its keydown across state changes. */
export class LogicalKeyCache {
  readonly #keys = new Map<string, string>();

  remember(virtualKey: number, lParam: number | bigint, key: string): void {
    this.#keys.set(keyIdentity(virtualKey, lParam), key);
  }

  get(virtualKey: number, lParam: number | bigint): string | undefined {
    return this.#keys.get(keyIdentity(virtualKey, lParam));
  }

  release(virtualKey: number, lParam: number | bigint): string | undefined {
    const identity = keyIdentity(virtualKey, lParam);
    const key = this.#keys.get(identity);
    this.#keys.delete(identity);
    return key;
  }

  clear(): void {
    this.#keys.clear();
  }
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

/** Convert a valid UTF-16 cursor boundary to the byte offset Blitz uses for preedit. */
export function utf16IndexToUtf8Offset(text: string, utf16Index: number): number | undefined {
  if (!Number.isSafeInteger(utf16Index) || utf16Index < 0 || utf16Index > text.length) return undefined;
  if (
    utf16Index > 0 && utf16Index < text.length &&
    isHighSurrogate(text.charCodeAt(utf16Index - 1)) && isLowSurrogate(text.charCodeAt(utf16Index))
  ) {
    return undefined;
  }
  return UTF8_ENCODER.encode(text.slice(0, utf16Index)).byteLength;
}

export type PreeditCursorRange = readonly [start: number, end: number];

/** Convert IMM32's collapsed UTF-16 cursor to a collapsed UTF-8 byte range. */
export function utf16CursorRangeToUtf8(text: string, utf16Index: number): PreeditCursorRange | undefined {
  const offset = utf16IndexToUtf8Offset(text, utf16Index);
  return offset === undefined ? undefined : [offset, offset];
}

/** Convert a Blitz UTF-8 byte cursor boundary back to a JavaScript UTF-16 index. */
export function utf8OffsetToUtf16Index(text: string, utf8Offset: number): number | undefined {
  if (!Number.isSafeInteger(utf8Offset) || utf8Offset < 0) return undefined;

  let offset = 0;
  for (let index = 0; index < text.length;) {
    if (offset === utf8Offset) return index;
    const codePoint = text.codePointAt(index)!;
    const scalar = String.fromCodePoint(codePoint);
    offset += UTF8_ENCODER.encode(scalar).byteLength;
    if (offset > utf8Offset) return undefined;
    index += scalar.length;
  }
  return offset === utf8Offset ? text.length : undefined;
}

/** Apply WM_IME_COMPOSITION's CS_INSERTCHAR operation to cached preedit state. */
export function insertCompositionCharacter(
  text: string,
  cursorRange: PreeditCursorRange | undefined,
  character: string,
  noMoveCaret: boolean,
): { text: string; cursorRange: PreeditCursorRange } {
  const endOffset = UTF8_ENCODER.encode(text).byteLength;
  const requestedOffset = cursorRange?.[1] ?? endOffset;
  const insertionIndex = utf8OffsetToUtf16Index(text, requestedOffset) ?? text.length;
  const insertionOffset = utf16IndexToUtf8Offset(text, insertionIndex) ?? endOffset;
  const nextText = text.slice(0, insertionIndex) + character + text.slice(insertionIndex);
  const nextOffset = noMoveCaret ? insertionOffset : insertionOffset + UTF8_ENCODER.encode(character).byteLength;
  return { text: nextText, cursorRange: [nextOffset, nextOffset] };
}

export interface CursorRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalize a logical cursor area to Win32 LONGs, rounding outward. */
export function normalizeCursorRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): CursorRectangle | undefined {
  if (![x, y, width, height].every(Number.isFinite)) return undefined;

  const normalizedX = clampInt32(Math.floor(x));
  const normalizedY = clampInt32(Math.floor(y));
  const normalizedRight = clampInt32(Math.ceil(x + Math.max(0, width)));
  const normalizedBottom = clampInt32(Math.ceil(y + Math.max(0, height)));
  return {
    x: normalizedX,
    y: normalizedY,
    width: width <= 0 ? 0 : clampDimension(normalizedRight - normalizedX),
    height: height <= 0 ? 0 : clampDimension(normalizedBottom - normalizedY),
  };
}

function clampInt32(value: number): number {
  return Math.min(INT32_MAX, Math.max(INT32_MIN, value));
}

function clampDimension(value: number): number {
  return Math.min(INT32_MAX, Math.max(0, value));
}

function rectRight(rect: CursorRectangle): number {
  return clampInt32(rect.x + rect.width);
}

function rectBottom(rect: CursorRectangle): number {
  return clampInt32(rect.y + rect.height);
}

/** Encode the 32-byte, pointer-free CANDIDATEFORM structure. */
export function encodeCandidateForm(rect: CursorRectangle, index = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, clampUint32(index), true);
  view.setUint32(4, CFS_EXCLUDE, true);
  view.setInt32(8, rect.x, true);
  view.setInt32(12, rectBottom(rect), true);
  writeRect(view, 16, rect);
  return buffer;
}

/** Encode the 28-byte, pointer-free COMPOSITIONFORM structure. */
export function encodeCompositionForm(rect: CursorRectangle): ArrayBuffer {
  const buffer = new ArrayBuffer(28);
  const view = new DataView(buffer);
  view.setUint32(0, CFS_POINT, true);
  view.setInt32(4, rect.x, true);
  view.setInt32(8, rectBottom(rect), true);
  writeRect(view, 12, rect);
  return buffer;
}

/** Encode the 36-byte IMECHARPOSITION response used by IMR_QUERYCHARPOSITION. */
export function encodeImeCharPosition(
  characterPosition: number,
  caretRect: CursorRectangle,
  documentRect: CursorRectangle,
): ArrayBuffer {
  const buffer = new ArrayBuffer(36);
  const view = new DataView(buffer);
  view.setUint32(0, buffer.byteLength, true);
  view.setUint32(4, clampUint32(characterPosition), true);
  view.setInt32(8, caretRect.x, true);
  view.setInt32(12, caretRect.y, true);
  view.setUint32(16, clampUint32(caretRect.height), true);
  writeRect(view, 20, documentRect);
  return buffer;
}

function writeRect(view: DataView, offset: number, rect: CursorRectangle): void {
  view.setInt32(offset, rect.x, true);
  view.setInt32(offset + 4, rect.y, true);
  view.setInt32(offset + 8, rectRight(rect), true);
  view.setInt32(offset + 12, rectBottom(rect), true);
}

function clampUint32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(UINT32_MAX, Math.max(0, Math.trunc(value)));
}

export type ImeEdit =
  | { type: "preedit"; text: string; cursorRange?: PreeditCursorRange }
  | { type: "commit"; text: string };

export interface ImeCompositionUpdate {
  /** Presence means GCS_RESULTSTR was returned; the empty string is still a result. */
  result?: string;
  /** Undefined leaves preedit unchanged, null/empty clears it, and text replaces it. */
  preedit?: { text: string; cursorRange?: PreeditCursorRange } | null;
}

/** Orders the semantic edits produced from IMM32 composition messages. */
export class ImeCompositionReducer {
  #hasVisiblePreedit = false;

  get hasVisiblePreedit(): boolean {
    return this.#hasVisiblePreedit;
  }

  update(update: ImeCompositionUpdate): ImeEdit[] {
    const edits: ImeEdit[] = [];
    if (typeof update.result === "string") {
      // A commit is authoritative and always explicitly terminates the old preedit.
      edits.push({ type: "preedit", text: "" });
      edits.push({ type: "commit", text: update.result });
      this.#hasVisiblePreedit = false;
    }

    if (update.preedit !== undefined) {
      const preedit = update.preedit;
      if (preedit === null || preedit.text.length === 0) {
        if (this.#hasVisiblePreedit) edits.push({ type: "preedit", text: "" });
        this.#hasVisiblePreedit = false;
      } else {
        edits.push({
          type: "preedit",
          text: preedit.text,
          ...(preedit.cursorRange === undefined ? {} : { cursorRange: preedit.cursorRange }),
        });
        this.#hasVisiblePreedit = true;
      }
    }
    return edits;
  }

  /** Finish or cancel a composition without disabling the IME. */
  end(): ImeEdit[] {
    if (!this.#hasVisiblePreedit) return [];
    this.#hasVisiblePreedit = false;
    return [{ type: "preedit", text: "" }];
  }

  reset(): void {
    this.#hasVisiblePreedit = false;
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

/** Adapter around ImmGetCompositionStringW for exact, race-tolerant UTF-16 reads. */
export interface ImmCompositionAdapter {
  getCompositionString(index: number, buffer?: Uint8Array): number;
}

/** Read an IMM string whose reported lengths are bytes, not UTF-16 units. */
export function readImmUtf16(
  adapter: ImmCompositionAdapter,
  index: number,
  maximumAttempts = 3,
): string | undefined {
  for (let attempt = 0; attempt < Math.max(1, maximumAttempts); attempt++) {
    const byteLength = adapter.getCompositionString(index);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || (byteLength & 1) !== 0) return undefined;
    if (byteLength === 0) return "";

    const buffer = new Uint8Array(byteLength);
    const bytesWritten = adapter.getCompositionString(index, buffer);
    if (!Number.isSafeInteger(bytesWritten)) return undefined;
    if (bytesWritten < 0) {
      // A composition can grow between the size query and copy. Native IMM
      // implementations may report that as an error rather than returning the
      // new required size, so re-query before treating it as a hard failure.
      const currentLength = adapter.getCompositionString(index);
      if (Number.isSafeInteger(currentLength) && currentLength > buffer.byteLength && (currentLength & 1) === 0) {
        continue;
      }
      return undefined;
    }
    if ((bytesWritten & 1) !== 0) return undefined;
    if (bytesWritten > buffer.byteLength) continue;
    const currentLength = adapter.getCompositionString(index);
    if (Number.isSafeInteger(currentLength) && currentLength >= 0 && (currentLength & 1) === 0) {
      if (currentLength !== bytesWritten) continue;
    }
    if (bytesWritten === 0) return currentLength === 0 ? "" : undefined;
    return decodeUtf16Le(buffer.subarray(0, bytesWritten));
  }
  return undefined;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    text += String.fromCharCode(view.getUint16(offset, true));
  }
  return text;
}

/** Acquire/release an input context with release guaranteed across returns and exceptions. */
export function withImeContext<Context, Result>(
  acquire: () => Context | null | undefined,
  release: (context: Context) => void,
  callback: (context: Context) => Result,
): Result | undefined {
  const context = acquire();
  if (context === null || context === undefined) return undefined;
  try {
    return callback(context);
  } finally {
    release(context);
  }
}
