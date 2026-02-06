import { renderRawHTML } from "@quoxlabs/quox";

const html =
  "<!DOCTYPE html><html><body><h1>Hello, World! 😸</h1><p>Meow!</p></body></html>";

if (import.meta.main) {
  await renderRawHTML(html);
}
