import { isDeadKeysym, keyLocationHintForKeysym, logicalKeyFromKeysym, unicodeTextFromKeysym } from "./keysym.ts";

Deno.test("Linux logical keys prefer layout-aware printable lookup text", () => {
  assertEquals(logicalKeyFromKeysym(0x7a, "z"), "z");
  assertEquals(logicalKeyFromKeysym(0x61, "ä"), "ä");
  assertEquals(logicalKeyFromKeysym(0x010020acn, "€"), "€");
  assertEquals(logicalKeyFromKeysym(0x0101f642n), "🙂");
});

Deno.test("Linux logical keys use keysyms for controls, named, keypad, and media keys", () => {
  assertEquals(logicalKeyFromKeysym(0x63, "\u0003"), "c");
  assertEquals(logicalKeyFromKeysym(0xff0d, "\r"), "Enter");
  assertEquals(logicalKeyFromKeysym(0xff96), "ArrowLeft");
  assertEquals(logicalKeyFromKeysym(0xffb7), "7");
  assertEquals(logicalKeyFromKeysym(0xffae, ","), ",");
  assertEquals(logicalKeyFromKeysym(0xfe03), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0xfe04), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0xfe05), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0xff7e), "ModeChange");
  assertEquals(logicalKeyFromKeysym(0xff20), "Compose");
  assertEquals(logicalKeyFromKeysym(0xfe34), "Enter");
  assertEquals(logicalKeyFromKeysym(0xffed), "Hyper");
  assertEquals(logicalKeyFromKeysym(0xffca), "F13");
  assertEquals(logicalKeyFromKeysym(0x1008ff14), "MediaPlay");
  assertEquals(logicalKeyFromKeysym(0x1008ff12), "AudioVolumeMute");
  assertEquals(logicalKeyFromKeysym(0x100811d0), "Fn");
});

Deno.test("effective Linux modifier keysyms retain their native side", () => {
  for (const keysym of [0xffe1, 0xffe3, 0xffe7, 0xffe9, 0xffeb]) {
    assertEquals(keyLocationHintForKeysym(keysym), 1);
  }
  for (const keysym of [0xffe2, 0xffe4, 0xffe8, 0xffea, 0xffec]) {
    assertEquals(keyLocationHintForKeysym(keysym), 2);
  }
  assertEquals(keyLocationHintForKeysym(0xfe03), undefined);
  assertEquals(keyLocationHintForKeysym(0x61), undefined);
});

Deno.test("Linux dead and invalid keysyms have canonical fallbacks", () => {
  assertEquals(isDeadKeysym(0xfe51), true);
  assertEquals(logicalKeyFromKeysym(0xfe51), "Dead");
  assertEquals(logicalKeyFromKeysym(0x1234), "Unidentified");
  assertEquals(logicalKeyFromKeysym(-1), "Unidentified");
  assertEquals(logicalKeyFromKeysym(0x1_0000_0061n), "Unidentified");
  assertEquals(logicalKeyFromKeysym(0x0100d800), "Unidentified");
  assertEquals(logicalKeyFromKeysym(0x61, "\u0085"), "a");
});

Deno.test("Unicode keysym decoding validates scalar values", () => {
  assertEquals(unicodeTextFromKeysym(0x61), "a");
  assertEquals(unicodeTextFromKeysym(0x00e9), "é");
  assertEquals(unicodeTextFromKeysym(0x010020ac), "€");
  assertEquals(unicodeTextFromKeysym(0x0101f642), "🙂");
  assertEquals(unicodeTextFromKeysym(0x0100d800), "");
  assertEquals(unicodeTextFromKeysym(0x01110000), "");
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}
