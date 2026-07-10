import { applyPreeditChange, keysymToDomKey, normalizeCommittedText, utf8ByteOffset } from "./keysym.ts";
import { XEventType } from "./ffi.ts";
import { isAutoRepeatPair } from "./input.ts";

Deno.test("X11 logical keys prefer layout-aware printable text", () => {
  assertEquals(keysymToDomKey("z", "z"), "z");
  assertEquals(keysymToDomKey("adiaeresis", "ä"), "ä");
  assertEquals(keysymToDomKey("EuroSign", "€"), "€");
});

Deno.test("X11 logical keys use KeySym names for controls and named keys", () => {
  assertEquals(keysymToDomKey("c", "\u0003"), "c");
  assertEquals(keysymToDomKey("Return", "\r"), "Enter");
  assertEquals(keysymToDomKey("KP_Left", ""), "ArrowLeft");
  assertEquals(keysymToDomKey("ISO_Level3_Shift", ""), "AltGraph");
  assertEquals(keysymToDomKey("dead_acute", ""), "Dead");
  assertEquals(keysymToDomKey("F24", ""), "F24");
  assertEquals(keysymToDomKey("XF86AudioMute", ""), "AudioVolumeMute");
});

Deno.test("X11 committed text rejects shortcut control bytes", () => {
  assertEquals(normalizeCommittedText(""), undefined);
  assertEquals(normalizeCommittedText("\u0003"), undefined);
  assertEquals(normalizeCommittedText("line\nfeed"), undefined);
  assertEquals(normalizeCommittedText("ß"), "ß");
  assertEquals(normalizeCommittedText("👩‍💻"), "👩‍💻");
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
  assertEquals(utf8ByteOffset(text, 0), 0);
  assertEquals(utf8ByteOffset(text, 1), 1);
  assertEquals(utf8ByteOffset(text, 2), 3);
  assertEquals(utf8ByteOffset(text, 3), 6);
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
