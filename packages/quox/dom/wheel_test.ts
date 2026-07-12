import { assertEquals } from "@std/assert";
import { wheelDeltaForBlitz } from "./wheel.ts";

Deno.test("wheel deltas retain browser units while translating Blitz scroll direction", () => {
  assertEquals(wheelDeltaForBlitz(2.25, -3.5, 0, 800, 600), [-2.25, 3.5]);
  assertEquals(wheelDeltaForBlitz(1, -2, 1, 800, 600), [-1, 2]);
  assertEquals(wheelDeltaForBlitz(0.5, -1, 2, 800, 600), [-400, 600]);
});
