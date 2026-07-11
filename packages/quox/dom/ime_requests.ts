import { assertFiniteNumber, assertIntegerRange, assertKnownMask, assertPositiveUint32 } from "./ffi_numbers.ts";

export interface ImeRequestTarget {
  setImeEnabled(enabled: boolean): void;
  setImeCursorArea(x: number, y: number, width: number, height: number): void;
}

export interface ImeRequestSource {
  peek_ime_requests(): Float64Array | undefined;
  ack_ime_requests(revision: number): void;
}

export const IME_REQUEST_FLAG = {
  cursorArea: 1 << 0,
  enabled: 1 << 1,
  contextRestart: 1 << 2,
} as const;

const IME_REQUEST_FLAGS = 0x07;
const IME_REQUEST_SNAPSHOT_LENGTH = 7;

/**
 * Apply one peeked Rust IME transaction and return its revision for acknowledgment.
 * No acknowledgment occurs here, so a native setter failure leaves the transaction retryable.
 */
export function applyImeRequestSnapshot(window: ImeRequestTarget, snapshot: Float64Array): number {
  if (snapshot.length !== IME_REQUEST_SNAPSHOT_LENGTH) {
    throw new RangeError(`invalid IME request snapshot length: ${snapshot.length}`);
  }

  const revision = assertPositiveUint32(snapshot[0], "IME request revision");
  const flags = assertKnownMask(snapshot[1], IME_REQUEST_FLAGS, "IME request flags");
  const contextRestart = (flags & IME_REQUEST_FLAG.contextRestart) !== 0;
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
  if (cursorArea !== undefined) {
    window.setImeCursorArea(...cursorArea);
  }
  if (contextRestart || (flags & IME_REQUEST_FLAG.enabled) !== 0) {
    window.setImeEnabled(enabled);
  }
  return revision;
}

/** Apply and acknowledge all currently pending transactions, stopping before ack on failure. */
export function synchronizeImeRequests(source: ImeRequestSource, target: ImeRequestTarget): void {
  for (;;) {
    const snapshot = source.peek_ime_requests();
    if (snapshot === undefined) return;
    const revision = applyImeRequestSnapshot(target, snapshot);
    source.ack_ime_requests(revision);
  }
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
