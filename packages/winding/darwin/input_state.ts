import type { AppleStandardKeybindingEvent, ImeCursorRange, ImeEvent, KeyDownEvent, Window } from "../types.ts";
import {
  CompositionState,
  createImeActivationEvent,
  createImeCommitEvent,
  createImePreeditEvent,
  createImeReplaceEvent,
  discardTrailingPreeditClear,
  ImeActivationState,
  type ImeCursorArea,
  utf16RangeToUtf8Range,
  utf8OffsetToUtf16Index,
  validateImeCursorArea,
} from "../input/mod.ts";
import { NS_NOT_FOUND } from "./ffi.ts";
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
  sourceClaimed: boolean;
  sawCompositionCallback: boolean;
}

interface SurroundingText {
  text: string;
  selectionStartBytes: number;
  selectionEndBytes: number;
  selectionStartUtf16: number;
  selectionEndUtf16: number;
}

/** Pure per-view state used by the AppKit NSTextInputClient callbacks. */
export class DarwinInputState {
  readonly #activation = new ImeActivationState();
  readonly #composition = new CompositionState();
  #markedText = "";
  #markedSelection: Utf16Range | null = null;
  #markedDocumentStartUtf16 = 0;
  #markedDocumentEndUtf16 = 0;
  #surrounding: SurroundingText | null = null;
  #cursorArea: ImeCursorArea = { x: 0, y: 0, width: 0, height: 0 };
  #modifierFlags = 0n;
  readonly #pressedModifierCodes = new Set<string>();
  #batch: KeyBatch | null = null;
  #pending: DarwinTextInputEvent[] = [];
  #closed = false;

