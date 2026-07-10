/** Pure Wayland keyboard/text-input state used by the FFI-backed implementation. */

import type { KeyLocation } from "../types.ts";

const UTF8_ENCODER = new TextEncoder();
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;

export type EnvironmentReader = (name: "LC_ALL" | "LC_CTYPE" | "LANG") => string | undefined;

function readProcessEnvironment(name: "LC_ALL" | "LC_CTYPE" | "LANG"): string | undefined {
  // Environment access can be denied by Deno's permission system. Compose has a
  // well-defined C-locale fallback, so a missing permission is not fatal.
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Resolve the locale used to construct an xkb Compose table. */
export function resolveComposeLocale(readEnvironment: EnvironmentReader = readProcessEnvironment): string {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    let value: string | undefined;
    try {
      value = readEnvironment(name);
    } catch {
      // Treat an inaccessible variable exactly like an unset one and continue
      // through the locale precedence list.
      continue;
    }
    if (value !== undefined && value.length > 0) return value;
  }
  return "C";
}

/** Wayland uses evdev codes, while xkbcommon key APIs expect evdev + 8. */
export function toXkbKeycode(rawKeycode: number): number {
  return rawKeycode + 8;
}

/** Derive DOM KeyboardEvent.location from an already-normalized physical code. */
export function keyLocationForCode(code: string): KeyLocation {
  if (code.startsWith("Numpad")) return 3;
  if (/^(?:Shift|Control|Alt|Meta|OS)Left$/.test(code)) return 1;
  if (/^(?:Shift|Control|Alt|Meta|OS)Right$/.test(code)) return 2;
  return 0;
}

export const ComposeFeedResult = {
  IGNORED: 0,
  ACCEPTED: 1,
} as const;

export const ComposeStatus = {
  NOTHING: 0,
  COMPOSING: 1,
  COMPOSED: 2,
  CANCELLED: 3,
} as const;

export interface XkbKeyTranslator {
  /** Equivalent to xkb_state_key_get_one_sym. */
  keysymForKeycode(xkbKeycode: number): number;
  /** Equivalent to xkb_state_key_get_utf8. */
  utf8ForKeycode(xkbKeycode: number): string;
  /** Equivalent to xkb_keysym_to_utf8. */
  utf8ForKeysym(keysym: number): string;
}

export interface ComposeAdapter {
  /** Returns an XKB_COMPOSE_FEED_* value. */
  feed(keysym: number): number;
  /** Returns an XKB_COMPOSE_* status value. */
  status(): number;
  utf8(): string;
  reset(): void;
}

export type KeyPhase = "press" | "release" | "repeat";

export interface TranslatedKey {
  /** The original evdev keycode supplied by Wayland. */
  rawKeycode: number;
  /** The keycode supplied to xkbcommon. */
  xkbKeycode: number;
  keysym: number;
  /** DOM KeyboardEvent.key-style logical key. */
  key: string;
  /** Text produced by this press/repeat, if any. Never present on release. */
  text?: string;
  isComposing: boolean;
}

/**
 * Resolve one keyboard transition. Physical-code lookup intentionally remains
 * outside this helper because it must continue to use rawKeycode.
 */
export function translateKey(
  rawKeycode: number,
  phase: KeyPhase,
  translator: XkbKeyTranslator,
  compose?: ComposeAdapter,
): TranslatedKey {
  const xkbKeycode = toXkbKeycode(rawKeycode);
  const keysym = translator.keysymForKeycode(xkbKeycode);
  const key = logicalKeyFromKeysym(keysym, translator.utf8ForKeysym(keysym));
  const base: TranslatedKey = { rawKeycode, xkbKeycode, keysym, key, isComposing: false };

  if (phase === "release") return base;
  if (!compose) return translatedKeyWithText(base, translator.utf8ForKeycode(xkbKeycode));

  const feedResult = compose.feed(keysym);
  const status = compose.status();
  if (feedResult !== ComposeFeedResult.ACCEPTED) {
    return { ...base, isComposing: status === ComposeStatus.COMPOSING };
  }

  switch (status) {
    case ComposeStatus.NOTHING:
      return translatedKeyWithText(base, translator.utf8ForKeycode(xkbKeycode));
    case ComposeStatus.COMPOSING:
      return { ...base, isComposing: true };
    case ComposeStatus.COMPOSED: {
      const text = compose.utf8();
      compose.reset();
      return isPrintableKeyText(text) ? { ...base, key: text, text } : base;
    }
    case ComposeStatus.CANCELLED:
      compose.reset();
      return base;
    default:
      // Unknown states must not synthesize text: a newer xkbcommon state should
      // degrade safely rather than insert an unrelated physical key value.
      return base;
  }
}

