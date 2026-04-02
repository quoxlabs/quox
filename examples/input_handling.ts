import { renderRawHTML } from "../mod.ts";

const html = `
<!DOCTYPE html>
<html>
  <body>
    <h1>Input Handling Demo</h1>
    <p>Move the mouse, click, scroll, or type to see events in the console.</p>
  </body>
</html>`;

if (import.meta.main) {
  const window = await renderRawHTML(html);

  window.addEventListener((event) => {
    switch (event.type) {
      case "mousemove":
        console.log(
          `Mouse moved to (${event.x.toFixed(1)}, ${event.y.toFixed(1)})`,
        );
        break;
      case "mousedown":
      case "mouseup":
        console.log(
          `Mouse button ${event.button} ${event.type === "mousedown" ? "pressed" : "released"}`,
        );
        break;
      case "wheel":
        console.log(`Scroll delta: (${event.deltaX}, ${event.deltaY})`);
        break;
      case "keydown":
      case "keyup":
        console.log(
          `Key ${event.type === "keydown" ? "pressed" : "released"}: ${event.key} (${event.code})`,
        );
        break;
      case "resize":
        console.log(`Window resized to ${event.width}x${event.height}`);
        break;
      case "close":
        console.log("Window closed");
        break;
      default:
        console.log("Other even thrown:", event);
        break;
    }
  });
}
