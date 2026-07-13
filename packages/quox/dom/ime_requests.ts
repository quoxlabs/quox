import {
  assertFiniteNumber,
  assertIntegerRange,
  assertKnownMask,
  assertPositiveUint32,
  assertUint32,
  assertUtf8ByteRange,
} from "./ffi_numbers.ts";

export interface ImeRequestTarget {
  setImeEnabled(enabled: boolean): void;
  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void;
  setImeCursorArea(x: number, y: number, width: number, height: number): void;
}

export interface ImeRequestSource {
  peek_ime_requests(): Float64Array | undefined;
  ack_ime_requests(revision: number): void;
}

export interface NativeImeStateSource extends ImeRequestSource {
  /** `[text, ordered UTF-8 selection start, selection end]`, or unavailable/private. */
  ime_surrounding_text(): unknown;
}

interface ImeSurroundingText {
  readonly text: string;
  readonly selectionStartBytes: number;
  readonly selectionEndBytes: number;
}

export const IME_REQUEST_FLAG = {
  cursorArea: 1 << 0,
  enabled: 1 << 1,
  contextRestart: 1 << 2,
  surroundingResync: 1 << 3,
} as const;

const IME_REQUEST_FLAGS = 0x0f;
const IME_REQUEST_SNAPSHOT_LENGTH = 7;
const WAYLAND_MAX_SURROUNDING_TEXT_BYTES = 4_000;
const EMPTY_SURROUNDING_TEXT: ImeSurroundingText = {
  text: "",
  selectionStartBytes: 0,
  selectionEndBytes: 0,
};

type PrepareImeContext = (force: boolean) => void;

/**
 * Apply one peeked Rust IME transaction and return its revision for acknowledgment.
 * No acknowledgment occurs here, so a native setter failure leaves the transaction retryable.
 */
export function applyImeRequestSnapshot(
  window: ImeRequestTarget,
  snapshot: Float64Array,
  prepareContext: PrepareImeContext = () => undefined,
): number {
  if (snapshot.length !== IME_REQUEST_SNAPSHOT_LENGTH) {
    throw new RangeError(`invalid IME request snapshot length: ${snapshot.length}`);
  }

  const revision = assertPositiveUint32(snapshot[0], "IME request revision");
  const flags = assertKnownMask(snapshot[1], IME_REQUEST_FLAGS, "IME request flags");
  const contextRestart = (flags & IME_REQUEST_FLAG.contextRestart) !== 0;
  const surroundingResync = (flags & IME_REQUEST_FLAG.surroundingResync) !== 0;
  const enabledNumber = assertIntegerRange(snapshot[6], 0, 1, "IME request enabled state");
  const enabled = enabledNumber === 1;

  let cursorArea: readonly [number, number, number, number] | undefined;
  if ((flags & IME_REQUEST_FLAG.cursorArea) !== 0) {
    const x = assertFiniteNumber(snapshot[2], "IME cursor x");
    const y = assertFiniteNumber(snapshot[3], "IME cursor y");
    const width = assertFiniteNumber(snapshot[4], "IME cursor width");
    const height = assertFiniteNumber(snapshot[5], "IME cursor height");
    if (width < 0 || height < 0) {
      throw new RangeError("quox: IME cursor dimensions must be nonnegative");
    }
    cursorArea = [x, y, width, height];
  }

  if (contextRestart) {
    if (!enabled) throw new RangeError("an IME context restart must end enabled");
    window.setImeEnabled(false);
  }
  prepareContext(contextRestart || surroundingResync);
  if (cursorArea !== undefined) {
    window.setImeCursorArea(...cursorArea);
  }
  if (contextRestart || (flags & IME_REQUEST_FLAG.enabled) !== 0) {
    window.setImeEnabled(enabled);
  }
  return revision;
}

