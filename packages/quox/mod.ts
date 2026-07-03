import { openWindow } from "./dom/window.ts";

export * from "./dom/document.ts";
export * from "./dom/node.ts";
export * from "./dom/window.ts";

if (import.meta.main) {
  const win = await openWindow({ body: "<h1>Hello from Blitz WASM</h1>" });
  console.log("Window open:", win);
}
