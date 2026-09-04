import type { Library } from "../types.ts";
import { load } from "./mod.ts";

const WIDTH = 64;
const HEIGHT = 48;

Deno.test("Wayland opens, blits, toggles fullscreen, and survives repeated lifecycles", async () => {
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
        if (!window.fullscreenEnabled) throw new Error("Expected Wayland fullscreen support");
        window.setFullscreen(true);
        const entered = await waitForFullscreen(library, window, true);
        window.blit(new Uint8Array(entered.width * entered.height * 4), entered.width, entered.height);
        window.setFullscreen(false);
        const exited = await waitForFullscreen(library, window, false);
        window.blit(new Uint8Array(exited.width * exited.height * 4), exited.width, exited.height);
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

async function waitForFullscreen(
  library: Library,
  window: ReturnType<Library["openWindow"]>,
  expected: boolean,
): Promise<{ width: number; height: number }> {
  const deadline = Date.now() + 5_000;
  let width = WIDTH;
  let height = HEIGHT;
  while (Date.now() < deadline) {
    let event;
    while ((event = library.event()) !== undefined) {
      if (event.window !== window) continue;
      if (event.type === "resize") {
        width = event.width;
        height = event.height;
      }
      if (event.type === "fullscreenerror") throw new Error(event.message);
      if (event.type === "fullscreenchange" && event.fullscreen === expected) return { width, height };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for Wayland fullscreen=${expected}`);
}
