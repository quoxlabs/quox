import { assertEquals } from "@std/assert";
import { releaseStoppedRenderer } from "./internals.ts";

Deno.test("a normal completed dispatch does not release a running renderer", () => {
  let releases = 0;
  assertEquals(releaseStoppedRenderer(false, false, false, () => releases++), false);
  assertEquals(releases, 0);
});

Deno.test("a stop during dispatch defers renderer release until dispatch becomes idle", () => {
  let releases = 0;
  const release = () => releases++;

  assertEquals(releaseStoppedRenderer(true, true, false, release), false);
  assertEquals(releases, 0);
  assertEquals(releaseStoppedRenderer(true, false, false, release), true);
  assertEquals(releases, 1);
  assertEquals(releaseStoppedRenderer(true, false, true, release), false);
  assertEquals(releases, 1);
});
