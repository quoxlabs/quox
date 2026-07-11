import { appKitWindowFrame, type ScreenFrame } from "./geometry.ts";

const primary: ScreenFrame = { x: 0, y: 0, width: 1920, height: 1080 };

Deno.test("Darwin maps primary-screen top-left window frames into AppKit coordinates", () => {
  assertEquals(
    [...appKitWindowFrame(100, 80, 640, 480, primary)],
    [100, 520, 640, 480],
  );
});

Deno.test("Darwin window coordinates cover displays on every side of the primary", () => {
  assertEquals(
    [...appKitWindowFrame(-1280, 56, 320, 200, primary)],
    [-1280, 824, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(1920, 40, 320, 200, primary)],
    [1920, 840, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(80, -900, 320, 200, primary)],
    [80, 1780, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(80, 1080, 320, 200, primary)],
    [80, -200, 320, 200],
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