function translatedKeyWithText(base: TranslatedKey, text: string): TranslatedKey {
  return isPrintableKeyText(text) ? { ...base, text } : base;
}

const NAMED_KEYSYMS = new Map<number, string>([
  [0xff08, "Backspace"],
  [0xff09, "Tab"],
  [0xff0b, "Clear"],
  [0xff0d, "Enter"],
  [0xff13, "Pause"],
  [0xff14, "ScrollLock"],
  [0xff15, "PrintScreen"],
  [0xff1b, "Escape"],
  [0xffff, "Delete"],
  [0xff50, "Home"],
  [0xff51, "ArrowLeft"],
  [0xff52, "ArrowUp"],
  [0xff53, "ArrowRight"],
  [0xff54, "ArrowDown"],
  [0xff55, "PageUp"],
  [0xff56, "PageDown"],
  [0xff57, "End"],
  [0xff58, "Clear"],
  [0xff60, "Select"],
  [0xff61, "PrintScreen"],
  [0xff62, "Execute"],
  [0xff63, "Insert"],
  [0xff65, "Undo"],
  [0xff66, "Redo"],
  [0xff67, "ContextMenu"],
  [0xff68, "Find"],
  [0xff69, "Cancel"],
  [0xff6a, "Help"],
  [0xff6b, "Pause"],
  [0xff7e, "ModeChange"],
  [0xff7f, "NumLock"],
  [0xff80, " "],
  [0xff89, "Tab"],
  [0xff8d, "Enter"],
  [0xff91, "F1"],
  [0xff92, "F2"],
  [0xff93, "F3"],
  [0xff94, "F4"],
  [0xff95, "Home"],
  [0xff96, "ArrowLeft"],
  [0xff97, "ArrowUp"],
  [0xff98, "ArrowRight"],
  [0xff99, "ArrowDown"],
  [0xff9a, "PageUp"],
  [0xff9b, "PageDown"],
  [0xff9c, "End"],
  [0xff9d, "Clear"],
  [0xff9e, "Insert"],
  [0xff9f, "Delete"],
  [0xffaa, "*"],
  [0xffab, "+"],
  [0xffac, ","],
  [0xffad, "-"],
  [0xffae, "."],
  [0xffaf, "/"],
  [0xffb0, "0"],
  [0xffb1, "1"],
  [0xffb2, "2"],
  [0xffb3, "3"],
  [0xffb4, "4"],
  [0xffb5, "5"],
  [0xffb6, "6"],
  [0xffb7, "7"],
  [0xffb8, "8"],
  [0xffb9, "9"],
  [0xffbd, "="],
  [0xffe1, "Shift"],
  [0xffe2, "Shift"],
  [0xffe3, "Control"],
  [0xffe4, "Control"],
  [0xffe5, "CapsLock"],
  [0xffe6, "CapsLock"],
  [0xffe7, "Meta"],
  [0xffe8, "Meta"],
  [0xffe9, "Alt"],
  [0xffea, "Alt"],
  [0xffeb, "Meta"],
  [0xffec, "Meta"],
  [0xffed, "Meta"],
  [0xffee, "Meta"],
  [0xfe03, "AltGraph"],
  [0xfe11, "AltGraph"],
  [0xfe20, "Tab"],
  // Common XF86 multimedia keysyms.
  [0x1008ff02, "BrightnessUp"],
  [0x1008ff03, "BrightnessDown"],
  [0x1008ff11, "AudioVolumeDown"],
  [0x1008ff12, "AudioVolumeMute"],
  [0x1008ff13, "AudioVolumeUp"],
  [0x1008ff14, "MediaPlay"],
  [0x1008ff15, "MediaStop"],
  [0x1008ff16, "MediaTrackPrevious"],
  [0x1008ff17, "MediaTrackNext"],
  [0x1008ff18, "BrowserHome"],
  [0x1008ff19, "LaunchMail"],
  [0x1008ff1b, "BrowserSearch"],
  [0x1008ff26, "BrowserBack"],
  [0x1008ff27, "BrowserForward"],
  [0x1008ff28, "BrowserStop"],
  [0x1008ff29, "BrowserRefresh"],
  [0x1008ff30, "BrowserFavorites"],
  [0x1008ff31, "MediaPause"],
]);

