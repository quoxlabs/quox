import type { Library } from "../types.ts";
import { load } from "./mod.ts";
import { copyStraightRgbaToPremultipliedBgra } from "./shm_buffer.ts";

const WIDTH = 64;
const HEIGHT = 48;

Deno.test("Wayland SHM conversion premultiplies straight RGBA before channel swapping", () => {
  const source = Uint8Array.of(255, 0, 0, 128, 10, 20, 30, 255, 255, 128, 64, 0, 1, 2, 3, 128);
  const destination = new Uint8Array(source.byteLength);
  copyStraightRgbaToPremultipliedBgra(source, destination);
  assertBytes(destination, Uint8Array.of(0, 0, 128, 128, 30, 20, 10, 255, 0, 0, 0, 0, 2, 1, 1, 128));
});

Deno.test("Wayland negotiates SHM, maps on open, blits, and survives repeated lifecycles", () => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  pixels.fill(0xff);

  for (let iteration = 0; iteration < 2; iteration++) {
    const library = load();
    try {
      const window = library.openWindow(0, 0, WIDTH, HEIGHT);
      try {
        // Opening performs the bufferless configure handshake and presents the
        // initial black frame before any application-provided blit.
        drainEvents(library);
        window.setTitle(`winding Wayland smoke test ${iteration + 1}`);
        window.setImeCursorArea(4.25, 8.5, 12.75, 16.5);
        window.setImeSurroundingText("before after", 6, 6);
        window.setImeEnabled(true);
        // Submit faster than the compositor can release buffers. The bounded
        // pool must drop excess frames without rewriting committed storage.
        for (let frame = 0; frame < 5; frame++) {
          pixels[0] = frame;
          window.blit(pixels, WIDTH, HEIGHT);
        }
        drainEvents(library);
        window.setImeEnabled(false);
      } finally {
        window.close();
      }
    } finally {
      library.close();
    }
  }
});

function drainEvents(library: Library): void {
  for (let count = 0; count < 64 && library.event() !== undefined; count++);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) return;
  throw new Error(`Expected ${JSON.stringify([...expected])}, got ${JSON.stringify([...actual])}`);
}
