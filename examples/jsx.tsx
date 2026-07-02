/** @jsxImportSource npm:preact@10.29.1 */
import { openWindow } from "../packages/quox/mod.ts";

const MyDescription = () => (
  <>
    <h2 style={{ color: "red" }}>
      My description. This is a test of JSX.
    </h2>
    <p>It is so cool that it works!</p>
  </>
);

const App = () => (
  <>
    <h1>JSX/TSX Demo</h1>
    <MyDescription />
  </>
);

if (import.meta.main) {
  await openWindow({ body: <App /> });
}
