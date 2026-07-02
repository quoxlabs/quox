import { openWindow } from "../packages/quox/mod.ts";

const html = `
<!DOCTYPE html>
<html>
  <body>
    <h1>Hello, World! 😸</h1>
    <p>Meow!</p>
  </body>
</html>`;

if (import.meta.main) {
  await openWindow({ innerHTML: html });
}
