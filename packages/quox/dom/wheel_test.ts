import { assertEquals } from "@std/assert";
import { wheelPixelsForBlitz } from "./wheel.ts";

Deno.test("wheel deltas retain browser units while translating Blitz scroll direction", () => {
  assertEquals(wheelPixelsForBlitz(2.25, -3.5, 0, 800, 600), [-2.25, 3.5]);
  assertEquals(wheelPixelsForBlitz(1, -2, 1, 800, 600), [-40, 80]);
  assertEquals(wheelPixelsForBlitz(0.5, -1, 2, 800, 600), [-400, 600]);
});
