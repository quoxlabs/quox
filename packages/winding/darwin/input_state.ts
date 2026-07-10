import type { AppleStandardKeybindingEvent, ImeEvent, ImeSelection, KeyEvent, Window } from "../types.ts";
import { NS_NOT_FOUND } from "./ffi.ts";
export { NS_NOT_FOUND } from "./ffi.ts";

export interface Utf16Range {
  location: number | bigint;
  length: number | bigint;
}

export interface ImeCursorArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DarwinTextInputEvent = ImeEvent | AppleStandardKeybindingEvent;
export type DarwinInputEvent = KeyEvent | DarwinTextInputEvent;

function clampedUtf16Offset(value: number | bigint, maximum: number): number {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    return value >= BigInt(maximum) ? maximum : Number(value);
  }
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), maximum);
}

function precedingCodePointBoundary(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  const splitsSurrogatePair = previous >= 0xd800 && previous <= 0xdbff &&
    current >= 0xdc00 && current <= 0xdfff;
  return splitsSurrogatePair ? offset - 1 : offset;
}

/** Convert and clamp an AppKit UTF-16 offset to a UTF-8 byte offset. */
export function utf16OffsetToUtf8(text: string, offset: number | bigint): number {
  const utf16Offset = precedingCodePointBoundary(
    text,
    clampedUtf16Offset(offset, text.length),
  );
  return new TextEncoder().encode(text.slice(0, utf16Offset)).byteLength;
}

/** Convert an AppKit UTF-16 range to a clamped UTF-8 byte selection. */
export function utf16RangeToUtf8(
  text: string,
  location: number | bigint,
  length: number | bigint,
): ImeSelection | null {
  if (location === NS_NOT_FOUND || location === -1 || location === -1n) return null;

  const start16 = clampedUtf16Offset(location, text.length);
  const remaining = text.length - start16;
  const length16 = clampedUtf16Offset(length, remaining);
  return {
    start: utf16OffsetToUtf8(text, start16),
    end: utf16OffsetToUtf8(text, start16 + length16),
  };
}

interface KeyBatch {
  key: KeyEvent;
  wasComposing: boolean;
  following: DarwinTextInputEvent[];
}

/** Pure per-view state used by the AppKit NSTextInputClient callbacks. */
export class DarwinInputState {
  #imeEnabled = false;
  #markedText = "";
  #markedSelection: Utf16Range | null = null;
  #cursorArea: ImeCursorArea = { x: 0, y: 0, width: 0, height: 0 };
  #modifierFlags = 0n;
  readonly #pressedModifierCodes = new Set<string>();
  #batch: KeyBatch | null = null;
  #pending: DarwinTextInputEvent[] = [];

  constructor(readonly window?: Window) {}

  get imeEnabled(): boolean {
    return this.#imeEnabled;
  }

  get markedText(): string {
    return this.#markedText;
  }

  get hasMarkedText(): boolean {
    return this.#markedText.length !== 0;
  }

  get markedSelection(): Utf16Range | null {
    return this.#markedSelection === null ? null : { ...this.#markedSelection };
  }

