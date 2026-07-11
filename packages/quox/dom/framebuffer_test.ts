import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { fitRgbaToFramebuffer, FramebufferState } from "./framebuffer.ts";

Deno.test("framebuffer state suspends zero surfaces and resumes without reviving stale renders", () => {
  const state = new FramebufferState(800, 600);
  const original = state.snapshot();
  assertEquals(state.drawable, true);

  state.update(0, 600);
  assertEquals(state.drawable, false);
  assertEquals(state.snapshot().width, 0);
  assertEquals(state.isCurrent(original), false);

  state.update(800, 0);
  assertEquals(state.drawable, false);
  assertEquals(state.snapshot().height, 0);

  state.update(800, 600);
  const resumed = state.snapshot();
  assertEquals(state.drawable, true);
  assertEquals(state.isCurrent(resumed), true);
  // Returning to the same dimensions must not make a render begun before the
  // zero-sized interval current again.
  assertEquals(state.isCurrent(original), false);
});

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
