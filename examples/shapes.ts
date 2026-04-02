import { renderRawHTML } from "../mod.ts";

const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #0d0d0d;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 32px;
      font-family: monospace;
    }

    /* ── Row 1: coloured circles ── */
    .circles {
      display: flex;
      gap: 24px;
      align-items: center;
    }

    .circle {
      border-radius: 50%;
      box-shadow: 0 0 24px 6px currentColor;
    }

    .c1 { width: 80px; height: 80px; background: #ff4b6e; color: #ff4b6e; }
    .c2 { width: 56px; height: 56px; background: #ffb347; color: #ffb347; }
    .c3 { width: 100px; height: 100px; background: #4be1ff; color: #4be1ff; }
    .c4 { width: 40px; height: 40px; background: #b44bff; color: #b44bff; }
    .c5 { width: 68px; height: 68px; background: #4bff91; color: #4bff91; }

    /* ── Row 2: gradient rectangles ── */
    .rects {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }

    .rect {
      width: 48px;
      border-radius: 4px 4px 0 0;
    }

    .r1 { height: 40px;  background: linear-gradient(to top, #ff4b6e, #ffb347); }
    .r2 { height: 80px;  background: linear-gradient(to top, #ffb347, #ffff6e); }
    .r3 { height: 120px; background: linear-gradient(to top, #4bff91, #4be1ff); }
    .r4 { height: 90px;  background: linear-gradient(to top, #4be1ff, #b44bff); }
    .r5 { height: 60px;  background: linear-gradient(to top, #b44bff, #ff4b6e); }
    .r6 { height: 110px; background: linear-gradient(to top, #ff4b6e, #4bff91); }
    .r7 { height: 50px;  background: linear-gradient(to top, #4be1ff, #ffb347); }

    /* ── Row 3: styled diff table ── */
    table {
      border-collapse: collapse;
      width: 480px;
    }

    td {
      padding: 3px 10px;
      font-size: 13px;
      letter-spacing: 0.04em;
      white-space: pre;
    }

    .ln {
      width: 32px;
      text-align: right;
      color: #444;
      border-right: 1px solid #222;
      padding-right: 8px;
      user-select: none;
    }

    .del { background: #3a0d17; color: #ff8099; }
    .del .ln { color: #7a2030; }
    .add { background: #0d2e1a; color: #4bff91; }
    .add .ln { color: #1a6637; }
    .ctx { background: #111;    color: #555; }
    .ctx .ln { color: #333; }

    /* ── Row 4: diamond grid ── */
    .diamonds {
      display: flex;
      gap: 8px;
    }

    .diamond {
      width: 36px;
      height: 36px;
      transform: rotate(45deg);
      border-radius: 4px;
    }

    .d1 { background: #ff4b6e; }
    .d2 { background: #ffb347; }
    .d3 { background: #ffff6e; }
    .d4 { background: #4bff91; }
    .d5 { background: #4be1ff; }
    .d6 { background: #b44bff; }
    .d7 { background: #ff4b6e; opacity: 0.5; }
  </style>
</head>
<body>

  <div class="circles">
    <div class="circle c1"></div>
    <div class="circle c2"></div>
    <div class="circle c3"></div>
    <div class="circle c4"></div>
    <div class="circle c5"></div>
  </div>

  <div class="rects">
    <div class="rect r1"></div>
    <div class="rect r2"></div>
    <div class="rect r3"></div>
    <div class="rect r4"></div>
    <div class="rect r5"></div>
    <div class="rect r6"></div>
    <div class="rect r7"></div>
  </div>

  <table>
    <tr class="ctx"><td class="ln">1</td><td>  background: #111;</td></tr>
    <tr class="ctx"><td class="ln">2</td><td>  border-radius: 4px;</td></tr>
    <tr class="del"><td class="ln">3</td><td>- color: #888;</td></tr>
    <tr class="add"><td class="ln">3</td><td>+ color: #4be1ff;</td></tr>
    <tr class="del"><td class="ln">4</td><td>- box-shadow: none;</td></tr>
    <tr class="add"><td class="ln">4</td><td>+ box-shadow: 0 0 12px #4be1ff88;</td></tr>
    <tr class="ctx"><td class="ln">5</td><td>  padding: 8px 16px;</td></tr>
    <tr class="ctx"><td class="ln">6</td><td>  display: flex;</td></tr>
  </table>

  <div class="diamonds">
    <div class="diamond d1"></div>
    <div class="diamond d2"></div>
    <div class="diamond d3"></div>
    <div class="diamond d4"></div>
    <div class="diamond d5"></div>
    <div class="diamond d6"></div>
    <div class="diamond d7"></div>
  </div>

</body>
</html>`;

if (import.meta.main) {
  await renderRawHTML(html, { width: 640, height: 560 });
}