/** Apply and acknowledge all currently pending transactions, stopping before ack on failure. */
export function synchronizeImeRequests(
  source: ImeRequestSource,
  target: ImeRequestTarget,
  prepareContext: PrepareImeContext = () => undefined,
): void {
  let prepared = false;
  const prepare = (force: boolean) => {
    if (!force && prepared) return;
    prepareContext(force);
    prepared = true;
  };
  for (;;) {
    const snapshot = source.peek_ime_requests();
    if (snapshot === undefined) {
      prepare(false);
      return;
    }
    const revision = applyImeRequestSnapshot(target, snapshot, prepare);
    source.ack_ime_requests(revision);
  }
}

/**
 * Own the application-to-native half of IME state. Surrounding text is installed before an
 * initial enable, and between the disable/enable halves of a context restart. Successfully
 * installed snapshots are deduplicated, except that a restart always resends the cached state.
 */
export class NativeImeSynchronizer {
  #appliedSurroundingText: ImeSurroundingText | undefined;

  synchronize(source: NativeImeStateSource, target: ImeRequestTarget): void {
    const surroundingText = decodeImeSurroundingText(source.ime_surrounding_text());
    if (!sameImeSurroundingText(surroundingText, this.#appliedSurroundingText)) {
      // Validate before an IME transaction can disable its old native context. A force-resend
      // reuses a snapshot which already passed this check on its successful first application.
      assertUtf8ByteRange(
        surroundingText.text,
        [surroundingText.selectionStartBytes, surroundingText.selectionEndBytes],
        "IME surrounding selection",
      );
    }
    synchronizeImeRequests(
      source,
      target,
      (force) => this.#applySurroundingText(target, surroundingText, force),
    );
  }

  #applySurroundingText(target: ImeRequestTarget, snapshot: ImeSurroundingText, force: boolean): void {
    if (!force && sameImeSurroundingText(snapshot, this.#appliedSurroundingText)) return;

    try {
      target.setImeSurroundingText(
        snapshot.text,
        snapshot.selectionStartBytes,
        snapshot.selectionEndBytes,
      );
    } catch (error) {
      const exceedsPortableSelection =
        snapshot.selectionEndBytes - snapshot.selectionStartBytes > WAYLAND_MAX_SURROUNDING_TEXT_BYTES;
      // Wayland strings cannot contain NUL and must carry the complete selection in 4000 bytes.
      // Other backends can accept these snapshots, so degrade only when the selected backend
      // rejects one of those two known representations.
      if (!(error instanceof RangeError) || (!snapshot.text.includes("\0") && !exceedsPortableSelection)) {
        throw error;
      }
      target.setImeSurroundingText("", 0, 0);
    }

    // A failed full or fallback setter remains retryable; only native success earns deduplication.
    this.#appliedSurroundingText = snapshot;
  }
}

function decodeImeSurroundingText(value: unknown): ImeSurroundingText {
  if (value === undefined) return EMPTY_SURROUNDING_TEXT;
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("quox: IME surrounding-text snapshot must be a three-item array or undefined");
  }
  if (typeof value[0] !== "string") {
    throw new TypeError("quox: IME surrounding-text snapshot text must be a string");
  }
  const selectionStartBytes = assertUint32(value[1], "IME surrounding selection start");
  const selectionEndBytes = assertUint32(value[2], "IME surrounding selection end");
  if (selectionStartBytes > selectionEndBytes) {
    throw new RangeError("quox: IME surrounding selection must be ordered");
  }
  return { text: value[0], selectionStartBytes, selectionEndBytes };
}

function sameImeSurroundingText(
  left: ImeSurroundingText,
  right: ImeSurroundingText | undefined,
): boolean {
  return right !== undefined && left.text === right.text &&
    left.selectionStartBytes === right.selectionStartBytes &&
    left.selectionEndBytes === right.selectionEndBytes;
}

/**
 * Run an operation and its mandatory IME synchronization without letting a finalizer error hide
 * the original failure. A single error preserves identity; simultaneous failures stay ordered.
 */
export function runWithImeSynchronization<Result>(operation: () => Result, synchronize: () => void): Result {
  let operationFailed = false;
  let operationError: unknown;
  let result: Result | undefined;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    synchronize();
  } catch (synchronizationError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, synchronizationError],
        "Quox operation and IME synchronization both failed",
      );
    }
    throw synchronizationError;
  }

  if (operationFailed) throw operationError;
  return result as Result;
}
