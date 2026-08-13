import {
  AltGraphControlFilter,
  keyboardModifiers,
  translateLogicalKey,
  VK,
  win32KeyEditDisposition,
  WmCharDecoder,
} from "./input.ts";

const lParam = 0x15n << 16n;

function translated(text: string, state = new Uint8Array(256)) {
  return translateLogicalKey(0x59, lParam, state, {
    toUnicode: () => ({ result: text.length, text }),
  });
}

Deno.test("Win32 uses the active layout for logical key and text", () => {
  assertEquals(translated("y").key, "y");
  assertEquals(translated("z").key, "z");
  for (const text of ["ä", "ö", "ü", "ß", "@"]) assertEquals(translated(text).text, text);
});

Deno.test("Win32 dead key has no text and later WM_CHAR decodes the composed value", () => {
  const dead = translateLogicalKey(0xde, lParam, new Uint8Array(256), {
    toUnicode: () => ({ result: -1, text: "´" }),
  });
  assertEquals(dead, {
    key: "Dead",
    dead: true,
    modifiers: keyboardModifiers(new Uint8Array(256)),
  });
  const decoder = new WmCharDecoder();
  assertEquals(decoder.push("é".charCodeAt(0)), [{ text: "é", repeatCount: 1 }]);
});

Deno.test("Win32 AltGr keeps raw Control but excludes accelerator ownership", () => {
  const state = new Uint8Array(256);
  state[VK.CONTROL] = 0x80;
  state[VK.RMENU] = 0x80;
  const modifiers = keyboardModifiers(state);
  assertEquals(modifiers, {
    shiftKey: false,
    ctrlKey: true,
    altKey: true,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: true,
  });
  assertEquals(win32KeyEditDisposition("@", modifiers, "@", true), "text-input");
});

Deno.test("Win32 shortcuts and system-owned actions do not claim text input", () => {
  const plain = keyboardModifiers(new Uint8Array(256));
  assertEquals(win32KeyEditDisposition("ArrowLeft", plain, undefined, false), "key-default");
  assertEquals(win32KeyEditDisposition("Alt", plain, undefined, true), "platform");
  assertEquals(win32KeyEditDisposition("Dead", plain, undefined, false), "text-input");
});

Deno.test("Win32 filters the synthetic AltGr Control keydown", () => {
  const filter = new AltGraphControlFilter();
  assertEquals(
    filter.shouldSuppress(
      { phase: "down", virtualKey: VK.CONTROL, lParam: 0x1dn << 16n, timestamp: 10 },
      { phase: "down", virtualKey: VK.MENU, lParam: (0x38n << 16n) | (1n << 24n), timestamp: 10 },
    ),
    true,
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`);
}
