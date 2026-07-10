import type { KeyLocation } from "../types.ts";
import { OBJC_BOOL_ENCODING } from "./ffi.ts";

/** Selectors implemented by WindingContentView's NSTextInputClient bridge. */
export const REQUIRED_TEXT_INPUT_SELECTORS = [
  "acceptsFirstResponder",
  "keyDown:",
  "keyUp:",
  "flagsChanged:",
  "insertText:replacementRange:",
  "setMarkedText:selectedRange:replacementRange:",
  "unmarkText",
  "hasMarkedText",
  "markedRange",
  "selectedRange",
  "validAttributesForMarkedText",
  "attributedSubstringForProposedRange:actualRange:",
  "characterIndexForPoint:",
  "firstRectForCharacterRange:actualRange:",
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
  /** `NSEvent.characters`, decoded as a complete NSString. */
  characters: string;
  /** `NSEvent.charactersIgnoringModifiers`, decoded as a complete NSString. */
  charactersIgnoringModifiers: string;
  /** Text delivered synchronously through insertText:, when available. */
  producedText?: string;
  /** Whether interpretKeyEvents: produced marked text for this key. */
  producedPreedit?: boolean;
}

/** DOM KeyboardEvent.location-compatible location derived from the physical code. */
export function keyLocationForCode(code: string): KeyLocation {
  if (code.endsWith("Left")) return 1;
  if (code.endsWith("Right")) return 2;
  if (code.startsWith("Numpad")) return 3;
  return 0;
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

  const modified = printableText(input.characters);
  if (modified !== undefined) return modified;

  // A dead key commonly has no `characters`, while
  // `charactersIgnoringModifiers` still names the underlying physical key.
  // Prefer AppKit's actual marked-text signal in that case. Ordinary IME
  // preedit keystrokes still keep their layout-aware `characters` above.
  if (input.producedPreedit) return "Dead";

  const unmodified = printableText(input.charactersIgnoringModifiers);
  if (input.characters.length === 0 && unmodified !== undefined && isPotentiallyPrintableCode(input.code)) {
    return "Dead";
  }
  if (unmodified !== undefined) return unmodified;

  if (isPotentiallyPrintableCode(input.code)) return "Dead";
  return "Unidentified";
}

/** Return printable text only; control and AppKit private-use key values are not text. */
export function printableText(value: string): string | undefined {
  if (value.length === 0) return undefined;
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (scalar < 0x20 || (scalar >= 0x7f && scalar <= 0x9f) || (scalar >= 0xf700 && scalar <= 0xf8ff)) {
      return undefined;
    }
  }
  return value;
}

function isPotentiallyPrintableCode(code: string): boolean {
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

export interface ClientRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert top-left client coordinates into an unflipped NSView's local coordinates. */
export function cocoaRectFromClient(rect: ClientRect, viewHeight: number): ClientRect {
  const width = Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0;
  const height = Number.isFinite(rect.height) ? Math.max(0, rect.height) : 0;
  const x = Number.isFinite(rect.x) ? rect.x : 0;
  const y = Number.isFinite(rect.y) ? rect.y : 0;
  return {
    x,
    y: viewHeight - y - height,
    width,
    height,
  };
}

export const __testing = {
  requiredSelectors: REQUIRED_TEXT_INPUT_SELECTORS,
  boolEncoding: OBJC_BOOL_ENCODING,
  keyLocationForCode,
  logicalKeyForEvent,
  printableText,
  cocoaRectFromClient,
};
