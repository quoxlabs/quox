import { XEventType } from "./ffi.ts";
import { fallbackLookupText, isAutoRepeatPair, x11KeyEditDisposition } from "./input.ts";

Deno.test("X11 commit lookup preserves layout-aware Unicode", () => {
  const encoder = new TextEncoder();
  for (const text of ["y", "z", "ä", "ö", "ü", "ß", "@"]) {
    assertEquals(fallbackLookupText(encoder.encode(text), ""), text);
  }
  assertEquals(fallbackLookupText(new Uint8Array([3]), "a"), undefined);
});

Deno.test("X11 text ownership covers commits and dead keys only", () => {
  assertEquals(x11KeyEditDisposition("c", false), "key-default");
  assertEquals(x11KeyEditDisposition("Dead", false), "text-input");
  assertEquals(x11KeyEditDisposition("a", true), "text-input");
  assertEquals(x11KeyEditDisposition("ArrowLeft", false), "key-default");
});

Deno.test("X11 identifies native repeat release/press pairs", () => {
  const release = new DataView(new ArrayBuffer(192));
  const press = new DataView(new ArrayBuffer(192));
  press.setInt32(0, XEventType.KeyPress, true);
  release.setBigUint64(32, 5n, true);
  press.setBigUint64(32, 5n, true);
  release.setBigUint64(56, 20n, true);
  press.setBigUint64(56, 20n, true);
  release.setUint32(84, 21, true);
  press.setUint32(84, 21, true);
  assertEquals(isAutoRepeatPair(release, press), true);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`);
}
