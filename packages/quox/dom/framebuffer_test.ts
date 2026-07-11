import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { fitRgbaToFramebuffer } from "./framebuffer.ts";

Deno.test("framebuffer fitting keeps an exact renderer result without copying", () => {
  const exact = new Uint8Array(3 * 2 * 4);
  assertStrictEquals(fitRgbaToFramebuffer(exact, 3, 2, 3, 2), exact);
});

Deno.test("framebuffer fitting deterministically expands stale logical pixels", () => {
  const logical = new Uint8Array([
    255,
    0,
    0,
    255,
    0,
    0,
    255,
    128,
  ]);
  assertEquals(
    [...fitRgbaToFramebuffer(logical, 2, 1, 4, 2)],
    [
      255,
      0,
      0,
      255,
      255,
      0,
      0,
      255,
      0,
      0,
      255,
      128,
      0,
      0,
      255,
      128,
      255,
      0,
      0,
      255,
      255,
      0,
      0,
      255,
      0,
      0,
      255,
      128,
      0,
      0,
      255,
      128,
    ],
  );
});

Deno.test("framebuffer fitting rejects unknown renderer dimensions", () => {
  assertThrows(
    () => fitRgbaToFramebuffer(new Uint8Array(7), 2, 1, 4, 2),
    RangeError,
    "expected 8 or 32",
  );
});
