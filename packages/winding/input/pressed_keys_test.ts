import { PressedLogicalKeyCache } from "./pressed_keys.ts";

Deno.test("pressed keys recompute their logical value for every native occurrence", () => {
  const cache = new PressedLogicalKeyCache<number>();
  assertEquals(cache.press(30, "a"), "a");
  assertEquals(cache.press(30, "q"), "q");
  assertEquals(cache.has(30), true);
  assertEquals(cache.get(30), "q");
  assertEquals(cache.size, 1);
  assertEquals(cache.release(30, "x"), "x");
  assertEquals(cache.has(30), false);
  assertEquals(cache.release(30), "Unidentified");
});

Deno.test("pressed keys retain a best-effort fallback for unresolvable releases", () => {
  const cache = new PressedLogicalKeyCache<number>();
  cache.press(30, "q");
  assertEquals(cache.release(30), "q");
});

Deno.test("pressed logical key cache supports backend-specific identities", () => {
  const cache = new PressedLogicalKeyCache<string>();
  assertEquals(cache.press("scan:30:vk:65", ""), "Unidentified");
  cache.press("scan:31:vk:83", "s");
  cache.clear();
  assertEquals(cache.size, 0);
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}
