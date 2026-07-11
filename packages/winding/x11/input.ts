import type { KeyEditDisposition, KeyModifiers } from "../types.ts";
import { normalizeKeyboardText } from "../input/mod.ts";
import { NotifyInferior, NotifyNormal, NotifyWhileGrabbed, XEventType } from "./ffi.ts";

export interface X11ModifierMapping {
  readonly shiftMask: number;
  readonly controlMask: number;
  readonly altMask: number;
  readonly metaMask: number;
  readonly capsLockMask: number;
  readonly altGraphMask: number;
  readonly maskByKeycode: ReadonlyMap<number, number>;
  readonly toggleKeycodes: ReadonlySet<number>;
}

/** Convert XKeyEvent's pre-transition state to a DOM-style current snapshot. */
export function x11ModifierSnapshot(
  state: number,
  keycode: number,
  pressed: boolean,
  mapping: X11ModifierMapping,
): KeyModifiers {
  const ownMask = mapping.maskByKeycode.get(keycode) ?? 0;
  if (mapping.toggleKeycodes.has(keycode)) {
    if (pressed) state ^= ownMask;
  } else if (pressed) {
    state |= ownMask;
  } else {
    state &= ~ownMask;
  }
  const ctrlKey = (state & mapping.controlMask) !== 0;
  const altGraphKey = (state & mapping.altGraphMask) !== 0;
  return {
    shiftKey: (state & mapping.shiftMask) !== 0,
    ctrlKey,
    altKey: (state & mapping.altMask) !== 0,
    metaKey: (state & mapping.metaMask) !== 0,
    accelKey: ctrlKey && !altGraphKey,
    capsLock: (state & mapping.capsLockMask) !== 0,
    altGraphKey,
  };
}

/** Decode XLookupString output without turning a control byte back into printable keysym text. */
export function fallbackLookupText(bytes: Uint8Array, keysymText: string): string | undefined {
  if (bytes.length > 0) {
    try {
      return normalizeKeyboardText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      // XLookupString can return legacy single-byte text. The keysym is a more
      // reliable Unicode source for that case.
    }
  }
  return normalizeKeyboardText(keysymText);
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
  const timestamp = release.getBigUint64(56, true);
  return press.getInt32(0, true) === XEventType.KeyPress &&
    timestamp !== 0n &&
    press.getBigUint64(32, true) === release.getBigUint64(32, true) &&
    press.getBigUint64(56, true) === timestamp &&
    press.getUint32(84, true) === release.getUint32(84, true);
}

/** Whether an X focus event changes focus for the top-level window as a whole. */
export function isTopLevelFocusTransition(mode: number, detail: number): boolean {
  return (mode === NotifyNormal || mode === NotifyWhileGrabbed) && detail !== NotifyInferior;
}
