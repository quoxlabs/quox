import { scalarIndexToUtf8Offset } from "../input/mod.ts";

/** Convert an XIM Unicode-scalar cursor index to a UTF-8 byte offset. */
export function preeditCursorByteOffset(
  characters: readonly string[],
  scalarIndex: number,
): number | undefined {
  return scalarIndexToUtf8Offset(characters.join(""), scalarIndex);
}

/** Apply XIMPreeditDraw's scalar-indexed replacement to a preedit buffer. */
export function applyPreeditChange(
  characters: string[],
  first: number,
  length: number,
  replacement: readonly string[],
): boolean {
  if (
    !Number.isSafeInteger(first) || !Number.isSafeInteger(length) ||
    first < 0 || length < 0 || first > characters.length ||
    first + length > characters.length
  ) return false;
  characters.splice(first, length, ...replacement);
  return true;
}
