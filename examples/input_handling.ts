import { openWindow, type QuoxKeyboardEvent } from "../packages/quox/mod.ts";

const body = `
<h1>Input Handling Demo</h1>
<p>Move the mouse, click, scroll, or type to see events in the console.</p>`;

function formatModifiers(event: QuoxKeyboardEvent): string {
  const modifiers = [
    event.shiftKey ? "Shift" : undefined,
    event.ctrlKey ? "Ctrl" : undefined,
    event.altKey ? "Alt" : undefined,
    event.metaKey ? "Meta" : undefined,
    event.accelKey ? "Accel" : undefined,
  ].filter((modifier) => modifier !== undefined);

  return modifiers.length ? ` [${modifiers.join("+")}]` : "";
}

if (import.meta.main) {
  const window = await openWindow({ body });

  window.addInputListener((event) => {
    switch (event.type) {
      case "mousemove": {
        const hit = window.document.nodeFromPoint(event.x, event.y);
        console.log(
          `Mouse moved to (${event.x.toFixed(1)}, ${event.y.toFixed(1)}); hit node: ${hit?.nodeId ?? "none"}`,
        );
        break;
      }
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
          `Key ${event.type === "keydown" ? "pressed" : "released"}: ${event.key} (${event.code})${
            formatModifiers(event)
          }`,
        );
        break;
      case "resize":
        console.log(`Window resized to ${event.width}x${event.height}`);
        break;
      case "close":
        console.log("Window closed");
        break;
      default:
        console.log("Other event:", event);
        break;
    }
  });
}
