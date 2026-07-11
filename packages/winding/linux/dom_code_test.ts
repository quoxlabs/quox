import { domCodeFromEvdev, domCodeFromXkbName } from "./dom_code.ts";

Deno.test("Linux DOM codes cover evdev and physical XKB names", () => {
  assertEquals(domCodeFromEvdev(16), "KeyQ");
  assertEquals(domCodeFromXkbName("AD01"), "KeyQ");
  assertEquals(domCodeFromEvdev(105), "ArrowLeft");
  assertEquals(domCodeFromXkbName("LEFT"), "ArrowLeft");
  assertEquals(domCodeFromEvdev(183), "F13");
  assertEquals(domCodeFromXkbName("FK13"), "F13");
  assertEquals(domCodeFromEvdev(130), "Props");
  assertEquals(domCodeFromEvdev(228), "KeyboardBacklightToggle");
  assertEquals(domCodeFromEvdev(248), "MicrophoneMuteToggle");
  assertEquals(domCodeFromEvdev(633), "PrivacyScreenToggle");
});

Deno.test("Linux DOM codes reject unmapped and malformed identifiers", () => {
  assertEquals(domCodeFromEvdev(0), "Unidentified");
  assertEquals(domCodeFromXkbName("I999"), "Unidentified");
  assertEquals(domCodeFromEvdev(16.5), "Unidentified");
  assertEquals(domCodeFromXkbName("\0\0\0\0"), "Unidentified");
});

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
