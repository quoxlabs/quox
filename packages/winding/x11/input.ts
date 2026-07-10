import type { KeyEditDisposition, KeyModifiers } from "../types.ts";
import { normalizeCommittedText } from "../input/mod.ts";
import { XEventType } from "./ffi.ts";

/** Decode XLookupString output without turning a control byte back into printable keysym text. */
export function fallbackLookupText(bytes: Uint8Array, keysymText: string): string | undefined {
  if (bytes.length > 0) {
    try {
      return normalizeCommittedText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      // XLookupString can return legacy single-byte text. The keysym is a more
      // reliable Unicode source for that case.
    }
  }
  return normalizeCommittedText(keysymText);
}

/** Decide whether XIM owns the edit associated with an unfiltered key press. */
export function x11KeyEditDisposition(
  key: string,
  hasCommittedText: boolean,
  wasComposing: boolean,
  isComposing: boolean,
  hasSemanticEvents: boolean,
): KeyEditDisposition {
  return key === "Dead" || hasCommittedText || wasComposing || isComposing || hasSemanticEvents
    ? "text-input"
    : "key-default";
}

/** Keep shortcut lookups from becoming edits unless AltGraph or composition owns them. */
export function x11CommittedText(
  text: string | undefined,
  modifiers: KeyModifiers,
  wasComposing: boolean,
  isComposing: boolean,
  hasSemanticEvents: boolean,
): string | undefined {
  if (text === undefined || modifiers.altGraphKey || wasComposing || isComposing || hasSemanticEvents) return text;
  return modifiers.altKey || modifiers.metaKey || modifiers.accelKey ? undefined : text;
}

/** Core X11 represents auto-repeat as a release immediately followed by a matching press. */
export function isAutoRepeatPair(
  release: DataView<ArrayBuffer>,
  press: DataView<ArrayBuffer>,
): boolean {
  return press.getInt32(0, true) === XEventType.KeyPress &&
    press.getBigUint64(32, true) === release.getBigUint64(32, true) &&
    press.getBigUint64(56, true) === release.getBigUint64(56, true) &&
    press.getUint32(84, true) === release.getUint32(84, true);
}
