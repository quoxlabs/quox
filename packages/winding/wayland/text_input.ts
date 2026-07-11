/** Double-buffered semantic state for the Wayland text-input-v3 protocol. */

import type { ImeCursorRange } from "../types.ts";
import { isUtf8Boundary, utf8OffsetToUtf16Index, validateImeCursorRange } from "../input/mod.ts";

const UINT32_MAX = 0xffffffff;
const MAX_SURROUNDING_TEXT_BYTES = 4000;
const UTF8_ENCODER = new TextEncoder();

export interface WaylandSurroundingTextState {
  /** Full application-owned snapshot retained for interpreting later edits. */
  readonly text: string;
  readonly selectionStartBytes: number;
  readonly selectionEndBytes: number;
  /** Protocol-sized slice containing the complete selection. */
  readonly wireText: string;
  readonly cursorBytes: number;
  readonly anchorBytes: number;
}

export function createWaylandSurroundingTextState(
  text: string,
  selectionStartBytes: number,
  selectionEndBytes: number,
): WaylandSurroundingTextState {
  const selection = validateImeCursorRange(text, selectionStartBytes, selectionEndBytes);
  if (selection === null) {
    throw new RangeError("winding(wayland): invalid UTF-8 surrounding-text selection");
  }
  if (text.includes("\0")) {
    throw new RangeError("winding(wayland): surrounding text cannot contain NUL");
  }

  const bytes = UTF8_ENCODER.encode(text);
  const selectionBytes = selection[1] - selection[0];
  if (selectionBytes > MAX_SURROUNDING_TEXT_BYTES) {
    throw new RangeError("winding(wayland): surrounding-text selection exceeds the 4000-byte protocol limit");
  }

  let sliceStart = 0;
  let sliceEnd = bytes.length;
  if (bytes.length > MAX_SURROUNDING_TEXT_BYTES) {
    const contextBytes = MAX_SURROUNDING_TEXT_BYTES - selectionBytes;
    sliceStart = Math.max(0, selection[0] - Math.floor(contextBytes / 2));
    sliceEnd = Math.min(bytes.length, sliceStart + MAX_SURROUNDING_TEXT_BYTES);
    if (sliceEnd < selection[1]) {
      sliceEnd = selection[1];
      sliceStart = Math.max(0, sliceEnd - MAX_SURROUNDING_TEXT_BYTES);
    }
    if (sliceEnd - sliceStart < MAX_SURROUNDING_TEXT_BYTES) {
      sliceStart = Math.max(0, sliceEnd - MAX_SURROUNDING_TEXT_BYTES);
    }
    while (!isUtf8Boundary(bytes, sliceStart)) sliceStart++;
    while (!isUtf8Boundary(bytes, sliceEnd)) sliceEnd--;
  }

  const utf16Start = utf8OffsetToUtf16Index(text, sliceStart)!;
  const utf16End = utf8OffsetToUtf16Index(text, sliceEnd)!;
  return {
    text,
    selectionStartBytes: selection[0],
    selectionEndBytes: selection[1],
    wireText: text.slice(utf16Start, utf16End),
    cursorBytes: selection[1] - sliceStart,
    anchorBytes: selection[0] - sliceStart,
  };
}

export type TextInputEdit =
  | { type: "preedit"; text: string; cursorRange: ImeCursorRange | null }
  | { type: "deleteSurrounding"; beforeBytes: number; afterBytes: number }
  | { type: "commit"; text: string };

export interface TextInputDoneResult {
  readonly serial: number;
  readonly serialMatches: boolean;
  readonly edits: TextInputEdit[];
}

interface PendingPreedit {
  readonly text: string;
  readonly cursorRange: ImeCursorRange | null;
}

interface PendingCommit {
  readonly text: string | null;
}

export class TextInputV3Batch {
  #pendingPreedit: PendingPreedit | undefined;
  #pendingCommit: PendingCommit | undefined;
  #pendingDelete: { beforeBytes: number; afterBytes: number } | undefined;
  #visiblePreedit = false;
  #clientCommitSerial = 0;

  get clientCommitSerial(): number {
    return this.#clientCommitSerial;
  }

  get hasVisiblePreedit(): boolean {
    return this.#visiblePreedit;
  }

  recordClientCommit(): number {
    this.#clientCommitSerial = (this.#clientCommitSerial + 1) >>> 0;
    return this.#clientCommitSerial;
  }

  setPreedit(text: string | null, cursorBegin: number, cursorEnd: number): void {
    const resolvedText = text ?? "";
    const rangeStart = Math.min(cursorBegin, cursorEnd);
    const rangeEnd = Math.max(cursorBegin, cursorEnd);
    this.#pendingPreedit = {
      text: resolvedText,
      cursorRange: validateImeCursorRange(resolvedText, rangeStart, rangeEnd),
    };
  }

  setCommit(text: string | null): void {
    this.#pendingCommit = { text };
  }

  setDeleteSurrounding(beforeBytes: number, afterBytes: number): void {
    this.#pendingDelete = { beforeBytes: clampUint32(beforeBytes), afterBytes: clampUint32(afterBytes) };
  }

  done(serial: number): TextInputDoneResult {
    const edits: TextInputEdit[] = [];
    const hasDeletion = this.#pendingDelete !== undefined &&
      (this.#pendingDelete.beforeBytes !== 0 || this.#pendingDelete.afterBytes !== 0);
    const commitText = this.#pendingCommit?.text ?? "";
    // A nonempty public commit atomically ends preedit. Deletion still needs an
    // explicit clear first so consumers observe the protocol-mandated order.
    if (this.#visiblePreedit && (commitText.length === 0 || hasDeletion)) {
      edits.push({ type: "preedit", text: "", cursorRange: null });
    }
    if (hasDeletion) edits.push({ type: "deleteSurrounding", ...this.#pendingDelete! });
    if (commitText.length > 0) edits.push({ type: "commit", text: commitText });
    if (this.#pendingPreedit !== undefined && this.#pendingPreedit.text.length > 0) {
      edits.push({ type: "preedit", ...this.#pendingPreedit });
    }

    this.#visiblePreedit = (this.#pendingPreedit?.text.length ?? 0) > 0;
    this.#resetPending();

    const normalizedSerial = toUint32(serial);
    return {
      serial: normalizedSerial,
      serialMatches: normalizedSerial === this.#clientCommitSerial,
      edits,
    };
  }

  resetEdits(): TextInputEdit[] {
    const edits: TextInputEdit[] = this.#visiblePreedit ? [{ type: "preedit", text: "", cursorRange: null }] : [];
    this.#visiblePreedit = false;
    this.#resetPending();
    return edits;
  }

  #resetPending(): void {
    this.#pendingPreedit = undefined;
    this.#pendingCommit = undefined;
    this.#pendingDelete = undefined;
  }
}

function clampUint32(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(UINT32_MAX, Math.floor(value));
}

function toUint32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value) >>> 0;
}
