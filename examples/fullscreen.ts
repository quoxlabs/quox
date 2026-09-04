import { openWindow } from "../packages/quox/mod.ts";

const window = await openWindow({
  title: "Fullscreen",
  body: "<h1>Browser-shaped fullscreen</h1>",
});

const button = window.document.createElement("button");
button.textContent = "Enter fullscreen";
button.onclick = async () => {
  if (window.document.fullscreenElement === null) {
    await window.document.documentElement.requestFullscreen();
  } else {
    await window.document.exitFullscreen();
  }
};
window.document.onfullscreenchange = () => {
  button.textContent = window.document.fullscreenElement === null ? "Enter fullscreen" : "Exit fullscreen";
};
window.document.body.appendChild(button);
