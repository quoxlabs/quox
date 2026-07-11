import { normalizeKeyboardText } from "../input/mod.ts";

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
  Fn: "Fn",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  NumLock: "Clear",
  NumpadEnter: "Enter",
  PageDown: "PageDown",
  PageUp: "PageUp",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Tab: "Tab",
};

const NAMED_KEYS_BY_KEYCODE: Readonly<Record<number, string>> = {
  0x3f: "Fn",
  0x47: "Clear",
  0x66: "Eisu",
  0x68: "KanjiMode",
  0x72: "Help",
};
const DOM_KEY_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface NativeLogicalKeyInput {
  /** AppKit hardware keyCode, used for macOS-specific named keys. */
  keycode?: number;
  code: string;
  /** `NSEvent.characters`, decoded as a complete NSString. */
  characters: string;
  /** `charactersByApplyingModifiers:` with only Shift/CapsLock/Option glyph modifiers. */
  charactersIgnoringModifiers: string;
  /** Text delivered synchronously through insertText:, when available. */
  producedText?: string;
  /** Whether interpretKeyEvents: produced marked text for this key. */
  producedPreedit?: boolean;
  /** Native layout evidence that this transition started a dead-key sequence. */
  deadKey?: boolean;
}

/**
 * Resolve a DOM KeyboardEvent.key-style value without assuming a US layout.
 * AppKit's named/function keys are identified from the physical code because
 * `characters` represents them with private-use Unicode scalars.
 */
export function logicalKeyForEvent(input: NativeLogicalKeyInput): string {
  const keycodeNamed = input.keycode === undefined ? undefined : NAMED_KEYS_BY_KEYCODE[input.keycode];
  if (keycodeNamed !== undefined) return keycodeNamed;
  const named = NAMED_KEYS_BY_CODE[input.code];
  if (named !== undefined) return named;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.code)) return input.code;
  if (input.deadKey) return "Dead";

  const produced = domKeyText(input.producedText ?? "");
  if (produced !== undefined) return produced;

  const modified = domKeyText(input.characters);
  if (modified !== undefined) return modified;

  // A dead key commonly has no `characters`, while
  // `charactersIgnoringModifiers` still names the underlying physical key.
  // Prefer AppKit's actual marked-text signal in that case. Ordinary IME
  // preedit keystrokes still keep their layout-aware `characters` above.
  if (input.producedPreedit) return "Dead";

  const unmodified = domKeyText(input.charactersIgnoringModifiers);
  if (input.characters.length === 0 && unmodified !== undefined && isPotentiallyPrintableCode(input.code)) {
    return "Dead";
  }
  if (unmodified !== undefined) return unmodified;

  if (isPotentiallyPrintableCode(input.code)) return "Dead";
  return "Unidentified";
}

/** Normalize an NSEvent key string to the final valid DOM key cluster. */
export function domKeyText(value: string): string | undefined {
  const normalized = value.normalize("NFC");
  if (normalized.length === 0) return undefined;
  for (const character of normalized) {
    const scalar = character.codePointAt(0)!;
    if (scalar < 0x20 || (scalar >= 0x7f && scalar <= 0x9f) || (scalar >= 0xf700 && scalar <= 0xf8ff)) {
      return undefined;
    }
  }

  // Invalid dead-key recovery can contain multiple base characters. UI Events
  // uses the final generated key value, including any following combining marks.
  const clusters = [...DOM_KEY_SEGMENTER.segment(normalized)];
  return clusters.at(-1)?.segment;
}

/** Return printable text only; control and AppKit private-use key values are not text. */
export function printableText(value: string): string | undefined {
  const normalized = normalizeKeyboardText(value);
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
  characters: string,
  ctrlKey: boolean,
  metaKey: boolean,
): string | undefined {
  return ctrlKey || metaKey ? undefined : printableText(characters);
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
