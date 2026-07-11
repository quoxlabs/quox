/** Pure IMM32 composition parsing and native structure encoders. */

import { type ImeCursorArea, utf16IndexToUtf8Offset, utf8OffsetToUtf16Index } from "../input/ime.ts";
import { ATTR_TARGET_CONVERTED, ATTR_TARGET_NOTCONVERTED } from "./ffi.ts";

const UTF8_ENCODER = new TextEncoder();
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;

/** Candidate window excludes the supplied rectangle. */
export const CFS_EXCLUDE = 0x0080;
/** Composition window uses the supplied point. */
export const CFS_POINT = 0x0002;
/** IMM32 exposes four independently positionable candidate lists. */
export const IME_CANDIDATE_LIST_INDICES = [0, 1, 2, 3] as const;

export type PreeditCursorRange = readonly [start: number, end: number];

/** Convert IMM32's collapsed UTF-16 cursor to a collapsed UTF-8 byte range. */
export function utf16CursorRangeToUtf8(text: string, utf16Index: number): PreeditCursorRange | undefined {
  const offset = utf16IndexToUtf8Offset(text, utf16Index);
  return offset === undefined ? undefined : [offset, offset];
}

/**
 * Resolve IMM32's target clause to a UTF-8 preedit selection.
 * Invalid or incomplete native metadata degrades to the validated caret.
 */
export function immCompositionRangeToUtf8(
  text: string,
  cursorUtf16: number,
  attributes: Uint8Array | undefined,
  clauseBytes: Uint8Array | undefined,
): PreeditCursorRange | undefined {
  const caret = utf16CursorRangeToUtf8(text, cursorUtf16);
  const target = targetClauseUtf16Range(text, attributes, clauseBytes);
  if (target === undefined) return caret;

  const start = utf16IndexToUtf8Offset(text, target[0]);
  const end = utf16IndexToUtf8Offset(text, target[1]);
  return start === undefined || end === undefined ? caret : [start, end];
}

function targetClauseUtf16Range(
  text: string,
  attributes: Uint8Array | undefined,
  clauseBytes: Uint8Array | undefined,
): readonly [start: number, end: number] | undefined {
  if (
    text.length === 0 || attributes === undefined || attributes.byteLength !== text.length ||
    clauseBytes === undefined || clauseBytes.byteLength < 8 || (clauseBytes.byteLength & 3) !== 0
  ) return undefined;

  const clauseView = new DataView(clauseBytes.buffer, clauseBytes.byteOffset, clauseBytes.byteLength);
  const boundaries: number[] = [];
  for (let offset = 0; offset < clauseBytes.byteLength; offset += 4) {
    const boundary = clauseView.getUint32(offset, true);
    const previous = boundaries.at(-1);
    if (
      (previous === undefined ? boundary !== 0 : boundary <= previous) || boundary > text.length ||
      utf16IndexToUtf8Offset(text, boundary) === undefined
    ) return undefined;
    boundaries.push(boundary);
  }
  if (boundaries.at(-1) !== text.length) return undefined;

  let target: readonly [number, number] | undefined;
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const attribute = attributes[start];
    for (let character = start + 1; character < end; character++) {
      if (attributes[character] !== attribute) return undefined;
    }
    if (attribute !== ATTR_TARGET_CONVERTED && attribute !== ATTR_TARGET_NOTCONVERTED) continue;
    if (target !== undefined) return undefined;
    target = [start, end];
  }
  return target;
}

/** Apply WM_IME_COMPOSITION's CS_INSERTCHAR operation to cached preedit state. */
export function insertCompositionCharacter(
  text: string,
  cursorRange: PreeditCursorRange | undefined,
  character: string,
  noMoveCaret: boolean,
): { text: string; cursorRange: PreeditCursorRange } {
  const endOffset = UTF8_ENCODER.encode(text).byteLength;
  const requestedOffset = cursorRange?.[1] ?? endOffset;
  const insertionIndex = utf8OffsetToUtf16Index(text, requestedOffset) ?? text.length;
  const insertionOffset = utf16IndexToUtf8Offset(text, insertionIndex) ?? endOffset;
  const nextText = text.slice(0, insertionIndex) + character + text.slice(insertionIndex);
  const nextOffset = noMoveCaret ? insertionOffset : insertionOffset + UTF8_ENCODER.encode(character).byteLength;
  return { text: nextText, cursorRange: [nextOffset, nextOffset] };
}

function clampInt32(value: number): number {
  return Math.min(INT32_MAX, Math.max(INT32_MIN, value));
}

function rectRight(rect: ImeCursorArea): number {
  return clampInt32(rect.x + rect.width);
}

function rectBottom(rect: ImeCursorArea): number {
  return clampInt32(rect.y + rect.height);
}

/** Encode the 32-byte, pointer-free CANDIDATEFORM structure. */
export function encodeCandidateForm(rect: ImeCursorArea, index = 0): ArrayBuffer {
  if (!Number.isSafeInteger(index) || index < 0 || index >= IME_CANDIDATE_LIST_INDICES.length) {
    throw new RangeError("winding(win32): candidate-list index must be an integer from 0 through 3");
  }
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, index, true);
  view.setUint32(4, CFS_EXCLUDE, true);
  view.setInt32(8, rect.x, true);
  view.setInt32(12, rectBottom(rect), true);
  writeRect(view, 16, rect);
  return buffer;
}

