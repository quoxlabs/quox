import type { ImeCursorRange } from "../types.ts";
import { validateImeCursorRange } from "./ime.ts";

export interface PreeditUpdate {
  text: string;
  cursorRange: ImeCursorRange | null;
}

/** Remove a queued public preedit clear when a commit will end it atomically. */
export function discardTrailingPreeditClear<
  Event extends { type: string; kind?: string; text?: string },
>(events: Event[]): void {
  const last = events.at(-1);
  if (last?.type === "ime" && last.kind === "preedit" && last.text === "") events.pop();
}

/** Pure native-composition and canonical preedit state. */
export class CompositionState {
  #active = false;
  #text = "";
  #cursorRange: ImeCursorRange | null = null;
  #hasEmittedPreedit = false;

  /** Native composition state to snapshot immediately before a key transition. */
  get active(): boolean {
    return this.#active;
  }

  get isComposing(): boolean {
    return this.#active;
  }

  get text(): string {
    return this.#text;
  }

  get cursorRange(): ImeCursorRange | null {
    return this.#cursorRange;
  }

  /** Mark a native composition session active before it has visible preedit. */
  start(): void {
    this.#active = true;
  }

  /** Replace the complete public preedit and suppress identical updates. */
  update(text: string, cursorRange: ImeCursorRange | null): PreeditUpdate | undefined {
    this.#active = true;
    const normalizedRange = text.length === 0 || cursorRange === null
      ? null
      : validateImeCursorRange(text, cursorRange[0], cursorRange[1]);
    const duplicate = this.#hasEmittedPreedit && text === this.#text && rangesEqual(normalizedRange, this.#cursorRange);
    this.#text = text;
    this.#cursorRange = normalizedRange;
    if (duplicate) return undefined;
    this.#hasEmittedPreedit = true;
    return { text, cursorRange: normalizedRange };
  }

  /** A commit atomically ends composition without manufacturing an empty preedit. */
  commit(): void {
    this.#reset();
  }

  /** End composition without committing and return one canonical clear if needed. */
  cancel(): PreeditUpdate | undefined {
    const shouldClear = this.#active && !(this.#hasEmittedPreedit && this.#text.length === 0);
    this.#reset();
    return shouldClear ? { text: "", cursorRange: null } : undefined;
  }

  /** Forget all state without emitting a semantic event, for teardown. */
  reset(): void {
    this.#reset();
  }

  #reset(): void {
    this.#active = false;
    this.#text = "";
    this.#cursorRange = null;
    this.#hasEmittedPreedit = false;
  }
}

function rangesEqual(left: ImeCursorRange | null, right: ImeCursorRange | null): boolean {
  return left === null || right === null ? left === right : left[0] === right[0] && left[1] === right[1];
}
