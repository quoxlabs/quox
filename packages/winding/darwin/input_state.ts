import type { AppleStandardKeybindingEvent, KeyDownEvent, TextInputEvent, Window } from "../types.ts";
import { createTextInputEvent } from "../input/mod.ts";
import { printableText } from "./text_input.ts";

export type DarwinTextInputEvent = TextInputEvent | AppleStandardKeybindingEvent;
export type DarwinInputEvent = KeyDownEvent | DarwinTextInputEvent;

interface KeyBatch {
  key: KeyDownEvent;
  following: DarwinTextInputEvent[];
}

/** Per-view keyboard batching and modifier state. */
export class DarwinInputState {
  #modifierFlags = 0n;
  readonly #pressedModifierCodes = new Set<string>();
  #batch: KeyBatch | null = null;
  #pending: DarwinTextInputEvent[] = [];
  #closed = false;

  constructor(readonly window: Window) {}

  get modifierFlags(): bigint {
    return this.#modifierFlags;
  }

  modifierTransition(
    code: string,
    flags: bigint,
    aggregateFlag: bigint | undefined,
  ): "keydown" | "keyup" {
    const previous = this.#modifierFlags;
    this.#modifierFlags = flags;
    const wasGroupActive = aggregateFlag !== undefined && (previous & aggregateFlag) !== 0n;
    const isGroupActive = aggregateFlag !== undefined && (flags & aggregateFlag) !== 0n;
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

  insertText(text: string): string | undefined {
    const committed = printableText(text);
    if (committed === undefined) return undefined;
    const event = createTextInputEvent(this.window, committed);
    if (event !== undefined) this.#emit(event);
    return committed;
  }

  performCommand(command: string): void {
    this.#emit({ type: "apple-standard-keybinding", command, window: this.window });
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
    this.resetModifiers();
  }

  #emit(event: DarwinTextInputEvent): void {
    if (this.#closed) return;
    if (this.#batch !== null) this.#batch.following.push(event);
    else this.#pending.push(event);
  }
}
