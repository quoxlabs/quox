import type {
  KeyDownEvent,
  KeyEditDisposition,
  KeyLocation,
  KeyModifiers,
  KeyUpEvent,
  TextInputEvent,
  Window,
} from "../types.ts";
import { keyLocationForCode, normalizeCommittedText, normalizeLogicalKey } from "./keyboard.ts";

export interface KeyEventInit extends KeyModifiers {
  window: Window;
  keycode: number;
  code?: string;
  key?: string;
  location?: KeyLocation;
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
    repeat: false,
    ...modifiers(init),
  };
}

/** Empty or control-only commits carry no semantic edit and are omitted. */
export function createTextInputEvent(window: Window, text: string): TextInputEvent | undefined {
  const committed = normalizeCommittedText(text);
  return committed === undefined ? undefined : { type: "textinput", window, text: committed };
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
