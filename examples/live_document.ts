import { openWindow } from "../packages/quox/mod.ts";

if (import.meta.main) {
  const win = await openWindow({ width: 720, height: 420 });
  const { document } = win;

  const style = document.createElement("style");
  style.textContent = `
    body {
      margin: 0;
      padding: 36px 44px;
      background: #f7f7f3;
      color: #171b20;
      font-family: Liberation Sans, Arial, sans-serif;
      line-height: 1.5;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 34px;
    }

    p {
      max-width: 560px;
      margin: 0 0 18px;
      font-size: 17px;
    }

    .created-from-dom {
      padding: 10px 16px;
      border: 0;
      border-radius: 4px;
      background: #2f6f73;
      color: white;
      font-size: 15px;
    }
  `;
  document.head.appendChild(style);

  const title = document.createElement("h1");
  title.textContent = "Live document";

  const copy = document.createElement("p");
  copy.textContent =
    "This window started blank. Its contents were created through win.document and Blitz DocumentMutator.";

  const button = document.createElement("button");
  button.setAttribute("class", "created-from-dom");
  button.textContent = "Created from DOM APIs";

  document.body.appendChild(title);
  document.body.appendChild(copy);
  document.body.appendChild(button);
}
