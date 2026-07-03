import { openWindow } from "../packages/quox/mod.ts";

const body = `
<h1>Hello, World! 😸</h1>
<p>Meow!</p>`;

if (import.meta.main) {
  await openWindow(body);
}
