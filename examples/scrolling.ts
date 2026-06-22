import { renderRawHTML } from "../packages/quox/mod.ts";

const sections = Array.from({ length: 24 }, (_, index) => {
  const sectionNumber = index + 1;
  return `
    <section>
      <span class="eyebrow">Section ${sectionNumber.toString().padStart(2, "0")}</span>
      <h2>Scrollable content block ${sectionNumber}</h2>
      <p>
        This page intentionally has much more content than the window can show at once.
        Use the mouse wheel or trackpad to move through the rendered document.
      </p>
      <p>
        Each block has enough text and spacing to make vertical scrolling easy to test,
        including repainting, clipping, and layout continuity across the viewport edge.
      </p>
    </section>`;
}).join("");

const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f4f0e8;
      color: #17202a;
      font-family: Liberation Sans, Arial, sans-serif;
      line-height: 1.5;
    }

    header {
      padding: 40px 48px 28px;
      background: #17202a;
      color: #fbfaf7;
      border-bottom: 8px solid #d7663b;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 44px;
      line-height: 1.05;
    }

    header p {
      max-width: 680px;
      margin: 0;
      color: #d7e0e5;
      font-size: 18px;
    }

    main {
      width: 760px;
      max-width: 100%;
      padding: 28px 48px 72px;
    }

    section {
      margin: 0 0 24px;
      padding: 22px 24px;
      background: #ffffff;
      border: 1px solid #d7d0c3;
      border-left: 8px solid #2f7d80;
      border-radius: 6px;
    }

    section:nth-child(3n) {
      border-left-color: #d7663b;
    }

    section:nth-child(4n) {
      border-left-color: #6a65a8;
    }

    .eyebrow {
      display: block;
      margin-bottom: 8px;
      color: #68717a;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h2 {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.2;
    }

    p {
      margin: 0 0 10px;
      font-size: 16px;
    }

    p:last-child {
      margin-bottom: 0;
    }
  </style>
</head>
<body>
  <header>
    <h1>Scrolling Demo</h1>
    <p>
      A deliberately long document for checking wheel input, viewport clipping,
      and scroll position changes in the native window renderer.
    </p>
  </header>
  <main>
    ${sections}
  </main>
</body>
</html>`;

if (import.meta.main) {
  const window = await renderRawHTML(html, { width: 760, height: 520 });

  window.addEventListener((event) => {
    switch (event.type) {
      case "wheel":
        console.log(`Scroll delta: (${event.deltaX}, ${event.deltaY})`);
        break;
      case "resize":
        console.log(`Window resized to ${event.width}x${event.height}`);
        break;
      case "close":
        console.log("Window closed");
        break;
    }
  });
}
