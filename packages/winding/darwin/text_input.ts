import { normalizeCommittedText } from "../input/mod.ts";

/** Selectors implemented by WindingContentView's commit/command bridge. */
export const REQUIRED_TEXT_INPUT_SELECTORS = [
  "acceptsFirstResponder",
  "keyDown:",
  "keyUp:",
  "flagsChanged:",
  "insertText:replacementRange:",
  "doCommandBySelector:",
] as const;

const NAMED_KEYS_BY_CODE: Readonly<Record<string, string>> = {
  AltLeft: "Alt",
  AltRight: "Alt",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  AudioVolumeDown: "AudioVolumeDown",
  AudioVolumeMute: "AudioVolumeMute",
  AudioVolumeUp: "AudioVolumeUp",
  Backspace: "Backspace",
  CapsLock: "CapsLock",
  ContextMenu: "ContextMenu",
  ControlLeft: "Control",
  ControlRight: "Control",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Escape",
  Home: "Home",
  Insert: "Insert",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  NumLock: "NumLock",
  NumpadEnter: "Enter",
  PageDown: "PageDown",
  PageUp: "PageUp",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Tab: "Tab",
};

export interface NativeLogicalKeyInput {
  code: string;
  /** `NSEvent.characters`, decoded as a complete NSString. `null` when not queried (e.g. FlagsChanged). */
  characters: string | null;
  /** `NSEvent.charactersIgnoringModifiers`, decoded as a complete NSString. `null` when not queried. */
  charactersIgnoringModifiers: string | null;
  /** Text delivered synchronously through insertText:, when available. */
  producedText?: string;
}

/**
 * Resolve a DOM KeyboardEvent.key-style value without assuming a US layout.
 * AppKit's named/function keys are identified from the physical code because
 * `characters` represents them with private-use Unicode scalars.
 */
export function logicalKeyForEvent(input: NativeLogicalKeyInput): string {
  const named = NAMED_KEYS_BY_CODE[input.code];
  if (named !== undefined) return named;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.code)) return input.code;

  const produced = printableText(input.producedText ?? "");
  if (produced !== undefined) return produced;

  const modified = printableText(input.characters ?? "");
  if (modified !== undefined) return modified;

  // A dead key commonly has no `characters`, while
  // `charactersIgnoringModifiers` still names the underlying physical key.
  const unmodified = printableText(input.charactersIgnoringModifiers ?? "");
  if (!input.characters && unmodified !== undefined && isPotentiallyPrintableCode(input.code)) {
    return "Dead";
  }
  if (unmodified !== undefined) return unmodified;

  if (isPotentiallyPrintableCode(input.code)) return "Dead";
  return "Unidentified";
}

/** Return printable text only; control and AppKit private-use key values are not text. */
export function printableText(value: string): string | undefined {
  const normalized = normalizeCommittedText(value);
  if (normalized === undefined) return undefined;
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (scalar >= 0xf700 && scalar <= 0xf8ff) {
      return undefined;
    }
  }
  return normalized;
}

/** Ordinary AppKit text fallback used while native composition is not active. */
export function uninterpretedCommitText(
  characters: string | null,
  ctrlKey: boolean,
  metaKey: boolean,
): string | undefined {
  return ctrlKey || metaKey ? undefined : printableText(characters ?? "");
}

export function isPotentiallyPrintableCode(code: string): boolean {
  return code.startsWith("Key") ||
    code.startsWith("Digit") ||
    code.startsWith("Numpad") ||
    code === "Space" ||
    code === "Minus" ||
    code === "Equal" ||
    code === "BracketLeft" ||
    code === "BracketRight" ||
    code === "Backslash" ||
    code === "Semicolon" ||
    code === "Quote" ||
    code === "Comma" ||
    code === "Period" ||
    code === "Slash" ||
    code === "Backquote" ||
    code === "IntlBackslash" ||
    code === "IntlYen" ||
    code === "IntlRo";
}