  constructor(readonly window: Window) {
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
      ? {
        location: BigInt(this.#markedDocumentStartUtf16),
        length: BigInt(this.#markedText.length),
      }
      : { location: NS_NOT_FOUND, length: 0n };
  }

  get selectedRange(): Utf16Range {
    if (this.hasMarkedText && this.#markedSelection !== null) {
      return {
        location: BigInt(this.#markedDocumentStartUtf16 + Number(this.#markedSelection.location)),
        length: BigInt(this.#markedSelection.length),
      };
    }
    const surrounding = this.#surrounding;
    return surrounding === null ? { location: NS_NOT_FOUND, length: 0n } : {
      location: BigInt(surrounding.selectionStartUtf16),
      length: BigInt(surrounding.selectionEndUtf16 - surrounding.selectionStartUtf16),
    };
  }

  /** Application text with the active marked string overlaid at its document range. */
  get documentText(): string {
    const surrounding = this.#surrounding;
    if (surrounding === null) return this.#markedText;
    if (!this.hasMarkedText) return surrounding.text;
    return surrounding.text.slice(0, this.#markedDocumentStartUtf16) +
      this.#markedText +
      surrounding.text.slice(this.#markedDocumentEndUtf16);
  }

  substringForRange(location: number | bigint, length: number | bigint): {
    text: string;
    actualRange: Utf16Range;
  } | null {
    const range = validUtf16Range(this.documentText, location, length);
    if (range === null) return null;
    return {
      text: this.documentText.slice(range.start, range.end),
      actualRange: { location: BigInt(range.start), length: BigInt(range.end - range.start) },
    };
  }

  actualCaretRange(location: number | bigint, length: number | bigint): Utf16Range | null {
    const range = validUtf16Range(this.documentText, location, length);
    if (range === null || range.start !== range.end) return null;
    const selection = this.selectedRange;
    if (selection.location === NS_NOT_FOUND) return null;
    const selectedCaret = Number(selection.location) + Number(selection.length);
    if (range.start !== selectedCaret) return null;
    return { location: BigInt(range.start), length: 0n };
  }

  get cursorArea(): Readonly<ImeCursorArea> {
    return this.#cursorArea;
  }

  setCursorArea(x: number, y: number, width: number, height: number): void {
    const area = validateImeCursorArea(x, y, width, height);
    if (area !== undefined) this.#cursorArea = area;
  }

  setSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    const selectionStartUtf16 = utf8OffsetToUtf16Index(text, selectionStartBytes);
    const selectionEndUtf16 = utf8OffsetToUtf16Index(text, selectionEndBytes);
    if (
      selectionStartUtf16 === undefined || selectionEndUtf16 === undefined ||
      selectionStartBytes > selectionEndBytes
    ) {
      throw new RangeError("winding(darwin): IME surrounding selection must be ordered UTF-8 boundaries");
    }
    this.#surrounding = {
      text,
      selectionStartBytes,
      selectionEndBytes,
      selectionStartUtf16,
      selectionEndUtf16,
    };
    if (this.hasMarkedText) {
      // The application republishes surrounding text with its rendered preedit removed and a
      // caret in the preedit's place. Rebase the retained AppKit overlay to that caret; keeping
      // the selection which the mark originally replaced would consume the same range twice and
      // could drop committed text following the mark.
      this.#markedDocumentStartUtf16 = selectionStartUtf16;
      this.#markedDocumentEndUtf16 = selectionEndUtf16;
    }
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
  }

  setNativeFocused(focused: boolean): void {
    if (focused === this.#activation.focused || this.#closed) return;
    if (!focused) this.cancelComposition();
    this.#activation.setFocused(focused);
  }

  setNativeAvailable(available: boolean): void {
    if (available === this.#activation.available || this.#closed) return;
    if (!available) this.cancelComposition();
    this.#activation.setAvailable(available);
  }

  /** Record the system-managed NSTextInputContext/client relationship. */
  observeNativeActive(active: boolean): void {
    if (this.#closed) return;
    const transition = this.#activation.markActive(active);
    if (transition !== undefined) this.#emit(createImeActivationEvent(this.window, transition));
  }

  beginKey(key: KeyDownEvent): void {
    if (this.#batch !== null) throw new Error("winding(darwin): nested key input batch");
    this.#batch = {
      key,
      following: [],
      sourceClaimed: false,
      sawCompositionCallback: false,
    };
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

  setMarkedText(
    insertedText: string,
    selectionLocation: number | bigint,
    selectionLength: number | bigint,
    replacementLocation: number | bigint = NS_NOT_FOUND,
    replacementLength: number | bigint = 0,
  ): void {
    if (this.#batch !== null) this.#batch.sawCompositionCallback = true;
    const hadMarkedText = this.hasMarkedText;
    const hasConcreteReplacement = !(
      replacementLocation === NS_NOT_FOUND || replacementLocation === -1 || replacementLocation === -1n
    );
    // With no existing mark, AppKit's replacement is document-wide. Delete
    // that exact application-owned range first; the following preedit then
    // starts at the replacement insertion point. Once a mark exists, the same
    // argument is relative to the existing marked string instead.
    if (!hadMarkedText) {
      const surrounding = this.#surrounding;
      if (hasConcreteReplacement) {
        const range = validUtf16Range(surrounding?.text ?? "", replacementLocation, replacementLength);
        if (range === null) {
          throw new RangeError("winding(darwin): marked replacementRange is outside surrounding text");
        }
        this.#markedDocumentStartUtf16 = range.start;
        this.#markedDocumentEndUtf16 = range.start;
      } else if (surrounding !== null) {
        this.#markedDocumentStartUtf16 = surrounding.selectionStartUtf16;
        this.#markedDocumentEndUtf16 = surrounding.selectionEndUtf16;
      } else {
        this.#markedDocumentStartUtf16 = 0;
        this.#markedDocumentEndUtf16 = 0;
      }
    }
    if (!hadMarkedText && hasConcreteReplacement) {
      this.#emitDocumentReplacement(replacementLocation, replacementLength, "");
    }
    const replacement = hadMarkedText ? this.#markedReplacement(replacementLocation, replacementLength) : null;
    const text = replacement === null
      ? insertedText
      : this.#markedText.slice(0, replacement.start) + insertedText + this.#markedText.slice(replacement.end);
    const selectionBase = replacement?.start ?? 0;
    this.#markedText = text;
    const relativeLocation = clampedUtf16Offset(selectionLocation, insertedText.length);
    const location = Math.min(selectionBase + relativeLocation, text.length);
    this.#markedSelection = text.length === 0 ||
        selectionLocation === NS_NOT_FOUND || selectionLocation === -1 || selectionLocation === -1n
      ? null
      : {
        location,
        length: clampedUtf16Offset(selectionLength, insertedText.length - relativeLocation),
      };
    const update = text.length === 0 ? this.#composition.cancel() : this.#composition.update(
      text,
      this.#markedSelection === null ? null : utf16RangeToUtf8(text, location, this.#markedSelection.length),
    );
    if (update !== undefined) {
      this.#emit(createImePreeditEvent(this.window, update.text, update.cursorRange));
    }
    if (text.length === 0) this.#resetMarkedDocumentRange();
  }

  insertText(
    text: string,
    replacementLocation: number | bigint = NS_NOT_FOUND,
    replacementLength: number | bigint = 0,
  ): string | undefined {
    const committed = text.length === 0 ? undefined : text;
    if (committed === undefined) return undefined;
    const sourceKeyInputId = this.#claimDirectKeySource();
    this.#removeTrailingPreeditClear();
    const replaced = this.#emitDocumentReplacement(
      replacementLocation,
      replacementLength,
      committed,
      sourceKeyInputId,
    );
    this.#clearMarkedText();
    this.#composition.commit();
    if (!replaced) {
      const event = createImeCommitEvent(this.window, committed, sourceKeyInputId);
      if (event !== undefined) this.#emit(event);
    }
    return committed;
  }

  performCommand(command: string): void {
    const sourceKeyInputId = this.#claimDirectKeySource();
    this.#emit({
      type: "apple-standard-keybinding",
      command,
      window: this.window,
      ...(sourceKeyInputId === undefined ? {} : { sourceKeyInputId }),
    });
  }

  /** Accept the current marked text, matching NSTextInputClient.unmarkText. */
  unmarkText(): string | undefined {
    if (this.#batch !== null) this.#batch.sawCompositionCallback = true;
    if (!this.#composition.active) return undefined;
    if (!this.hasMarkedText) {
      this.#markedSelection = null;
      this.#composition.commit();
      return undefined;
    }
    const text = this.#markedText;
    const committed = text;
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
    this.#surrounding = null;
    this.#composition.reset();
    this.#activation.reset();
  }

  #claimDirectKeySource(): number | undefined {
    const batch = this.#batch;
    if (
      batch === null || batch.sourceClaimed || batch.sawCompositionCallback ||
      batch.key.isComposing || this.#composition.active
    ) {
      return undefined;
    }
    const sourceKeyInputId = batch.key.sourceKeyInputId;
    if (sourceKeyInputId === undefined) return undefined;
    batch.sourceClaimed = true;
    return sourceKeyInputId;
  }

  #clearMarkedText(): void {
    this.#markedText = "";
    this.#markedSelection = null;
    this.#resetMarkedDocumentRange();
  }

  #resetMarkedDocumentRange(): void {
    this.#markedDocumentStartUtf16 = 0;
    this.#markedDocumentEndUtf16 = 0;
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

  #markedReplacement(
    location: number | bigint,
    length: number | bigint,
  ): { start: number; end: number } | null {
    if (location === NS_NOT_FOUND || location === -1 || location === -1n) return null;
    const rawLocation = typeof location === "bigint" ? Number(location) : location;
    const rawLength = typeof length === "bigint" ? Number(length) : length;
    const range = utf16RangeToUtf8Range(this.#markedText, rawLocation, rawLength);
    if (range === null) {
      throw new RangeError("winding(darwin): marked-text replacementRange is outside marked text");
    }
    return { start: rawLocation, end: rawLocation + rawLength };
  }

  #emitDocumentReplacement(
    location: number | bigint,
    length: number | bigint,
    committed: string,
    sourceKeyInputId?: number,
  ): boolean {
    if (location === NS_NOT_FOUND || location === -1 || location === -1n) return false;
    const surrounding = this.#surrounding;
    if (surrounding === null) {
      throw new Error(
        "winding(darwin): concrete replacementRange requires setImeSurroundingText() state",
      );
    }
    const rawLocation = typeof location === "bigint" ? Number(location) : location;
    const rawLength = typeof length === "bigint" ? Number(length) : length;
    const range = utf16RangeToUtf8Range(surrounding.text, rawLocation, rawLength);
    if (range === null) {
      throw new RangeError("winding(darwin): replacementRange is outside IME surrounding text");
    }
    const replacement = createImeReplaceEvent(
      this.window,
      surrounding.text,
      range[0],
      range[1],
      committed,
      sourceKeyInputId,
    );
    if (replacement === undefined) {
      throw new RangeError("winding(darwin): replacementRange does not map to UTF-8 boundaries");
    }
    this.#emit(replacement);

    const startUtf16 = rawLocation;
    const endUtf16 = rawLocation + rawLength;
    const updated = surrounding.text.slice(0, startUtf16) + committed + surrounding.text.slice(endUtf16);
    const cursorBytes = range[0] + new TextEncoder().encode(committed).byteLength;
    this.setSurroundingText(updated, cursorBytes, cursorBytes);
    return true;
  }
}

function validUtf16Range(
  text: string,
  location: number | bigint,
  length: number | bigint,
): { start: number; end: number } | null {
  if (location === NS_NOT_FOUND || location === -1 || location === -1n) return null;
  const start = typeof location === "bigint" ? Number(location) : location;
  const size = typeof length === "bigint" ? Number(length) : length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0) return null;
  const end = start + size;
  if (!Number.isSafeInteger(end) || end > text.length) return null;
  return utf16RangeToUtf8Range(text, start, size) === null ? null : { start, end };
}
