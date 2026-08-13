import type { Library } from "../types.ts";
import { load } from "./mod.ts";

const WIDTH = 64;
const HEIGHT = 48;

Deno.test("Wayland opens, blits, and survives repeated lifecycles", () => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  pixels.fill(0xff);

  for (let iteration = 0; iteration < 2; iteration++) {
    const library = load();
    try {
      const window = library.openWindow(0, 0, WIDTH, HEIGHT);
      try {
        window.setTitle(`winding Wayland smoke test ${iteration + 1}`);
        window.blit(pixels, WIDTH, HEIGHT);
        drainEvents(library);
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
