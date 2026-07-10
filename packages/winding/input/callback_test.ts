import { DeferredNativeError, guardNativeCallback } from "./callback.ts";

Deno.test("native callback guard returns its ABI fallback and defers the first error", () => {
  const errors = new DeferredNativeError();
  const first = new Error("first");
  const callback = guardNativeCallback(
    errors,
    (value: number) => {
      throw value === 1 ? first : new Error("second");
    },
    () => 17,
  );

  assertEquals(callback(1), 17);
  assertEquals(callback(2), 17);
  assertEquals(errors.pending, true);
  assertThrowsSame(() => errors.throwIfPending(), first);
  assertEquals(errors.pending, false);
  errors.throwIfPending();
});

Deno.test("native callback guard preserves successful return values", () => {
  const errors = new DeferredNativeError();
  const callback = guardNativeCallback(errors, (value: bigint) => value + 1n, () => 0n);
  assertEquals(callback(4n), 5n);
  assertEquals(errors.pending, false);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
}

function assertThrowsSame(callback: () => void, expected: unknown): void {
  try {
    callback();
  } catch (error) {
    if (error === expected) return;
    throw new Error("Callback threw a different error");
  }
  throw new Error("Expected callback to throw");
}
