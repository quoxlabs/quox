import { scalarIndexToUtf8Offset } from "../input/mod.ts";

export const enum XimCaretDirection {
  ForwardChar = 0,
  BackwardChar = 1,
  ForwardWord = 2,
  BackwardWord = 3,
  Up = 4,
  Down = 5,
  NextLine = 6,
  PreviousLine = 7,
  LineStart = 8,
  LineEnd = 9,
  AbsolutePosition = 10,
  DontChange = 11,
}

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

export type XimPreeditDrawContent =
  | { readonly kind: "delete" }
  | { readonly kind: "text"; readonly characters: readonly string[] }
  | { readonly kind: "feedback"; readonly length: number };

export interface AppliedXimPreeditDraw {
  readonly cursor: number;
  /** Text draws remain observable; feedback-only draws are observable only when the caret moves. */
  readonly emit: boolean;
}

/** Apply one XIMPreeditDraw while preserving feedback-only updates as non-text changes. */
export function applyXimPreeditDraw(
  characters: string[],
  currentCursor: number,
  caret: number,
  first: number,
  changedLength: number,
  content: XimPreeditDrawContent,
): AppliedXimPreeditDraw | undefined {
  if (content.kind === "feedback") {
    if (!isValidPreeditRange(characters.length, first, content.length)) return undefined;
  } else {
    const replacement = content.kind === "text" ? content.characters : [];
    if (!applyPreeditChange(characters, first, changedLength, replacement)) return undefined;
  }

  const cursor = Number.isSafeInteger(caret) && caret >= 0 && caret <= characters.length ? caret : currentCursor;
  return {
    cursor,
    emit: content.kind !== "feedback" || cursor !== currentCursor,
  };
}

function isValidPreeditRange(characterCount: number, first: number, length: number): boolean {
  return Number.isSafeInteger(first) && Number.isSafeInteger(length) &&
    first >= 0 && length >= 0 && first <= characterCount && first + length <= characterCount;
}

/** Apply XIM's synchronous caret request to the backend's one-line preedit model. */
export function movePreeditCaret(
  characters: readonly string[],
  current: number,
  direction: number,
  absolute: number,
): number {
  const length = characters.length;
  const position = Math.max(0, Math.min(length, current));
  switch (direction) {
    case XimCaretDirection.ForwardChar:
      return Math.min(length, position + 1);
    case XimCaretDirection.BackwardChar:
      return Math.max(0, position - 1);
    case XimCaretDirection.ForwardWord: {
      let next = position;
      while (next < length && !/^\s$/u.test(characters[next])) next++;
      while (next < length && /^\s$/u.test(characters[next])) next++;
      return next;
    }
    case XimCaretDirection.BackwardWord: {
      let previous = position;
      while (previous > 0 && /^\s$/u.test(characters[previous - 1])) previous--;
      while (previous > 0 && !/^\s$/u.test(characters[previous - 1])) previous--;
      return previous;
    }
    case XimCaretDirection.Up:
    case XimCaretDirection.PreviousLine:
    case XimCaretDirection.LineStart:
      return 0;
    case XimCaretDirection.Down:
    case XimCaretDirection.NextLine:
    case XimCaretDirection.LineEnd:
      return length;
    case XimCaretDirection.AbsolutePosition:
      return Math.max(0, Math.min(length, absolute));
    case XimCaretDirection.DontChange:
    default:
      return position;
  }
}
