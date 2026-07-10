import {
  isUtf8Boundary,
  normalizeImeCursorArea,
  scalarIndexToUtf8Offset,
  utf16IndexToUtf8Offset,
  utf16RangeToUtf8Range,
  utf8ByteLength,
  utf8OffsetToUtf16Index,
  validateImeCursorArea,
  validateImeCursorRange,
} from "./ime.ts";

Deno.test("IME cursor areas round outward, clamp to signed 32-bit, and reject invalid input", () => {
  assertEquals(validateImeCursorArea(10.25, 20.75, 3.5, 4.5), {
    x: 10.25,
    y: 20.75,
    width: 3.5,
    height: 4.5,
  });
  assertEquals(validateImeCursorArea(1, 2, -3, -4), { x: 1, y: 2, width: 0, height: 0 });
  assertEquals(normalizeImeCursorArea(10.25, 20.75, 3.5, 4.5), {
    x: 10,
    y: 20,
    width: 4,
    height: 6,
  });
  assertEquals(normalizeImeCursorArea(-4, 2, -3, -1), {
    x: -4,
    y: 2,
    width: 0,
    height: 0,
  });
  assertEquals(normalizeImeCursorArea(Number.NaN, 0, 1, 1), undefined);
  assertEquals(normalizeImeCursorArea(0, Number.POSITIVE_INFINITY, 1, 1), undefined);
  assertEquals(normalizeImeCursorArea(-1e20, -1e20, 2e20, 2e20), {
    x: -0x80000000,
    y: -0x80000000,
    width: 0x7fffffff,
    height: 0x7fffffff,
  });
});

Deno.test("IME cursor ranges require valid UTF-8 byte boundaries", () => {
  assertEquals(validateImeCursorRange("plain", 1, 4), [1, 4]);
  assertEquals(validateImeCursorRange("é日", 2, 5), [2, 5]);
  assertEquals(validateImeCursorRange("é日", 1, 5), null);
  assertEquals(validateImeCursorRange("é日", 2, 4), null);
  assertEquals(validateImeCursorRange("é日", 5, 6), null);
  assertEquals(validateImeCursorRange("text", -1, -1), null);
  assertEquals(validateImeCursorRange("text", 3, 2), null);
  assertEquals(validateImeCursorRange("", 0, 0), [0, 0]);
});

Deno.test("UTF-16 and UTF-8 offsets convert only at scalar boundaries", () => {
  const text = "A🙂é";
  assertEquals(utf16IndexToUtf8Offset(text, 0), 0);
  assertEquals(utf16IndexToUtf8Offset(text, 1), 1);
  assertEquals(utf16IndexToUtf8Offset(text, 2), undefined);
  assertEquals(utf16IndexToUtf8Offset(text, 3), 5);
  assertEquals(utf16IndexToUtf8Offset(text, 4), 7);
  assertEquals(utf8OffsetToUtf16Index(text, 0), 0);
  assertEquals(utf8OffsetToUtf16Index(text, 1), 1);
  assertEquals(utf8OffsetToUtf16Index(text, 5), 3);
  assertEquals(utf8OffsetToUtf16Index(text, 2), undefined);
  assertEquals(utf8OffsetToUtf16Index(text, 100), undefined);
  assertEquals(utf16RangeToUtf8Range(text, 1, 2), [1, 5]);
  assertEquals(utf16RangeToUtf8Range(text, 2, 1), null);
  assertEquals(utf16RangeToUtf8Range(text, 1, -1), null);
});

Deno.test("UTF-8 boundary checks reject continuations and invalid offsets", () => {
  const bytes = new TextEncoder().encode("é日");
  assertEquals(isUtf8Boundary(bytes, 0), true);
  assertEquals(isUtf8Boundary(bytes, 1), false);
  assertEquals(isUtf8Boundary(bytes, 2), true);
  assertEquals(isUtf8Boundary(bytes, 4), false);
  assertEquals(isUtf8Boundary(bytes, 5), true);
  assertEquals(isUtf8Boundary(bytes, -1), false);
  assertEquals(isUtf8Boundary(bytes, 6), false);
});

Deno.test("Unicode scalar indices convert to UTF-8 byte offsets", () => {
  assertEquals(utf8ByteLength("aé文"), 6);
  const text = "aé文";
  assertEquals(scalarIndexToUtf8Offset(text, 0), 0);
  assertEquals(scalarIndexToUtf8Offset(text, 1), 1);
  assertEquals(scalarIndexToUtf8Offset(text, 2), 3);
  assertEquals(scalarIndexToUtf8Offset(text, 3), 6);
  assertEquals(scalarIndexToUtf8Offset(text, 4), undefined);
  assertEquals(scalarIndexToUtf8Offset(text, -1), undefined);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
