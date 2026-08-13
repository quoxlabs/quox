import { openWindow, setElementFunctionProp } from "../packages/quox/mod.ts";

const head = `
<style>
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f3efe6;
    color: #17202a;
    font-family: Liberation Sans, Arial, sans-serif;
  }

  main {
    width: 420px;
    padding: 42px;
    text-align: center;
    background: #fffdf8;
    border: 2px solid #17202a;
    border-radius: 18px;
  }

  h1 {
    margin: 0 0 20px;
    font-size: 22px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  output {
    display: block;
    margin: 0 0 28px;
    font-size: 112px;
    font-weight: 700;
    line-height: 1;
    color: #d44f2a;
  }

  nav {
    display: flex;
    justify-content: center;
    gap: 18px;
  }

  button {
    width: 112px;
    height: 64px;
    border: 2px solid #17202a;
    border-radius: 12px;
    background: #fffdf8;
    color: #17202a;
    font-size: 36px;
    font-weight: 700;
    cursor: pointer;
  }

  button:hover {
    background: #17202a;
    color: #fffdf8;
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

  setElementFunctionProp(decrement, "onClick", () => {
    value -= 1;
    render();
  });
  setElementFunctionProp(increment, "onClick", () => {
    value += 1;
    render();
  });

  render();
  controls.appendChild(decrement);
  controls.appendChild(increment);
  main.appendChild(heading);
  main.appendChild(counter);
  main.appendChild(controls);
  window.document.body.appendChild(main);
}
