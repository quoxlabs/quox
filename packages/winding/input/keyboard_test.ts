import { keyLocationForKey, normalizeKeyboardText } from "./keyboard.ts";

Deno.test("key locations follow the effective key instead of the physical code alone", () => {
  assertEquals(keyLocationForKey("Shift", "ShiftLeft"), 1);
  assertEquals(keyLocationForKey("Control", "ControlRight"), 2);
  assertEquals(keyLocationForKey("a", "ShiftLeft"), 0);
  assertEquals(keyLocationForKey("Shift", "KeyA", 1), 1);
  assertEquals(keyLocationForKey("Control", "KeyA", 2), 2);
  assertEquals(keyLocationForKey("1", "Numpad1"), 3);
  assertEquals(keyLocationForKey("End", "Numpad1"), 3);
  assertEquals(keyLocationForKey("ArrowLeft", "Numpad4"), 3);
  assertEquals(keyLocationForKey("ArrowLeft", "ArrowLeft"), 0);
});

Deno.test("only UI Events keypad meanings may use the numpad location", () => {
  for (
    const key of [
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "End",
      "Home",
      "PageDown",
      "PageUp",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      ".",
      "Enter",
      "+",
      "-",
      "*",
      "/",
    ]
  ) {
    assertEquals(keyLocationForKey(key, "NumpadUnidentified"), 3);
  }
  for (const key of ["NumLock", "Clear", "Insert", "Delete", ",", "=", "(", ")", "Unidentified"]) {
    assertEquals(keyLocationForKey(key, "NumpadUnidentified"), 0);
  }
});

Deno.test("explicit native locations are sanitized against the effective key", () => {
  assertEquals(keyLocationForKey("Meta", "Unidentified", 1), 1);
  assertEquals(keyLocationForKey("Meta", "Unidentified", 2), 2);
  assertEquals(keyLocationForKey("Meta", "Unidentified", 3), 0);
  assertEquals(keyLocationForKey("Enter", "Unidentified", 3), 3);
  assertEquals(keyLocationForKey("Enter", "Unidentified", 2), 0);
  assertEquals(keyLocationForKey("NumLock", "NumLock", 3), 0);
  assertEquals(keyLocationForKey("a", "KeyA", 2), 0);
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