/** Encode the 28-byte, pointer-free COMPOSITIONFORM structure. */
export function encodeCompositionForm(rect: ImeCursorArea): ArrayBuffer {
  const buffer = new ArrayBuffer(28);
  const view = new DataView(buffer);
  view.setUint32(0, CFS_POINT, true);
  view.setInt32(4, rect.x, true);
  view.setInt32(8, rectBottom(rect), true);
  writeRect(view, 12, rect);
  return buffer;
}

/** Encode the 36-byte IMECHARPOSITION response used by IMR_QUERYCHARPOSITION. */
export function encodeImeCharPosition(
  characterPosition: number,
  caretRect: ImeCursorArea,
  documentRect: ImeCursorArea,
): ArrayBuffer {
  const buffer = new ArrayBuffer(36);
  const view = new DataView(buffer);
  view.setUint32(0, buffer.byteLength, true);
  view.setUint32(4, clampUint32(characterPosition), true);
  view.setInt32(8, caretRect.x, true);
  view.setInt32(12, caretRect.y, true);
  view.setUint32(16, clampUint32(caretRect.height), true);
  writeRect(view, 20, documentRect);
  return buffer;
}

function writeRect(view: DataView, offset: number, rect: ImeCursorArea): void {
  view.setInt32(offset, rect.x, true);
  view.setInt32(offset + 4, rect.y, true);
  view.setInt32(offset + 8, rectRight(rect), true);
  view.setInt32(offset + 12, rectBottom(rect), true);
}

function clampUint32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(UINT32_MAX, Math.max(0, Math.trunc(value)));
}

export interface ImeCompositionUpdate {
  /** Presence means GCS_RESULTSTR was returned; the empty string is still a result. */
  result?: string;
  /** Undefined leaves preedit unchanged, null/empty clears it, and text replaces it. */
  preedit?: { text: string; cursorRange?: PreeditCursorRange } | null;
}

/** Adapter around ImmGetCompositionStringW for exact, race-tolerant UTF-16 reads. */
export interface ImmCompositionAdapter {
  getCompositionString(index: number, buffer?: Uint8Array): number;
}

/** Read an arbitrary IMM payload whose queried and copied lengths are bytes. */
export function readImmBytes(
  adapter: ImmCompositionAdapter,
  index: number,
  maximumAttempts = 3,
): Uint8Array | undefined {
  return readImmPayload(adapter, index, 1, maximumAttempts);
}

/** Read an IMM string whose reported lengths are bytes, not UTF-16 units. */
export function readImmUtf16(
  adapter: ImmCompositionAdapter,
  index: number,
  maximumAttempts = 3,
): string | undefined {
  const bytes = readImmPayload(adapter, index, 2, maximumAttempts);
  return bytes === undefined ? undefined : decodeUtf16Le(bytes);
}

function readImmPayload(
  adapter: ImmCompositionAdapter,
  index: number,
  alignment: number,
  maximumAttempts: number,
): Uint8Array | undefined {
  for (let attempt = 0; attempt < Math.max(1, maximumAttempts); attempt++) {
    const byteLength = adapter.getCompositionString(index);
    if (!isAlignedByteLength(byteLength, alignment)) return undefined;
    if (byteLength === 0) return new Uint8Array();

    const buffer = new Uint8Array(byteLength);
    const bytesWritten = adapter.getCompositionString(index, buffer);
    if (!Number.isSafeInteger(bytesWritten)) return undefined;
    if (bytesWritten < 0) {
      const currentLength = adapter.getCompositionString(index);
      if (isAlignedByteLength(currentLength, alignment) && currentLength > buffer.byteLength) {
        continue;
      }
      return undefined;
    }
    if (!isAlignedByteLength(bytesWritten, alignment)) return undefined;
    if (bytesWritten > buffer.byteLength) continue;
    const currentLength = adapter.getCompositionString(index);
    if (isAlignedByteLength(currentLength, alignment)) {
      if (currentLength !== bytesWritten) continue;
    }
    if (bytesWritten === 0) return currentLength === 0 ? new Uint8Array() : undefined;
    return buffer.slice(0, bytesWritten);
  }
  return undefined;
}

function isAlignedByteLength(value: number, alignment: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value % alignment === 0;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    text += String.fromCharCode(view.getUint16(offset, true));
  }
  return text;
}

/** Acquire/release an input context with release guaranteed across returns and exceptions. */
export function withImeContext<Context, Result>(
  acquire: () => Context | null | undefined,
  release: (context: Context) => void,
  callback: (context: Context) => Result,
): Result | undefined {
  const context = acquire();
  if (context === null || context === undefined) return undefined;
  let result: Result | undefined;
  const errors: unknown[] = [];
  try {
    result = callback(context);
  } catch (error) {
    errors.push(error);
  }
  try {
    release(context);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "IME context operation and release both failed");
  return result;
}
