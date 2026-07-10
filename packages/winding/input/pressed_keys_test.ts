import { PressedLogicalKeyCache } from "./pressed_keys.ts";

Deno.test("pressed logical keys remain stable across repeats and layout changes", () => {
  const cache = new PressedLogicalKeyCache<number>();
  assertEquals(cache.press(30, "a"), "a");
  assertEquals(cache.press(30, "q"), "a");
  assertEquals(cache.has(30), true);
  assertEquals(cache.size, 1);
  assertEquals(cache.release(30, "q"), "a");
  assertEquals(cache.has(30), false);
  assertEquals(cache.release(30), "Unidentified");
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
