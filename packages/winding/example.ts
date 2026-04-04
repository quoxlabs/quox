import { load } from "./mod.ts";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

using library = load();
using _window = library.openWindow(100, 100, 300, 200);

while (true) {
  const event = library.event();
  if (event === undefined) {
    await sleep(10);
    continue;
  }

  console.log(event);

  // Close and quit if q is pressed
  if (event?.type === "keydown" && event.keycode === 24 /* q */) {
    break;
  }
}
