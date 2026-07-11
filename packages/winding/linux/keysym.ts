import { normalizeKeyboardText } from "../input/keyboard.ts";

export type LinuxKeysym = number | bigint;

const NAMED_KEYSYMS = new Map<number, string>([
  [0xff08, "Backspace"],
  [0xff09, "Tab"],
  [0xff0b, "Clear"],
  [0xff0d, "Enter"],
  [0xff13, "Pause"],
  [0xff14, "ScrollLock"],
  [0xff15, "PrintScreen"],
  [0xff1b, "Escape"],
  [0xff20, "Compose"],
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
  [0xffed, "Hyper"],
  [0xffee, "Hyper"],
  [0xfe03, "AltGraph"],
  [0xfe04, "AltGraph"],
  [0xfe05, "AltGraph"],
  [0xfe11, "AltGraph"],
  [0xfe12, "AltGraph"],
  [0xfe13, "AltGraph"],
  [0xfe20, "Tab"],
  [0xfe34, "Enter"],
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

const KEYPAD_PRINTABLE_KEYSYMS = new Set([
  0xff80,
  0xffaa,
  0xffab,
  0xffac,
  0xffad,
  0xffae,
  0xffaf,
  0xffb0,
  0xffb1,
  0xffb2,
  0xffb3,
  0xffb4,
  0xffb5,
  0xffb6,
  0xffb7,
  0xffb8,
  0xffb9,
  0xffbd,
]);

/** Map a Linux/XKB keysym and lookup text to a DOM-style logical key. */
export function logicalKeyFromKeysym(keysym: LinuxKeysym, lookupText = ""): string {
  const value = numericKeysym(keysym);
  if (value === undefined) return "Unidentified";

  if (KEYPAD_PRINTABLE_KEYSYMS.has(value)) {
    const layoutText = normalizeKeyboardText(lookupText);
    if (layoutText !== undefined) return layoutText;
  }
  const named = NAMED_KEYSYMS.get(value);
  if (named !== undefined) return named;
  if (value >= 0xffbe && value <= 0xffe0) return `F${value - 0xffbd}`;
  if (isDeadKeysym(value)) return "Dead";

  return normalizeKeyboardText(lookupText) ??
    normalizeKeyboardText(unicodeTextFromKeysym(value)) ??
    "Unidentified";
}

export function isDeadKeysym(keysym: LinuxKeysym): boolean {
  const value = numericKeysym(keysym);
  return value !== undefined && (
    (value >= 0xfe50 && value <= 0xfe6f) ||
    (value >= 0xfe80 && value <= 0xfe8d) ||
    (value >= 0xfe90 && value <= 0xfe93)
  );
}

/** Resolve the Unicode scalar encoded directly by a Linux/XKB keysym. */
export function unicodeTextFromKeysym(keysym: LinuxKeysym): string {
  const value = numericKeysym(keysym);
  if (value === undefined) return "";

  let codePoint: number | undefined;
  if ((value >= 0x20 && value <= 0x7e) || (value >= 0xa0 && value <= 0xff)) {
    codePoint = value;
  } else if ((value & 0xff000000) === 0x01000000) {
    codePoint = value & 0x00ffffff;
  }

  if (codePoint === undefined || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function numericKeysym(keysym: LinuxKeysym): number | undefined {
  if (typeof keysym === "number") {
    return Number.isSafeInteger(keysym) && keysym >= 0 && keysym <= 0xffffffff ? keysym : undefined;
  }
  return keysym >= 0n && keysym <= 0xffffffffn ? Number(keysym) : undefined;
}
