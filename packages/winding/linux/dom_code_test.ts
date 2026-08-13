import { domCodeFromEvdev, domCodeFromX11 } from "./dom_code.ts";

Deno.test("Linux DOM codes share one evdev mapping across Wayland and X11", () => {
  assertEquals(domCodeFromEvdev(16), "KeyQ");
  assertEquals(domCodeFromX11(24), "KeyQ");
  assertEquals(domCodeFromEvdev(105), "ArrowLeft");
  assertEquals(domCodeFromX11(113), "ArrowLeft");
  assertEquals(domCodeFromEvdev(183), "F13");
  assertEquals(domCodeFromX11(191), "F13");
  assertEquals(domCodeFromEvdev(130), "Props");
  assertEquals(domCodeFromEvdev(228), "KeyboardBacklightToggle");
  assertEquals(domCodeFromEvdev(248), "MicrophoneMuteToggle");
  assertEquals(domCodeFromEvdev(633), "PrivacyScreenToggle");
});

Deno.test("Linux DOM codes reject unmapped and malformed identifiers", () => {
  assertEquals(domCodeFromEvdev(0), "Unidentified");
  assertEquals(domCodeFromX11(0), "Unidentified");
  assertEquals(domCodeFromEvdev(16.5), "Unidentified");
  assertEquals(domCodeFromX11(Number.NaN), "Unidentified");
});

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
