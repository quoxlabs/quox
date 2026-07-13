import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { darwinModifierSnapshot } from "./mod.ts";

Deno.test("Darwin exposes Function and the AppKit-visible lock state", () => {
  assertEquals(darwinModifierSnapshot((1n << 16n) | (1n << 20n) | (1n << 23n)), {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: true,
    accelKey: true,
    capsLock: true,
    altGraphKey: false,
    fnKey: true,
    numLock: false,
    scrollLock: false,
  });
});
