import { assertEquals, assertThrows } from "@std/assert";
import {
  assertFiniteNumber,
  assertFloat32,
  assertIntegerRange,
  assertKnownMask,
  assertPositiveFloat32,
  assertPositiveUint32,
  assertUint32,
  assertUtf8ByteRange,
} from "./ffi_numbers.ts";

Deno.test("FFI integer validation rejects values that WASM integer parameters would narrow", () => {
  assertEquals(assertUint32(0xffff_ffff, "value"), 0xffff_ffff);
  assertEquals(assertPositiveUint32(1, "value"), 1);
  for (const value of [NaN, Infinity, -Infinity, -1, 1.5, 0x1_0000_0000]) {
    assertThrows(() => assertUint32(value, "value"), RangeError);
  }
  assertThrows(() => assertPositiveUint32(0, "value"), RangeError);
  assertThrows(() => assertUint32("1", "value"), TypeError);
});

Deno.test("FFI floating-point validation rejects non-finite and non-representable values", () => {
  assertEquals(assertFiniteNumber(-3.5, "delta"), -3.5);
  assertEquals(assertFloat32(12.25, "coordinate"), 12.25);
  assertEquals(assertPositiveFloat32(2, "scale"), 2);
  assertThrows(() => assertFiniteNumber(Infinity, "delta"), RangeError);
  assertThrows(() => assertFloat32(Number.MAX_VALUE, "coordinate"), RangeError);
  assertThrows(() => assertFloat32(Number.MIN_VALUE, "coordinate"), RangeError);
  assertThrows(() => assertPositiveFloat32(0, "scale"), RangeError);
});

Deno.test("FFI enum and bitmask validation preserves every supported pointer button", () => {
  assertEquals(assertIntegerRange(4, 0, 4, "button"), 4);
  assertEquals(assertKnownMask(0x1f, 0x1f, "buttons"), 0x1f);
  assertThrows(() => assertIntegerRange(5, 0, 4, "button"), RangeError);
  assertThrows(() => assertIntegerRange(256, 0, 4, "button"), RangeError);
  assertThrows(() => assertKnownMask(0x20, 0x1f, "buttons"), RangeError);
});

Deno.test("FFI preedit ranges must use ordered UTF-8 byte boundaries", () => {
  assertEquals(assertUtf8ByteRange("éx", [2, 3]), [2, 3]);
  assertEquals(assertUtf8ByteRange("éx", null), null);
  assertThrows(() => assertUtf8ByteRange("éx", [1, 3]), RangeError);
  assertThrows(() => assertUtf8ByteRange("éx", [3, 2]), RangeError);
  assertThrows(() => assertUtf8ByteRange("éx", [0, 4]), RangeError);
  assertThrows(() => assertUtf8ByteRange("éx", [0, 0x1_0000_0000]), RangeError);
});
