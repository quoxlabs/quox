import { readPointerStatic } from "./ffi.ts";

Deno.test("Darwin dereferences pointer-valued foreign statics", () => {
  const staticAddress = {} as unknown as Deno.PointerObject;
  const target = {} as unknown as Deno.PointerObject;
  let readAddress: Deno.PointerObject | undefined;

  const actual = readPointerStatic(staticAddress, (address) => {
    readAddress = address;
    return target;
  });

  assertEquals(readAddress, staticAddress);
  assertEquals(actual, target);
});

Deno.test("Darwin preserves null pointer-valued foreign statics", () => {
  const actual = readPointerStatic(null, () => {
    throw new Error("null foreign static must not be dereferenced");
  });
  assertEquals(actual, null);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}
