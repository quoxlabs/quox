import { assertEquals, assertThrows } from "@std/assert";
import { applyImeRequestSnapshot, type ImeRequestTarget } from "./ime_requests.ts";

class FakeWindow implements ImeRequestTarget {
  readonly calls: Array<[string, ...number[]]> = [];

  setImeEnabled(enabled: boolean): void {
    this.calls.push(["enabled", Number(enabled)]);
  }
  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.calls.push(["area", x, y, width, height]);
  }
}

Deno.test("legacy IME snapshot applies cursor geometry before enable", () => {
  const target = new FakeWindow();
  applyImeRequestSnapshot(target, new Float32Array([3, 1, 2, 3, 4, 1]));
  assertEquals(target.calls, [
    ["area", 1, 2, 3, 4],
    ["enabled", 1],
  ]);
});

Deno.test("IME context restart disables the old editor before applying the new editor state", () => {
  const target = new FakeWindow();
  applyImeRequestSnapshot(target, new Float32Array([5, 10, 20, 3, 4, 1]));
  assertEquals(target.calls, [
    ["enabled", 0],
    ["area", 10, 20, 3, 4],
    ["enabled", 1],
  ]);
});

Deno.test("IME context restart cannot leave the replacement editor disabled", () => {
  assertThrows(
    () => applyImeRequestSnapshot(new FakeWindow(), new Float32Array([4, 0, 0, 0, 0, 0])),
    RangeError,
    "must end enabled",
  );
});
