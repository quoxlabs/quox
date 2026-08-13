import {
  logicalKeyForEvent,
  printableText,
  REQUIRED_TEXT_INPUT_SELECTORS,
  uninterpretedCommitText,
} from "./text_input.ts";

Deno.test("Darwin bridge exposes only commit and command selectors", () => {
  assertEquals(REQUIRED_TEXT_INPUT_SELECTORS, [
    "acceptsFirstResponder",
    "keyDown:",
    "keyUp:",
    "flagsChanged:",
    "insertText:replacementRange:",
    "doCommandBySelector:",
  ]);
  assert(!REQUIRED_TEXT_INPUT_SELECTORS.some((selector) => selector.includes("Marked")));
});

Deno.test("Darwin separates physical code from layout-aware logical key", () => {
  assertEquals(logicalKeyForEvent({ code: "KeyY", characters: "z", charactersIgnoringModifiers: "z" }), "z");
  assertEquals(logicalKeyForEvent({ code: "KeyZ", characters: "y", charactersIgnoringModifiers: "y" }), "y");
  for (const text of ["ä", "ö", "ü", "ß", "@"]) {
    assertEquals(logicalKeyForEvent({ code: "KeyQ", characters: text, charactersIgnoringModifiers: text }), text);
  }
});

Deno.test("Darwin dead keys and shortcuts do not emit direct text", () => {
  assertEquals(logicalKeyForEvent({ code: "Quote", characters: "", charactersIgnoringModifiers: "´" }), "Dead");
  assertEquals(uninterpretedCommitText("a", true, false), undefined);
  assertEquals(uninterpretedCommitText("a", false, true), undefined);
  assertEquals(uninterpretedCommitText("é", false, false), "é");
  assertEquals(printableText("\uf700"), undefined);
});

function assert(condition: boolean): void {
  if (!condition) throw new Error("assertion failed");
}

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`);
}
