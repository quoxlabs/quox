/** @jsxImportSource @quoxlabs/jsx */
import { openWindow } from "../packages/quox/mod.ts";
import { mountRenderable } from "../packages/jsx/mod.ts";

const head = (
  <style>
    {`:root { --title-color: #2563eb; }`}
  </style>
);

const MyDescription = () => (
  <>
    <h2
      onClick={() => console.log("description clicked")}
      style={{ "--description-color": "red", color: "var(--description-color)" }}
    >
      My description. This is a test of JSX.
    </h2>
    <p>It is so cool that it works!</p>
  </>
);

const App = () => (
  <>
    <h1 style={{ color: "var(--title-color)" }}>JSX/TSX Demo</h1>
    <MyDescription />
  </>
);

if (import.meta.main) {
  const win = await openWindow();
  mountRenderable(win.document.head, head);
  mountRenderable(win.document.body, <App />);
}
