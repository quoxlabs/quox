import type { AppleStandardKeybindingEvent, ImeCursorRange, ImeEvent, KeyDownEvent, Window } from "../types.ts";
import {
  CompositionState,
  createImeActivationEvent,
  createImeCommitEvent,
  createImePreeditEvent,
  discardTrailingPreeditClear,
  ImeActivationState,
  type ImeCursorArea,
  utf16RangeToUtf8Range,
  validateImeCursorArea,
} from "../input/mod.ts";
import { NS_NOT_FOUND } from "./ffi.ts";
import { printableText } from "./text_input.ts";
export { NS_NOT_FOUND } from "./ffi.ts";

export interface Utf16Range {
  location: number | bigint;
  length: number | bigint;
}

export type DarwinTextInputEvent = ImeEvent | AppleStandardKeybindingEvent;
export type DarwinInputEvent = KeyDownEvent | DarwinTextInputEvent;

function clampedUtf16Offset(value: number | bigint, maximum: number): number {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    return value >= BigInt(maximum) ? maximum : Number(value);
  }
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), maximum);
}

/** Convert an AppKit UTF-16 range to exact UTF-8 byte cursor offsets. */
export function utf16RangeToUtf8(
  text: string,
  location: number | bigint,
  length: number | bigint,
): ImeCursorRange | null {
  if (location === NS_NOT_FOUND || location === -1 || location === -1n) return null;
  const rawLocation = typeof location === "bigint" ? Number(location) : location;
  const rawLength = typeof length === "bigint" ? Number(length) : length;
  return utf16RangeToUtf8Range(text, rawLocation, rawLength);
}

interface KeyBatch {
  key: KeyDownEvent;
  following: DarwinTextInputEvent[];
}

/** Pure per-view state used by the AppKit NSTextInputClient callbacks. */
export class DarwinInputState {
  readonly #activation = new ImeActivationState();
  readonly #composition = new CompositionState();
  #markedText = "";
  #markedSelection: Utf16Range | null = null;
  #cursorArea: ImeCursorArea = { x: 0, y: 0, width: 0, height: 0 };
  #modifierFlags = 0n;
  readonly #pressedModifierCodes = new Set<string>();
  #batch: KeyBatch | null = null;
  #pending: DarwinTextInputEvent[] = [];
  #closed = false;

  constructor(readonly window: Window) {
    this.#activation.setAvailable(true);
  }

  get imeEnabled(): boolean {
    return this.#activation.desired;
  }

  get active(): boolean {
    return this.#activation.active;
  }

  get composing(): boolean {
    return this.#composition.active;
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
    const area = validateImeCursorArea(x, y, width, height);
    if (area !== undefined) this.#cursorArea = area;
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
    if (enabled === this.#activation.desired || this.#closed) return;
    if (!enabled) this.cancelComposition();
    this.#activation.setDesired(enabled);
    this.#syncActivation();
  }

  setNativeFocused(focused: boolean): void {
    if (focused === this.#activation.focused || this.#closed) return;
    if (!focused) this.cancelComposition();
    this.#activation.setFocused(focused);
    this.#syncActivation();
  }

  setNativeAvailable(available: boolean): void {
    if (available === this.#activation.available || this.#closed) return;
    if (!available) this.cancelComposition();
    this.#activation.setAvailable(available);
    this.#syncActivation();
  }

  beginKey(key: KeyDownEvent): void {
    if (this.#batch !== null) throw new Error("winding(darwin): nested key input batch");
    this.#batch = { key, following: [] };
  }

  finishKey(): DarwinInputEvent[] {
    const batch = this.#batch;
    if (batch === null) return [];
    this.#batch = null;
    const key: KeyDownEvent = {
      ...batch.key,
      editDisposition: batch.following.length > 0 ? "text-input" : batch.key.editDisposition,
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
    const update = text.length === 0 ? this.#composition.cancel() : this.#composition.update(
      text,
      utf16RangeToUtf8(text, selectionLocation, selectionLength),
    );
    if (update !== undefined) {
      this.#emit(createImePreeditEvent(this.window, update.text, update.cursorRange));
    }
  }

  insertText(text: string): string | undefined {
    const committed = printableText(text);
    if (committed === undefined) return undefined;
    this.#removeTrailingPreeditClear();
    this.#clearMarkedText();
    this.#composition.commit();
    const event = createImeCommitEvent(this.window, committed);
    if (event !== undefined) this.#emit(event);
    return committed;
  }

  performCommand(command: string): void {
    this.#emit({ type: "apple-standard-keybinding", command, window: this.window });
  }

  /** Accept the current marked text, matching NSTextInputClient.unmarkText. */
  unmarkText(): string | undefined {
    if (!this.#composition.active) return undefined;
    if (!this.hasMarkedText) {
      this.#markedSelection = null;
      this.#composition.commit();
      return undefined;
    }
    const text = this.#markedText;
    const committed = printableText(text);
    if (committed === undefined) {
      this.cancelComposition();
      return undefined;
    }
    this.#removeTrailingPreeditClear();
    this.#clearMarkedText();
    this.#composition.commit();
    const event = createImeCommitEvent(this.window, committed);
    if (event !== undefined) this.#emit(event);
    return committed;
  }

  /** Cancel marked text without accepting it (disable, blur, or close). */
  cancelComposition(): void {
    const update = this.#composition.cancel();
    this.#clearMarkedText();
    if (update !== undefined) {
      this.#emit(createImePreeditEvent(this.window, update.text, update.cursorRange));
    }
  }

  drainEvents(): DarwinTextInputEvent[] {
    const events = this.#pending;
    this.#pending = [];
    return events;
  }

  close(): void {
    this.#closed = true;
    this.#batch = null;
    this.#pending = [];
    this.#clearMarkedText();
    this.#composition.reset();
    this.#activation.reset();
  }

  #clearMarkedText(): void {
    this.#markedText = "";
    this.#markedSelection = null;
  }

  #emit(event: DarwinTextInputEvent): void {
    if (this.#closed) return;
    if (this.#batch !== null) this.#batch.following.push(event);
    else this.#pending.push(event);
  }

  #removeTrailingPreeditClear(): void {
    const events = this.#batch?.following ?? this.#pending;
    discardTrailingPreeditClear(events);
  }

  #syncActivation(): void {
    const transition = this.#activation.reconcile({
      activate: () => true,
      deactivate: () => undefined,
    });
    if (transition === undefined) return;
    this.#emit(createImeActivationEvent(this.window, transition));
  }
}
