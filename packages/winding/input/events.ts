import type {
  ImeCursorRange,
  ImeEvent,
  KeyDownEvent,
  KeyEditDisposition,
  KeyLocation,
  KeyModifiers,
  KeyUpEvent,
  Window,
} from "../types.ts";
import { validateImeCursorRange } from "./ime.ts";
import { keyLocationForCode, normalizeLogicalKey } from "./keyboard.ts";

export interface KeyEventInit extends KeyModifiers {
  window: Window;
  keycode: number;
  code?: string;
  key?: string;
  location?: KeyLocation;
  isComposing: boolean;
}

export interface KeyDownEventInit extends KeyEventInit {
  repeat: boolean;
  editDisposition: KeyEditDisposition;
}

/** Build a fully normalized public keydown event. */
export function createKeyDownEvent(init: KeyDownEventInit): KeyDownEvent {
  const code = normalizeLogicalKey(init.code);
  return {
    type: "keydown",
    window: init.window,
    keycode: init.keycode,
    code,
    key: normalizeLogicalKey(init.key),
    location: init.location ?? keyLocationForCode(code),
    isComposing: init.isComposing,
    repeat: init.repeat,
    editDisposition: init.editDisposition,
    ...modifiers(init),
  };
}

/** Build a fully normalized public keyup event. */
export function createKeyUpEvent(init: KeyEventInit): KeyUpEvent {
  const code = normalizeLogicalKey(init.code);
  return {
    type: "keyup",
    window: init.window,
    keycode: init.keycode,
    code,
    key: normalizeLogicalKey(init.key),
    location: init.location ?? keyLocationForCode(code),
    isComposing: init.isComposing,
    repeat: false,
    ...modifiers(init),
  };
}

export function createImeActivationEvent(
  window: Window,
  kind: "enabled" | "disabled",
): ImeEvent {
  return { type: "ime", kind, window };
}

export function createImePreeditEvent(
  window: Window,
  text: string,
  cursorRange: ImeCursorRange | null,
): ImeEvent {
  return {
    type: "ime",
    kind: "preedit",
    window,
    text,
    cursorRange: text.length === 0 || cursorRange === null
      ? null
      : validateImeCursorRange(text, cursorRange[0], cursorRange[1]),
  };
}

/** Empty commits carry no semantic edit and are omitted. */
export function createImeCommitEvent(window: Window, text: string): ImeEvent | undefined {
  return text.length === 0 ? undefined : { type: "ime", kind: "commit", window, text };
}

/** Invalid or empty surrounding deletions are omitted. */
export function createImeDeleteSurroundingEvent(
  window: Window,
  beforeBytes: number,
  afterBytes: number,
): ImeEvent | undefined {
  if (
    !Number.isSafeInteger(beforeBytes) || beforeBytes < 0 ||
    !Number.isSafeInteger(afterBytes) || afterBytes < 0 ||
    (beforeBytes === 0 && afterBytes === 0)
  ) {
    return undefined;
  }
  return { type: "ime", kind: "deleteSurrounding", window, beforeBytes, afterBytes };
}

/** Build an atomic absolute replacement against an application-owned text snapshot. */
export function createImeReplaceEvent(
  window: Window,
  surroundingText: string,
  startBytes: number,
  endBytes: number,
  text: string,
): ImeEvent | undefined {
  const range = validateImeCursorRange(surroundingText, startBytes, endBytes);
  if (range === null) return undefined;
  return {
    type: "ime",
    kind: "replace",
    window,
    startBytes: range[0],
    endBytes: range[1],
    text,
  };
}

function modifiers(value: KeyModifiers): KeyModifiers {
  return {
    shiftKey: value.shiftKey,
    ctrlKey: value.ctrlKey,
    altKey: value.altKey,
    metaKey: value.metaKey,
    accelKey: value.accelKey,
    capsLock: value.capsLock,
    altGraphKey: value.altGraphKey,
  };
}
