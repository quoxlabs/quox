import { makeNSRange, NS_NOT_FOUND, OBJC_BOOL_ENCODING, readNSRange } from "./ffi.ts";
import { nativeMouseButton } from "./mod.ts";
import {
  cocoaRectFromClient,
  logicalKeyForEvent,
  REQUIRED_TEXT_INPUT_SELECTORS,
  uninterpretedCommitText,
} from "./text_input.ts";

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
  const registered = new Set(REQUIRED_TEXT_INPUT_SELECTORS);
  for (const selector of TEXT_INPUT_SELECTORS) {
    assert(registered.has(selector), `missing Objective-C selector ${selector}`);
  }
});

Deno.test("Objective-C BOOL uses the architecture-correct method encoding", () => {
  const expected = Deno.build.arch === "x86_64" ? "c" : "B";
  assertEquals(OBJC_BOOL_ENCODING, expected);
});

Deno.test("NSRange helpers preserve ordinary ranges and NSNotFound", () => {
  assertEquals(readNSRange(makeNSRange(2, 7)), { location: 2n, length: 7n });
  assertEquals(readNSRange(makeNSRange(NS_NOT_FOUND, 0)), {
    location: NS_NOT_FOUND,
    length: 0n,
  });
});

Deno.test("Darwin native mouse numbers map only the three public buttons", () => {
  assertEquals(nativeMouseButton(0n), "left");
  assertEquals(nativeMouseButton(1n), "right");
  assertEquals(nativeMouseButton(2n), "middle");
  assertEquals(nativeMouseButton(3n), undefined);
  assertEquals(nativeMouseButton(4n), undefined);
});

Deno.test("logical keys come from AppKit text rather than the physical key position", () => {
  assertEquals(
    logicalKeyForEvent({
      code: "KeyY",
      characters: "z",
      charactersIgnoringModifiers: "z",
    }),
    "z",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "KeyQ",
      characters: "'",
      charactersIgnoringModifiers: "'",
    }),
    "'",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "KeyE",
      characters: "€",
      charactersIgnoringModifiers: "e",
    }),
    "€",
  );
});

Deno.test("logical key resolution covers interpreted text, dead keys, and named keys", () => {
  assertEquals(
    logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "",
      producedText: "é",
    }),
    "é",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "Quote",
      characters: "",
      charactersIgnoringModifiers: "",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "KeyK",
      characters: "k",
      charactersIgnoringModifiers: "k",
      producedPreedit: true,
    }),
    "k",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
    }),
    "Dead",
  );
  assertEquals(
    logicalKeyForEvent({
      code: "ArrowLeft",
      characters: "\uf702",
      charactersIgnoringModifiers: "\uf702",
    }),
    "ArrowLeft",
  );
});

Deno.test("inactive AppKit input commits ordinary text but not shortcuts or function scalars", () => {
  assertEquals(uninterpretedCommitText("z", false, false), "z");
  assertEquals(uninterpretedCommitText("€", false, false), "€");
  assertEquals(uninterpretedCommitText("c", true, false), undefined);
  assertEquals(uninterpretedCommitText("q", false, true), undefined);
  assertEquals(uninterpretedCommitText("\uf702", false, false), undefined);
});

Deno.test("candidate rectangles convert from top-left client to Cocoa view coordinates", () => {
  assertDeepEquals(
    cocoaRectFromClient({ x: 4.25, y: 8.5, width: 12.75, height: 16.5 }, 100),
    { x: 4.25, y: 75, width: 12.75, height: 16.5 },
  );
  assertDeepEquals(
    cocoaRectFromClient(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: -1, height: Number.NaN },
      100,
    ),
    { x: 0, y: 100, width: 0, height: 0 },
  );
  assertDeepEquals(
    cocoaRectFromClient({ x: -4, y: 110, width: 2, height: 3 }, 100),
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