/** Map an xkb keysym and its UTF-8 representation to a DOM-style logical key. */
export function logicalKeyFromKeysym(keysym: number, keysymText = ""): string {
  const named = NAMED_KEYSYMS.get(keysym);
  if (named !== undefined) return named;

  if (keysym >= 0xffbe && keysym <= 0xffe0) return `F${keysym - 0xffbd}`;
  if (isDeadKeysym(keysym)) return "Dead";

  const text = keysymText.length > 0 ? keysymText : unicodeTextFromKeysym(keysym);
  return isPrintableKeyText(text) ? text : "Unidentified";
}

function isDeadKeysym(keysym: number): boolean {
  return (keysym >= 0xfe50 && keysym <= 0xfe6f) ||
    (keysym >= 0xfe80 && keysym <= 0xfe8d) ||
    (keysym >= 0xfe90 && keysym <= 0xfe93);
}

function unicodeTextFromKeysym(keysym: number): string {
  let codePoint: number | undefined;
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) {
    codePoint = keysym;
  } else if ((keysym & 0xff000000) === 0x01000000) {
    codePoint = keysym & 0x00ffffff;
  }

  if (codePoint === undefined || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function isPrintableKeyText(text: string): boolean {
  if (text.length === 0) return false;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

export type PreeditCursorRange = readonly [start: number, end: number];

/**
 * Validate text-input-v3 cursor offsets. They are UTF-8 byte offsets rather
 * than JavaScript UTF-16 indices.
 */
export function validatePreeditCursorRange(
  text: string,
  cursorBegin: number,
  cursorEnd: number,
): PreeditCursorRange | undefined {
  if (cursorBegin < 0 || cursorEnd < 0) return undefined;
  if (!Number.isSafeInteger(cursorBegin) || !Number.isSafeInteger(cursorEnd) || cursorBegin > cursorEnd) {
    return undefined;
  }

  const bytes = UTF8_ENCODER.encode(text);
  if (cursorEnd > bytes.length || !isUtf8Boundary(bytes, cursorBegin) || !isUtf8Boundary(bytes, cursorEnd)) {
    return undefined;
  }
  return [cursorBegin, cursorEnd];
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

export interface CursorRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalize a logical cursor area for Wayland's signed-int wire arguments. */
export function normalizeCursorRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): CursorRectangle | undefined {
  if (![x, y, width, height].every(Number.isFinite)) return undefined;

  // Negative dimensions do not describe an area. Treat them as an empty area
  // at the supplied origin rather than moving an IME popup unexpectedly.
  const right = x + Math.max(0, width);
  const bottom = y + Math.max(0, height);
  const normalizedX = clampInt32(Math.floor(x));
  const normalizedY = clampInt32(Math.floor(y));
  const normalizedRight = clampInt32(Math.ceil(right));
  const normalizedBottom = clampInt32(Math.ceil(bottom));

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

export type TextInputEdit =
  | { type: "preedit"; text: string; cursorRange?: PreeditCursorRange }
  | { type: "deleteSurrounding"; beforeLength: number; afterLength: number }
  | { type: "commit"; text: string };

export interface TextInputDoneResult {
  serial: number;
  serialMatches: boolean;
  edits: TextInputEdit[];
}

interface PendingPreedit {
  text: string;
  cursorRange?: PreeditCursorRange;
}

/**
 * Double-buffered edit state for zwp_text_input_v3. Event callbacks update the
 * pending fields; done() emits one atomically ordered batch and resets them to
 * the protocol's empty initial values.
 */
export class TextInputV3Batch {
  #pendingPreedit: PendingPreedit | undefined;
  #pendingCommit: string | undefined;
  #pendingDelete: { beforeLength: number; afterLength: number } | undefined;
  #visiblePreedit = false;
  #clientCommitSerial = 0;

  get clientCommitSerial(): number {
    return this.#clientCommitSerial;
  }

  get hasVisiblePreedit(): boolean {
    return this.#visiblePreedit;
  }

  /** Record one outgoing zwp_text_input_v3.commit request. */
  recordClientCommit(): number {
    this.#clientCommitSerial = (this.#clientCommitSerial + 1) >>> 0;
    return this.#clientCommitSerial;
  }

  setPreedit(text: string | null, cursorBegin: number, cursorEnd: number): void {
    const resolvedText = text ?? "";
    this.#pendingPreedit = {
      text: resolvedText,
      cursorRange: validatePreeditCursorRange(resolvedText, cursorBegin, cursorEnd),
    };
  }

  setCommit(text: string | null): void {
    this.#pendingCommit = text ?? "";
  }

  setDeleteSurrounding(beforeLength: number, afterLength: number): void {
    this.#pendingDelete = {
      beforeLength: clampUint32(beforeLength),
      afterLength: clampUint32(afterLength),
    };
  }

  /** Apply a compositor batch in the ordering mandated by text-input-v3. */
  done(serial: number): TextInputDoneResult {
    const edits: TextInputEdit[] = [];

    // Blitz finalizes an IME commit by first replacing its preedit selection.
    // Emit that clear even when the compositor committed without previously
    // displaying a preedit, but never emit it twice for the same batch.
    if (this.#visiblePreedit || this.#pendingCommit !== undefined) {
      edits.push({ type: "preedit", text: "" });
    }
    if (
      this.#pendingDelete !== undefined &&
      (this.#pendingDelete.beforeLength !== 0 || this.#pendingDelete.afterLength !== 0)
    ) {
      edits.push({
        type: "deleteSurrounding",
        beforeLength: this.#pendingDelete.beforeLength,
        afterLength: this.#pendingDelete.afterLength,
      });
    }
    if (this.#pendingCommit !== undefined) edits.push({ type: "commit", text: this.#pendingCommit });
    if (this.#pendingPreedit !== undefined && this.#pendingPreedit.text.length > 0) {
      const preedit: TextInputEdit = { type: "preedit", text: this.#pendingPreedit.text };
      if (this.#pendingPreedit.cursorRange !== undefined) {
        preedit.cursorRange = this.#pendingPreedit.cursorRange;
      }
      edits.push(preedit);
    }

    this.#visiblePreedit = (this.#pendingPreedit?.text.length ?? 0) > 0;
    this.#resetPending();

    const normalizedSerial = toUint32(serial);
    return {
      serial: normalizedSerial,
      serialMatches: normalizedSerial === this.#clientCommitSerial,
      edits,
    };
  }

  /** Clear pending and visible preedit state on leave/disable/keymap loss. */
  resetEdits(): TextInputEdit[] {
    const edits: TextInputEdit[] = this.#visiblePreedit ? [{ type: "preedit", text: "" }] : [];
    this.#visiblePreedit = false;
    this.#resetPending();
    return edits;
  }

  #resetPending(): void {
    this.#pendingPreedit = undefined;
    this.#pendingCommit = undefined;
    this.#pendingDelete = undefined;
  }
}

function clampUint32(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(UINT32_MAX, Math.floor(value));
}

function toUint32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value) >>> 0;
}

export type MonotonicNow = () => number;

/** Poll-driven implementation of Wayland's compositor-provided key repeat. */
export class KeyRepeatController {
  readonly #now: MonotonicNow;
  #rate = 0;
  #delay = 0;
  #keycode: number | undefined;
  #nextDeadline: number | undefined;

  constructor(now: MonotonicNow = () => performance.now()) {
    this.#now = now;
  }

  get activeKeycode(): number | undefined {
    return this.#keycode;
  }

  get nextDeadline(): number | undefined {
    return this.#nextDeadline;
  }

  /** Apply wl_keyboard.repeat_info. A non-positive rate disables repeat. */
  setRepeatInfo(rate: number, delay: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      this.#rate = 0;
      this.cancel();
      return;
    }

    this.#rate = rate;
    this.#delay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    if (this.#keycode !== undefined) this.#nextDeadline = this.#now() + this.#delay;
  }

  /** Start or replace repeat for an xkb-repeatable key press. */
  press(rawKeycode: number, repeatable: boolean): void {
    if (!repeatable || this.#rate <= 0) return;
    this.#keycode = rawKeycode;
    this.#nextDeadline = this.#now() + this.#delay;
  }

  /** Cancel only when the released key is the key currently repeating. */
  release(rawKeycode: number): void {
    if (rawKeycode === this.#keycode) this.cancel();
  }

  cancel(): void {
    this.#keycode = undefined;
    this.#nextDeadline = undefined;
  }

  /**
   * Return at most one due raw keycode. Missed intervals are skipped while the
   * next deadline remains aligned to the compositor-provided rate.
   */
  poll(): number | undefined {
    const keycode = this.#keycode;
    const deadline = this.#nextDeadline;
    if (keycode === undefined || deadline === undefined || this.#rate <= 0) return undefined;

    const now = this.#now();
    if (!Number.isFinite(now) || now < deadline) return undefined;

    const interval = 1000 / this.#rate;
    const missedIntervals = Math.floor((now - deadline) / interval);
    const nextDeadline = deadline + (missedIntervals + 1) * interval;
    this.#nextDeadline = Number.isFinite(nextDeadline) && nextDeadline > now ? nextDeadline : now + interval;
    return keycode;
  }
}