  get markedRange(): Utf16Range {
    return this.hasMarkedText
      ? { location: 0n, length: BigInt(this.#markedText.length) }
      : { location: NS_NOT_FOUND, length: 0n };
  }

  get selectedRange(): Utf16Range {
    return { location: NS_NOT_FOUND, length: 0n };
  }

  get cursorArea(): Readonly<ImeCursorArea> {
    return this.#cursorArea;
  }

  setCursorArea(x: number, y: number, width: number, height: number): void {
    if (![x, y, width, height].every(Number.isFinite)) return;
    this.#cursorArea = { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  }

  get modifierFlags(): bigint {
    return this.#modifierFlags;
  }

  /** Reconcile an AppKit aggregate modifier mask with a keycode-specific transition. */
  modifierTransition(
    code: string,
    flags: bigint,
    aggregateFlag: bigint | undefined,
  ): "keydown" | "keyup" {
    const previous = this.#modifierFlags;
    this.#modifierFlags = flags;
    const wasGroupActive = aggregateFlag !== undefined && (previous & aggregateFlag) !== 0n;
    const isGroupActive = aggregateFlag !== undefined && (flags & aggregateFlag) !== 0n;
    // Aggregate flags identify an unambiguous first press or final release.
    // If both sides are held, the aggregate flag stays set and the physical
    // keycode set identifies the intervening transition.
    const isPressed = aggregateFlag === undefined
      ? !this.#pressedModifierCodes.has(code)
      : isGroupActive !== wasGroupActive
      ? isGroupActive
      : isGroupActive && !this.#pressedModifierCodes.has(code);
    if (isPressed) this.#pressedModifierCodes.add(code);
    else this.#pressedModifierCodes.delete(code);
    return isPressed ? "keydown" : "keyup";
  }

  resetModifiers(): void {
    this.#modifierFlags = 0n;
    this.#pressedModifierCodes.clear();
  }

  setImeEnabled(enabled: boolean): void {
    if (enabled === this.#imeEnabled) return;
    if (!enabled) this.cancelComposition();
    this.#imeEnabled = enabled;
    this.#emit({ type: "ime", kind: enabled ? "enabled" : "disabled" });
  }

  beginKey(key: KeyEvent): void {
    if (this.#batch !== null) throw new Error("winding(darwin): nested key input batch");
    this.#batch = { key, wasComposing: this.hasMarkedText, following: [] };
  }

  finishKey(): DarwinInputEvent[] {
    const batch = this.#batch;
    if (batch === null) return [];
    this.#batch = null;
    const key: KeyEvent = {
      ...batch.key,
      window: batch.key.window ?? this.window,
      isComposing: batch.key.isComposing === true || batch.wasComposing || this.hasMarkedText,
      textInputHandled: batch.following.length !== 0,
    };
    return [key, ...batch.following];
  }

  setMarkedText(text: string, selectionLocation: number | bigint, selectionLength: number | bigint): void {
    this.#markedText = text;
    const location = clampedUtf16Offset(selectionLocation, text.length);
    this.#markedSelection = text.length === 0 ||
        selectionLocation === NS_NOT_FOUND || selectionLocation === -1 || selectionLocation === -1n
      ? null
      : {
        location,
        length: clampedUtf16Offset(selectionLength, text.length - location),
      };
    this.#emit({
      type: "ime",
      kind: "preedit",
      text,
      selection: utf16RangeToUtf8(text, selectionLocation, selectionLength),
    });
  }

  insertText(text: string): void {
    this.#clearMarkedText();
    this.#emit({ type: "ime", kind: "preedit", text: "", selection: null });
    this.#emit({ type: "ime", kind: "commit", text });
  }

  performCommand(command: string): void {
    this.#emit({ type: "apple-standard-keybinding", command });
  }

  /** Accept the current marked text, matching NSTextInputClient.unmarkText. */
  unmarkText(): void {
    if (!this.hasMarkedText) return;
    const text = this.#markedText;
    this.#clearMarkedText();
    this.#emit({ type: "ime", kind: "preedit", text: "", selection: null });
    this.#emit({ type: "ime", kind: "commit", text });
  }

  /** Cancel marked text without accepting it (disable, blur, or close). */
  cancelComposition(): void {
    if (!this.hasMarkedText) {
      this.#markedSelection = null;
      return;
    }
    this.#clearMarkedText();
    this.#emit({ type: "ime", kind: "preedit", text: "", selection: null });
  }

  drainEvents(): DarwinTextInputEvent[] {
    const events = this.#pending;
    this.#pending = [];
    return events;
  }

  #clearMarkedText(): void {
    this.#markedText = "";
    this.#markedSelection = null;
  }

  #emit(event: DarwinTextInputEvent): void {
    const withWindow = event.window !== undefined || this.window === undefined
      ? event
      : { ...event, window: this.window };
    if (this.#batch !== null) this.#batch.following.push(withWindow);
    else this.#pending.push(withWindow);
  }
}
