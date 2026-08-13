import {
  type ComposeAdapter,
  ComposeFeedResult,
  ComposeStatus,
  KeyRepeatController,
  translateKey,
  waylandKeyEditDisposition,
  type XkbKeyTranslator,
} from "./keyboard.ts";

function translator(keysym: number, text: string): XkbKeyTranslator {
  return {
    keysymForKeycode: () => keysym,
    utf8ForKeycode: () => text,
    utf8ForKeysym: () => text,
  };
}

Deno.test("Wayland keeps physical code separate from layout text", () => {
  assertEquals(translateKey(21, "press", translator(0x79, "y")).text, "y");
  assertEquals(translateKey(21, "press", translator(0x7a, "z")).text, "z");
  assertEquals(translateKey(44, "press", translator(0x79, "y")).text, "y");
  for (const text of ["ä", "ö", "ü", "ß", "@"]) {
    assertEquals(translateKey(16, "press", translator(text.codePointAt(0)!, text)).text, text);
  }
});

Deno.test("Wayland Compose keeps dead-key state private and commits once", () => {
  let step = 0;
  const compose: ComposeAdapter = {
    feed: () => ComposeFeedResult.ACCEPTED,
    status: () => step++ === 0 ? ComposeStatus.COMPOSING : ComposeStatus.COMPOSED,
    utf8: () => "é",
    reset() {},
  };
  const dead = translateKey(40, "press", translator(0xfe51, ""), compose);
  const complete = translateKey(18, "press", translator(0x65, "e"), compose);
  assertEquals({ text: dead.text, pending: dead.composePending }, { text: undefined, pending: true });
  assertEquals({ text: complete.text, pending: complete.composePending }, { text: "é", pending: false });
});

Deno.test("Wayland text ownership excludes Ctrl shortcuts but includes AltGr", () => {
  const plain = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
  assertEquals(waylandKeyEditDisposition("z", "z", false, plain), "text-input");
  assertEquals(waylandKeyEditDisposition("z", "z", false, { ...plain, ctrlKey: true, accelKey: true }), "key-default");
  assertEquals(
    waylandKeyEditDisposition("@", "@", false, { ...plain, ctrlKey: true, altKey: true, altGraphKey: true }),
    "text-input",
  );
  assertEquals(waylandKeyEditDisposition("Dead", undefined, true, plain), "text-input");
});

Deno.test("Wayland repeat preserves the active physical key", () => {
  let now = 0;
  const repeat = new KeyRepeatController(() => now);
  repeat.setRepeatInfo(20, 100);
  repeat.press(21, true);
  assertEquals(repeat.poll(), undefined);
  now = 100;
  assertEquals(repeat.poll(), 21);
  repeat.release(21);
  assertEquals(repeat.poll(), undefined);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`);
}
