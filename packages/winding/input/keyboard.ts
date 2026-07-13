import type { KeyLocation } from "../types.ts";

/** Normalize an absent native logical key to the canonical DOM fallback. */
export function normalizeLogicalKey(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "Unidentified" : value;
}

/** Derive the physical location hint carried by a normalized native code. */
function keyLocationForCode(code: string): KeyLocation {
  if (code.startsWith("Numpad")) return 3;
  if (/^(?:Shift|Control|Alt|Meta|OS)Left$/.test(code)) return 1;
  if (/^(?:Shift|Control|Alt|Meta|OS)Right$/.test(code)) return 2;
  return 0;
}

const SIDED_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const NUMPAD_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  ".",
  "Enter",
  "+",
  "-",
  "*",
  "/",
]);

/**
 * Derive a DOM KeyboardEvent.location from the effective key and a physical hint.
 * UI Events permits non-standard locations only for keys with an equivalent in
 * another keyboard section, so remapping can invalidate a code-derived hint.
 * An inverse-remapped modifier on a standard code needs a reliable backend hint;
 * without one, the standard location is the only best-effort fallback available.
 */
export function keyLocationForKey(
  key: string,
  code: string,
  nativeHint: KeyLocation = keyLocationForCode(code),
): KeyLocation {
  if (SIDED_KEYS.has(key)) return nativeHint === 1 || nativeHint === 2 ? nativeHint : 0;
  if (NUMPAD_KEYS.has(key)) return nativeHint === 3 ? 3 : 0;
  return 0;
}

/**
 * Return non-empty text derived from an ordinary keyboard lookup while rejecting
 * shortcut/control results. Native IME commits do not pass through this filter.
 */
export function normalizeKeyboardText(text: string): string | undefined {
  if (text.length === 0) return undefined;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return undefined;
  }
  return text;
}
