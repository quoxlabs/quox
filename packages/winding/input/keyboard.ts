import type { KeyLocation } from "../types.ts";

/** Normalize an absent native logical key to the canonical DOM fallback. */
export function normalizeLogicalKey(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "Unidentified" : value;
}

/** Derive DOM KeyboardEvent.location from an already-normalized physical code. */
export function keyLocationForCode(code: string): KeyLocation {
  if (code.startsWith("Numpad")) return 3;
  if (/^(?:Shift|Control|Alt|Meta|OS)Left$/.test(code)) return 1;
  if (/^(?:Shift|Control|Alt|Meta|OS)Right$/.test(code)) return 2;
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
