import { darwinApplicationAction } from "./application_state.ts";

Deno.test("Darwin creates AppKit only when no application or claim exists", () => {
  assertEquals(darwinApplicationAction(null, undefined), "create");
});

Deno.test("Darwin rejects application state not claimed by this module", () => {
  assertEquals(darwinApplicationAction(0x1234n, undefined), "reject");
  assertEquals(
    darwinApplicationAction(0x1234n, { pointer: 0x5678n, initialized: true }),
    "reject",
  );
  assertEquals(
    darwinApplicationAction(null, { pointer: 0x1234n, initialized: true }),
    "reject",
  );
});

Deno.test("Darwin initializes its application once and then reuses it", () => {
  assertEquals(
    darwinApplicationAction(0x1234n, { pointer: 0x1234n, initialized: false }),
    "initialize",
  );
  assertEquals(
    darwinApplicationAction(0x1234n, { pointer: 0x1234n, initialized: true }),
    "reuse",
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}
