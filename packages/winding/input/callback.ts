/** Stores the first exception raised in a native callback until a safe JS boundary. */
export class DeferredNativeError {
  #pending: unknown;
  #hasPending = false;

  get pending(): boolean {
    return this.#hasPending;
  }

  capture(error: unknown): void {
    if (this.#hasPending) return;
    this.#pending = error;
    this.#hasPending = true;
  }

  /** Rethrow and clear the first captured callback exception. */
  throwIfPending(): void {
    if (!this.#hasPending) return;
    const error = this.#pending;
    this.#pending = undefined;
    this.#hasPending = false;
    throw error;
  }
}

/**
 * Prevent a JavaScript exception from crossing a native callback ABI.
 *
 * `fallback` must itself be non-throwing and return the callback signature's
 * safe native result (for example `0n`, `false`, or `undefined`).
 */
export function guardNativeCallback<Arguments extends unknown[], Result>(
  errors: DeferredNativeError,
  callback: (...args: Arguments) => Result,
  fallback: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  return (...args) => {
    try {
      return callback(...args);
    } catch (error) {
      errors.capture(error);
      return fallback(...args);
    }
  };
}
