/** @jsxImportSource npm:preact@10.29.1 */
import { renderRawHTML } from "../packages/quox/mod.ts";
import { render } from "npm:preact-render-to-string@6.6.7";

const MyDescription = () => {
  return (
    <>
      <h2 style={{ color: "red" }}>
        My description. This is a test of JSX.
      </h2>
      <p>I'm really surprised that it works.</p>
    </>
  );
};

function App() {
  return (
    <html>
      <body>
        <h1>JSX/TSX Demo</h1>
        <MyDescription />
      </body>
    </html>
  );
}

if (import.meta.main) {
  const html = `<!DOCTYPE html>${render(<App />)}`;

  await renderRawHTML(html);
}
