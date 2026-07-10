import { makeNSRange, NS_NOT_FOUND, readNSRange } from "./ffi.ts";
import { __testing } from "./text_input.ts";

const TEXT_INPUT_SELECTORS = [
  "acceptsFirstResponder",
  "keyDown:",
  "keyUp:",
  "flagsChanged:",
  "insertText:replacementRange:",
  "setMarkedText:selectedRange:replacementRange:",
  "unmarkText",
  "hasMarkedText",
  "markedRange",
  "selectedRange",
  "validAttributesForMarkedText",
  "attributedSubstringForProposedRange:actualRange:",
  "characterIndexForPoint:",
  "firstRectForCharacterRange:actualRange:",
  "doCommandBySelector:",
] as const;

Deno.test("WindingContentView declares the complete NSTextInputClient responder surface", () => {
  const registered = new Set(__testing.requiredSelectors);
  for (const selector of TEXT_INPUT_SELECTORS) {
    assert(registered.has(selector), `missing Objective-C selector ${selector}`);
  }
});

Deno.test("Objective-C BOOL uses the architecture-correct method encoding", () => {
  const expected = Deno.build.arch === "x86_64" ? "c" : "B";
  assertEquals(__testing.boolEncoding, expected);
});

Deno.test("NSRange helpers preserve ordinary ranges and NSNotFound", () => {
  assertEquals(readNSRange(makeNSRange(2, 7)), { location: 2n, length: 7n });
  assertEquals(readNSRange(makeNSRange(NS_NOT_FOUND, 0)), {
    location: NS_NOT_FOUND,
    length: 0n,
  });
});

Deno.test("logical keys come from AppKit text rather than the physical key position", () => {
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyY",
      characters: "z",
      charactersIgnoringModifiers: "z",
    }),
    "z",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyQ",
      characters: "'",
      charactersIgnoringModifiers: "'",
    }),
    "'",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "€",
      charactersIgnoringModifiers: "e",
    }),
    "€",
  );
});

Deno.test("logical key resolution covers interpreted text, dead keys, and named keys", () => {
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "",
      producedText: "é",
    }),
    "é",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "Quote",
      characters: "",
      charactersIgnoringModifiers: "",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyK",
      characters: "k",
      charactersIgnoringModifiers: "k",
      producedPreedit: true,
    }),
    "k",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "ArrowLeft",
      characters: "\uf702",
      charactersIgnoringModifiers: "\uf702",
    }),
    "ArrowLeft",
  );
});

Deno.test("Darwin key locations distinguish left, right, and keypad keys", () => {
  assertEquals(__testing.keyLocationForCode("ShiftLeft"), 1);
  assertEquals(__testing.keyLocationForCode("AltRight"), 2);
  assertEquals(__testing.keyLocationForCode("Numpad7"), 3);
  assertEquals(__testing.keyLocationForCode("KeyA"), 0);
});

Deno.test("candidate rectangles convert from top-left client to Cocoa view coordinates", () => {
  assertDeepEquals(
    __testing.cocoaRectFromClient({ x: 4.25, y: 8.5, width: 12.75, height: 16.5 }, 100),
    { x: 4.25, y: 75, width: 12.75, height: 16.5 },
  );
  assertDeepEquals(
    __testing.cocoaRectFromClient(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: -1, height: Number.NaN },
      100,
    ),
    { x: 0, y: 100, width: 0, height: 0 },
  );
  assertDeepEquals(
    __testing.cocoaRectFromClient({ x: -4, y: 110, width: 2, height: 3 }, 100),
    { x: -4, y: -13, width: 2, height: 3 },
  );
});

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const encode = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? `${item}n` : item,
    );
  if (encode(actual) !== encode(expected)) {
    throw new Error(`expected ${encode(expected)}, got ${encode(actual)}`);
  }
}

function assertDeepEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}
