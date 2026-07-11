import { keyLocationForCode, normalizeKeyboardText } from "./keyboard.ts";

Deno.test("key locations distinguish sided modifiers, keypad keys, and arrows", () => {
  assertEquals(keyLocationForCode("ShiftLeft"), 1);
  assertEquals(keyLocationForCode("ControlRight"), 2);
  assertEquals(keyLocationForCode("Numpad1"), 3);
  assertEquals(keyLocationForCode("NumpadParenLeft"), 3);
  assertEquals(keyLocationForCode("ArrowLeft"), 0);
  assertEquals(keyLocationForCode("ArrowRight"), 0);
  assertEquals(keyLocationForCode("KeyA"), 0);
  assertEquals(keyLocationForCode("Unidentified"), 0);
});

Deno.test("committed text rejects C0, C1, and DEL without rejecting Unicode text", () => {
  assertEquals(normalizeKeyboardText(""), undefined);
  assertEquals(normalizeKeyboardText("\u0003"), undefined);
  assertEquals(normalizeKeyboardText("line\nfeed"), undefined);
  assertEquals(normalizeKeyboardText("\u007f"), undefined);
  assertEquals(normalizeKeyboardText("\u0085"), undefined);
  assertEquals(normalizeKeyboardText("ß"), "ß");
  assertEquals(normalizeKeyboardText("👩‍💻"), "👩‍💻");
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}
