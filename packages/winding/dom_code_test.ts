import { getDomCode as getDarwinDomCode } from "./darwin/dom_code.ts";
import { getDomCode as getWaylandDomCode } from "./wayland/dom_code.ts";
import { getDomCode as getWin32DomCode } from "./win32/dom_code.ts";
import { getDomCode as getX11DomCode } from "./x11/dom_code.ts";

Deno.test("DOM code mappings normalize Q across native key identifiers", () => {
  assertEquals(getX11DomCode(24), "KeyQ");
  assertEquals(getWaylandDomCode(16), "KeyQ");
  assertEquals(getWin32DomCode(0x00100000n), "KeyQ");
  assertEquals(getDarwinDomCode(12), "KeyQ");
});

Deno.test("Win32 DOM code mapping normalizes extended-key lParam values", () => {
  assertEquals(getWin32DomCode(0x01480000n), "ArrowUp");
});

Deno.test("DOM code mappings preserve macOS keycode 0 as KeyA", () => {
  assertEquals(getDarwinDomCode(0), "KeyA");
});

Deno.test("DOM code mappings return Unidentified for unmapped identifiers", () => {
  assertEquals(getX11DomCode(0), "Unidentified");
  assertEquals(getWaylandDomCode(0), "Unidentified");
  assertEquals(getWin32DomCode(0), "Unidentified");
  assertEquals(getDarwinDomCode(0xffff), "Unidentified");
});

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
