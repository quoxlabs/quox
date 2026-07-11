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

/**
 * Maps a native monotonic millisecond clock to DOMHighResTimeStamp values.
 * A finite `wrapAt` unwraps 32-bit protocol clocks across their rollover.
 */
export class NativeEventClock {
  #nativeOrigin: number | undefined;
  #runtimeOrigin = 0;
  #lastRaw: number | undefined;
  #epoch = 0;

  constructor(
    readonly wrapAt = Number.POSITIVE_INFINITY,
    readonly now: () => number = () => performance.now(),
  ) {
    if (!(wrapAt > 0)) throw new RangeError("native event clock wrap must be positive");
  }

  timeStamp(rawMilliseconds: number): number {
    if (!Number.isFinite(rawMilliseconds)) return this.now();
    let raw = rawMilliseconds;
    if (Number.isFinite(this.wrapAt)) {
      raw = ((raw % this.wrapAt) + this.wrapAt) % this.wrapAt;
      if (
        this.#lastRaw !== undefined && raw < this.#lastRaw &&
        this.#lastRaw - raw > this.wrapAt / 2
      ) {
        this.#epoch += this.wrapAt;
      }
      this.#lastRaw = raw;
    }
    const unwrapped = raw + this.#epoch;
    if (this.#nativeOrigin === undefined) {
      this.#nativeOrigin = unwrapped;
      this.#runtimeOrigin = this.now();
    }
    return this.#runtimeOrigin + unwrapped - this.#nativeOrigin;
  }
}

/** Browser-style consecutive click counts for protocols without native metadata. */
export class ClickCounter<Button> {
  #lastPress:
    | { button: Button; timeStamp: number; x: number; y: number; detail: number }
    | undefined;
  readonly #active = new Map<Button, number>();

  constructor(readonly intervalMilliseconds = 500, readonly distance = 4) {}

  detail(
    button: Button,
    pressed: boolean,
    timeStamp: number,
    x: number,
    y: number,
  ): number {
    if (!pressed) {
      const detail = this.#active.get(button) ?? 0;
      this.#active.delete(button);
      return detail;
    }
    const previous = this.#lastPress;
    const consecutive = previous !== undefined && Object.is(previous.button, button) &&
      timeStamp >= previous.timeStamp &&
      timeStamp - previous.timeStamp <= this.intervalMilliseconds &&
      Math.abs(x - previous.x) <= this.distance &&
      Math.abs(y - previous.y) <= this.distance;
    const detail = consecutive ? previous.detail + 1 : 1;
    this.#lastPress = { button, timeStamp, x, y, detail };
    this.#active.set(button, detail);
    return detail;
  }
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
