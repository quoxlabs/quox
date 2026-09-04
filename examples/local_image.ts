import { openWindow } from "../packages/quox/mod.ts";

// The "byte buffer" is simply the raw bytes of an image file. `Deno.readFile`
// returns a `Uint8Array` of the encoded image — this is exactly what
// `setImageData` expects. quox decodes it internally, so no image-decoding
// library is needed on the TypeScript side.
const imageBytes = await Deno.readFile(
  new URL("./Surprised+Pikachu+(1)_(1).jpg", import.meta.url),
);

const win = await openWindow({ width: 480, height: 480, title: "Surprised Pikachu" });

// `win.Image` is a browser-style <img> constructor bound to this window. The
// optional argument sets the rendered width; without it the image's intrinsic
// pixel dimensions are used.
const img = new win.Image(440);
img.setImageData(imageBytes);

win.document.body.appendChild(img);
