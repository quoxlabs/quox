import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  applyImeRequestSnapshot,
  type ImeRequestSource,
  type ImeRequestTarget,
  runWithImeSynchronization,
  synchronizeImeRequests,
} from "./ime_requests.ts";

function snapshot(
  revision: number,
  flags: number,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  enabled = 0,
): Float64Array {
  return new Float64Array([revision, flags, x, y, width, height, enabled]);
}

class FakeWindow implements ImeRequestTarget {
  readonly calls: Array<[string, ...number[]]> = [];
  failAreaCount = 0;
  failEnableCount = 0;

  setImeEnabled(enabled: boolean): void {
    this.calls.push(["enabled", Number(enabled)]);
    if (this.failEnableCount > 0) {
      this.failEnableCount -= 1;
      throw new Error("enable failed");
    }
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.calls.push(["area", x, y, width, height]);
    if (this.failAreaCount > 0) {
      this.failAreaCount -= 1;
      throw new Error("area failed");
    }
  }
}

class FakeSource implements ImeRequestSource {
  current: Float64Array | undefined;
  readonly acknowledged: number[] = [];
  afterAck: (() => void) | undefined;
  ackError: unknown;

  constructor(current: Float64Array | undefined) {
    this.current = current;
  }

  peek_ime_requests(): Float64Array | undefined {
    return this.current;
  }

  ack_ime_requests(revision: number): void {
    if (this.ackError !== undefined) throw this.ackError;
    this.acknowledged.push(revision);
    this.current = undefined;
    this.afterAck?.();
  }
}

Deno.test("IME synchronization applies cursor geometry before enable and then acknowledges", () => {
  const target = new FakeWindow();
  const source = new FakeSource(snapshot(7, 3, 1, 2, 3, 4, 1));

  synchronizeImeRequests(source, target);

  assertEquals(target.calls, [
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
  ]);
  assertEquals(source.acknowledged, [7]);
});

Deno.test("IME context restart disables the old editor before geometry and enable", () => {
  const target = new FakeWindow();
  const revision = applyImeRequestSnapshot(target, snapshot(9, 5, 10, 20, 3, 4, 1));

  assertEquals(revision, 9);
  assertEquals(target.calls, [
    ["enabled", 0],
    ["area", 10, 20, 3, 4],
    ["enabled", 1],
  ]);
});

Deno.test("failed cursor application remains unacknowledged and retries the whole transaction", () => {
  const target = new FakeWindow();
  target.failAreaCount = 1;
  const source = new FakeSource(snapshot(3, 3, 1, 2, 3, 4, 1));

  assertThrows(() => synchronizeImeRequests(source, target), Error, "area failed");
  assertEquals(source.acknowledged, []);
  synchronizeImeRequests(source, target);

  assertEquals(target.calls, [
    ["area", 1, 2, 3, 4],
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
  ]);
  assertEquals(source.acknowledged, [3]);
});

Deno.test("failed enable retries already-applied geometry before acknowledging", () => {
  const target = new FakeWindow();
  target.failEnableCount = 1;
  const source = new FakeSource(snapshot(4, 3, 1, 2, 3, 4, 1));

  assertThrows(() => synchronizeImeRequests(source, target), Error, "enable failed");
  assertEquals(source.acknowledged, []);
  synchronizeImeRequests(source, target);

  assertEquals(target.calls, [
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
  ]);
  assertEquals(source.acknowledged, [4]);
});

Deno.test("failed restart geometry retries disable, geometry, and final enable", () => {
  const target = new FakeWindow();
  target.failAreaCount = 1;
  const source = new FakeSource(snapshot(5, 5, 10, 20, 3, 4, 1));

  assertThrows(() => synchronizeImeRequests(source, target), Error, "area failed");
  synchronizeImeRequests(source, target);

  assertEquals(target.calls, [
    ["enabled", 0],
    ["area", 10, 20, 3, 4],
    ["enabled", 0],
    ["area", 10, 20, 3, 4],
    ["enabled", 1],
  ]);
  assertEquals(source.acknowledged, [5]);
});

Deno.test("IME synchronization drains a newer transaction exposed after ack", () => {
  const target = new FakeWindow();
  const source = new FakeSource(snapshot(1, 2, 0, 0, 0, 0, 0));
  source.afterAck = () => {
    source.afterAck = undefined;
    source.current = snapshot(2, 2, 0, 0, 0, 0, 1);
  };

  synchronizeImeRequests(source, target);

  assertEquals(source.acknowledged, [1, 2]);
  assertEquals(target.calls, [
    ["enabled", 0],
    ["enabled", 1],
  ]);
});

Deno.test("ack failure propagates after native application without inventing success", () => {
  const target = new FakeWindow();
  const source = new FakeSource(snapshot(6, 2, 0, 0, 0, 0, 1));
  const ackError = new Error("ack failed");
  source.ackError = ackError;

  assertStrictEquals(assertThrows(() => synchronizeImeRequests(source, target)), ackError);
  assert(source.current !== undefined);
  assertEquals(source.acknowledged, []);
});

Deno.test("malformed IME snapshots fail before native application or acknowledgment", () => {
  const malformed = [
    new Float64Array([1, 2]),
    snapshot(0, 2, 0, 0, 0, 0, 1),
    snapshot(1.5, 2, 0, 0, 0, 0, 1),
    snapshot(1, 8, 0, 0, 0, 0, 1),
    snapshot(1, 4, 0, 0, 0, 0, 0),
    snapshot(1, 1, 0, 0, -1, 4, 0),
  ];
  for (const value of malformed) {
    const target = new FakeWindow();
    const source = new FakeSource(value);
    assertThrows(() => synchronizeImeRequests(source, target), RangeError);
    assertEquals(target.calls, []);
    assertEquals(source.acknowledged, []);
  }
});

Deno.test("IME finalization preserves single errors and aggregates simultaneous failures", () => {
  const operationError = new Error("operation failed");
  const synchronizationError = new Error("sync failed");

  assertEquals(runWithImeSynchronization(() => 42, () => undefined), 42);
  assertStrictEquals(
    assertThrows(() =>
      runWithImeSynchronization(() => {
        throw operationError;
      }, () => undefined)
    ),
    operationError,
  );
  assertStrictEquals(
    assertThrows(() =>
      runWithImeSynchronization(() => undefined, () => {
        throw synchronizationError;
      })
    ),
    synchronizationError,
  );

  const aggregate = assertThrows(
    () =>
      runWithImeSynchronization(
        () => {
          throw operationError;
        },
        () => {
          throw synchronizationError;
        },
      ),
    AggregateError,
  );
  assertStrictEquals(aggregate.errors[0], operationError);
  assertStrictEquals(aggregate.errors[1], synchronizationError);
});
