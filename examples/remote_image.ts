import { openWindow } from "../packages/quox/mod.ts";

// Run with:
//   deno --allow-ffi --allow-net=avatars.githubusercontent.com examples/remote_image.ts

const win = await openWindow({ width: 480, height: 480, title: "Remote resource fetch" });

// `win.Image` is the browser's `<img>` constructor bound to this window's document; quox has
// no global `Image` to hang it on. The argument sets the rendered width.
const img = new win.Image(200);
img.src = "https://avatars.githubusercontent.com/u/155552073?s=200&v=4";
img.alt = "quoxlabs avatar";

win.document.body.appendChild(img);

// Fetching is asynchronous: the window renders now and paints the image once it arrives,
// exactly as a browser would. An `<img src>` in markup works the same way, so
// `openWindow('<img src="https://…">')` or even local file references relative to the entry file
// `openWindow('<img src="./Surprised+Pikachu+(1)_(1).jpg')` fetches too.
