import { normalizeCommittedText } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";
import { XEventType } from "./ffi.ts";
import { fallbackLookupText, isAutoRepeatPair, x11KeyEditDisposition } from "./input.ts";
import { applyPreeditChange, preeditCursorByteOffset } from "./xim_preedit.ts";

Deno.test("X11 logical keys prefer layout-aware printable text", () => {
  assertEquals(logicalKeyFromKeysym(0x7a, "z"), "z");
  assertEquals(logicalKeyFromKeysym(0x010000e4, "ä"), "ä");
  assertEquals(logicalKeyFromKeysym(0x010020ac, "€"), "€");
});

Deno.test("X11 logical keys use KeySym names for controls and named keys", () => {
  assertEquals(logicalKeyFromKeysym(0x63, "\u0003"), "c");
  assertEquals(logicalKeyFromKeysym(0xff0d, "\r"), "Enter");
  assertEquals(logicalKeyFromKeysym(0xff96), "ArrowLeft");
  assertEquals(logicalKeyFromKeysym(0xfe03), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0xfe51), "Dead");
  assertEquals(logicalKeyFromKeysym(0xffd5), "F24");
  assertEquals(logicalKeyFromKeysym(0x1008ff12), "AudioVolumeMute");
});

Deno.test("X11 committed text rejects shortcut control bytes", () => {
  assertEquals(normalizeCommittedText(""), undefined);
  assertEquals(normalizeCommittedText("\u0003"), undefined);
  assertEquals(normalizeCommittedText("line\nfeed"), undefined);
  assertEquals(normalizeCommittedText("ß"), "ß");
  assertEquals(normalizeCommittedText("👩‍💻"), "👩‍💻");
});

Deno.test("X11 fallback lookup keeps controls out while retaining layout text", () => {
  assertEquals(fallbackLookupText(new Uint8Array([3]), "c"), undefined);
  assertEquals(fallbackLookupText(new TextEncoder().encode("€"), "e"), "€");
  assertEquals(fallbackLookupText(new Uint8Array([0xe4]), "ä"), "ä");
  assertEquals(fallbackLookupText(new Uint8Array(), "ß"), "ß");
});

Deno.test("X11 edit ownership includes dead keys and XIM semantic output", () => {
  assertEquals(x11KeyEditDisposition("c", false, false, false, false), "key-default");
  assertEquals(x11KeyEditDisposition("Dead", false, false, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("a", true, false, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("Unidentified", false, true, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("Unidentified", false, false, false, true), "text-input");
});

Deno.test("XIM preedit draw applies scalar-indexed replacements", () => {
  const text = [..."aé文"];
  assertEquals(applyPreeditChange(text, 1, 1, [..."ßx"]), true);
  assertEquals(text.join(""), "aßx文");
  assertEquals(applyPreeditChange(text, 4, 0, []), true);
  assertEquals(applyPreeditChange(text, 5, 0, []), false);
  assertEquals(applyPreeditChange(text, -1, 1, []), false);
});

Deno.test("XIM cursor scalar indices convert to UTF-8 byte offsets", () => {
  const text = [..."aé文"];
  assertEquals(preeditCursorByteOffset(text, 0), 0);
  assertEquals(preeditCursorByteOffset(text, 1), 1);
  assertEquals(preeditCursorByteOffset(text, 2), 3);
  assertEquals(preeditCursorByteOffset(text, 3), 6);
});

Deno.test("X11 repeat detection requires an identical adjacent press", () => {
  const releaseBuffer = new ArrayBuffer(192);
  const pressBuffer = new ArrayBuffer(192);
  const release = new DataView(releaseBuffer);
  const press = new DataView(pressBuffer);
  release.setInt32(0, XEventType.KeyRelease, true);
  release.setBigUint64(32, 99n, true);
  release.setBigUint64(56, 1234n, true);
  release.setUint32(84, 24, true);
  press.setInt32(0, XEventType.KeyPress, true);
  press.setBigUint64(32, 99n, true);
  press.setBigUint64(56, 1234n, true);
  press.setUint32(84, 24, true);

  assertEquals(isAutoRepeatPair(release, press), true);
  press.setBigUint64(56, 1235n, true);
  assertEquals(isAutoRepeatPair(release, press), false);
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}
