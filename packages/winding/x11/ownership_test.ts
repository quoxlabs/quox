import { claimX11LibraryOwnership, releaseX11LibraryOwnership } from "./ownership.ts";
import * as duplicate from "./ownership.ts?duplicate-module";

Deno.test("X11 ownership spans separately evaluated module copies", () => {
  const first = {};
  const second = {};
  try {
    assertEquals(claimX11LibraryOwnership(first), true);
    assertEquals(duplicate.claimX11LibraryOwnership(second), false);
    duplicate.releaseX11LibraryOwnership(second);
    assertEquals(duplicate.claimX11LibraryOwnership(second), false);

    releaseX11LibraryOwnership(first);
    assertEquals(duplicate.claimX11LibraryOwnership(second), true);
  } finally {
    releaseX11LibraryOwnership(first);
    duplicate.releaseX11LibraryOwnership(second);
  }
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}
