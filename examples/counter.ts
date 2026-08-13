import { openWindow } from "../packages/quox/mod.ts";

const head = `
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: linen;
    color: midnightblue;
    text-align: center;
    font-family: sans-serif;
  }

  main {
    box-sizing: border-box;
    width: 420px;
    padding: 42px;
    background: ivory;
    border: 2px solid;
    border-radius: 18px;
  }

  h1 {
    margin: 0 0 20px;
    font-size: 22px;
  }

  output {
    display: block;
    margin-bottom: 28px;
    color: tomato;
    font-size: 112px;
    font-weight: bold;
    line-height: 1;
  }

  nav {
    display: flex;
    justify-content: center;
    gap: 18px;
  }

  button {
    width: 112px;
    height: 64px;
    border: 2px solid;
    border-radius: 12px;
    background: ivory;
    color: inherit;
    font-size: 36px;
    font-weight: bold;
    cursor: pointer;
  }

  button:hover {
    background: midnightblue;
    color: ivory;
  }
</style>`;

if (import.meta.main) {
  const window = await openWindow({
    width: 560,
    height: 480,
    title: "Counter",
    head,
  });

  const main = window.document.createElement("main");
  const heading = window.document.createElement("h1");
  const counter = window.document.createElement("output");
  const controls = window.document.createElement("nav");
  const decrement = window.document.createElement("button");
  const increment = window.document.createElement("button");

  heading.textContent = "Counter";
  decrement.textContent = "-";
  increment.textContent = "+";
  decrement.setAttribute("type", "button");
  decrement.setAttribute("aria-label", "Decrement counter");
  increment.setAttribute("type", "button");
  increment.setAttribute("aria-label", "Increment counter");

  let value = 0;
  const render = () => {
    counter.textContent = String(value);
  };

  decrement.onclick = () => {
    value -= 1;
    render();
  };
  increment.onclick = () => {
    value += 1;
    render();
  };

  render();
  controls.appendChild(decrement);
  controls.appendChild(increment);
  main.appendChild(heading);
  main.appendChild(counter);
  main.appendChild(controls);
  window.document.body.appendChild(main);
}
