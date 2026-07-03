import { openWindow } from "../packages/quox/mod.ts";

const head = `
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #111827;
        color: #f9fafb;
        font-family: Liberation Sans, Arial, sans-serif;
      }

      main {
        width: 420px;
        padding: 32px;
        border: 1px solid #374151;
        border-radius: 8px;
        background: #1f2937;
      }

      h1 {
        margin: 0 0 12px;
        font-size: 32px;
        line-height: 1.1;
      }

      p {
        margin: 0;
        color: #cbd5e1;
        font-size: 18px;
      }

      .warm {
        color: #fbbf24;
      }

      .cool {
        color: #38bdf8;
      }
    </style>
  `;

const win = await openWindow({ width: 640, height: 360, head });

const main = win.document.createElement("main");
const title = win.document.createElement("h1");
const status = win.document.createElement("p");

title.textContent = "Live document";
title.setAttribute("class", "warm");
status.textContent = "Tick 0";

main.appendChild(title);
main.appendChild(status);
win.document.body.appendChild(main);

let tick = 0;
setInterval(() => {
  tick += 1;
  title.textContent = tick % 2 === 0 ? "Live document" : "Mutated document";
  title.setAttribute("class", tick % 2 === 0 ? "warm" : "cool");
  status.textContent = `Tick ${tick}`;
}, 700);
