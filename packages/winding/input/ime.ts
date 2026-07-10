import type { ImeCursorRange } from "../types.ts";

const UTF8_ENCODER = new TextEncoder();
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

export interface ImeCursorArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

/** Validate logical client geometry while preserving subpixel coordinates. */
export function validateImeCursorArea(
  x: number,
  y: number,
  width: number,
  height: number,
): ImeCursorArea | undefined {
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Normalize logical client geometry to an outward-rounded signed-32 rectangle.
 * Invalid input leaves the backend's previous valid area unchanged.
 */
export function normalizeImeCursorArea(
  x: number,
  y: number,
  width: number,
  height: number,
): ImeCursorArea | undefined {
  const logical = validateImeCursorArea(x, y, width, height);
  if (logical === undefined) return undefined;
  const right = logical.x + logical.width;
  const bottom = logical.y + logical.height;
  const normalizedX = clampInt32(Math.floor(x));
  const normalizedY = clampInt32(Math.floor(y));
  const normalizedRight = clampInt32(Math.ceil(right));
  const normalizedBottom = clampInt32(Math.ceil(bottom));
  return {
    x: normalizedX,
    y: normalizedY,
    width: width <= 0 ? 0 : clampDimension(normalizedRight - normalizedX),
    height: height <= 0 ? 0 : clampDimension(normalizedBottom - normalizedY),
  };
}

/** Validate inclusive/exclusive UTF-8 byte offsets into preedit text. */
export function validateImeCursorRange(
  text: string,
  start: number,
  end: number,
): ImeCursorRange | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) return null;

  const bytes = UTF8_ENCODER.encode(text);
  if (end > bytes.length || !isUtf8Boundary(bytes, start) || !isUtf8Boundary(bytes, end)) return null;
  return [start, end];
}

/** Convert a valid UTF-16 range to inclusive/exclusive UTF-8 byte offsets. */
export function utf16RangeToUtf8Range(
  text: string,
  utf16Start: number,
  utf16Length: number,
): ImeCursorRange | null {
  if (!Number.isSafeInteger(utf16Length) || utf16Length < 0) return null;
  const start = utf16IndexToUtf8Offset(text, utf16Start);
  const end = utf16IndexToUtf8Offset(text, utf16Start + utf16Length);
  return start === undefined || end === undefined ? null : [start, end];
}

/** Convert a valid JavaScript UTF-16 boundary to a UTF-8 byte offset. */
export function utf16IndexToUtf8Offset(text: string, utf16Index: number): number | undefined {
  if (!Number.isSafeInteger(utf16Index) || utf16Index < 0 || utf16Index > text.length) return undefined;
  if (
    utf16Index > 0 && utf16Index < text.length &&
    isHighSurrogate(text.charCodeAt(utf16Index - 1)) && isLowSurrogate(text.charCodeAt(utf16Index))
  ) {
    return undefined;
  }
  return UTF8_ENCODER.encode(text.slice(0, utf16Index)).byteLength;
}

/** Convert a valid UTF-8 byte boundary to a JavaScript UTF-16 index. */
export function utf8OffsetToUtf16Index(text: string, utf8Offset: number): number | undefined {
  if (!Number.isSafeInteger(utf8Offset) || utf8Offset < 0) return undefined;

  let offset = 0;
  for (let index = 0; index < text.length;) {
    if (offset === utf8Offset) return index;
    const codePoint = text.codePointAt(index)!;
    const scalar = String.fromCodePoint(codePoint);
    offset += UTF8_ENCODER.encode(scalar).byteLength;
    if (offset > utf8Offset) return undefined;
    index += scalar.length;
  }
  return offset === utf8Offset ? text.length : undefined;
}

/** Convert a Unicode-scalar index, as used by XIM, to a UTF-8 byte offset. */
export function scalarIndexToUtf8Offset(text: string, scalarIndex: number): number | undefined {
  if (!Number.isSafeInteger(scalarIndex) || scalarIndex < 0) return undefined;
  const scalars = [...text];
  if (scalarIndex > scalars.length) return undefined;
  return UTF8_ENCODER.encode(scalars.slice(0, scalarIndex).join("")).byteLength;
}

/** Whether an offset is a scalar boundary in a UTF-8 byte sequence. */
export function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) return false;
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function clampInt32(value: number): number {
  return Math.min(INT32_MAX, Math.max(INT32_MIN, value));
}

function clampDimension(value: number): number {
  return Math.min(INT32_MAX, Math.max(0, value));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
