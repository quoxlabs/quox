import { keyLocationForKey, normalizeKeyboardText } from "../input/mod.ts";
import { keyLocationHintForKeysym, logicalKeyFromKeysym } from "../linux/mod.ts";
import { XEventType } from "./ffi.ts";
import {
  fallbackLookupText,
  isAutoRepeatPair,
  isTopLevelFocusTransition,
  x11CommittedText,
  x11KeyEditDisposition,
  X11ModifierKeyState,
  x11ModifierSnapshot,
  X11PointerButtonState,
  x11ScreenPosition,
} from "./input.ts";
import { decodeXimTextLayout } from "./xim_abi.ts";
import {
  applyPreeditChange,
  applyXimPreeditDraw,
  movePreeditCaret,
  preeditCursorByteOffset,
  XimCaretDirection,
} from "./xim_preedit.ts";
import { packRgbaPixels } from "./native_image.ts";
import { supportsX11Abi, validateX11Geometry } from "./mod.ts";
import { selectXimStyles, XimContext, type XimEvent, type XimManager } from "./xim.ts";

Deno.test("X11 key locations follow remapped KeySyms instead of evdev positions alone", () => {
  assertEquals(keyLocationForKey("Control", "ControlLeft"), 1);
  assertEquals(keyLocationForKey("a", "ControlLeft"), 0);
  assertEquals(keyLocationForKey("ArrowUp", "Numpad8"), 3);
  assertEquals(keyLocationForKey("Insert", "Numpad0"), 0);
  assertEquals(keyLocationForKey("Control", "KeyA", keyLocationHintForKeysym(0xffe3)), 1);
  assertEquals(keyLocationForKey("Meta", "KeyA", keyLocationHintForKeysym(0xffec)), 2);
});

Deno.test("X11 logical keys prefer layout-aware printable text", () => {
  assertEquals(logicalKeyFromKeysym(0x7a, "z"), "z");
  assertEquals(logicalKeyFromKeysym(0x010000e4, "ä"), "ä");
  assertEquals(logicalKeyFromKeysym(0x010020ac, "€"), "€");
});

Deno.test("X11 rejects layouts its native structure decoder cannot represent", () => {
  assertEquals(supportsX11Abi("linux", "x86_64", true), true);
  assertEquals(supportsX11Abi("linux", "aarch64", true), true);
  assertEquals(supportsX11Abi("linux", "x86_64", false), false);
  assertEquals(supportsX11Abi("linux", "x86", true), false);
  assertEquals(supportsX11Abi("freebsd", "x86_64", true), false);
});

Deno.test("X11 validates protocol geometry before native calls", () => {
  validateX11Geometry(-100, 20, 800, 600);
  assertThrows(() => validateX11Geometry(0, 0, 0, 1));
  assertThrows(() => validateX11Geometry(0, 0, 1.5, 1));
  assertThrows(() => validateX11Geometry(0x8000, 0, 1, 1));
  assertThrows(() => validateX11Geometry(0, 0, 0x10000, 1));
});

Deno.test("X11 logical keys use KeySym names for controls and named keys", () => {
  assertEquals(logicalKeyFromKeysym(0x63, "\u0003"), "c");
  assertEquals(logicalKeyFromKeysym(0xff0d, "\r"), "Enter");
  assertEquals(logicalKeyFromKeysym(0xff96), "ArrowLeft");
  assertEquals(logicalKeyFromKeysym(0xfe03), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0xfe51), "Dead");
  assertEquals(logicalKeyFromKeysym(0xffd5), "F24");
  assertEquals(logicalKeyFromKeysym(0x1008ff12), "AudioVolumeMute");
});

Deno.test("X11 committed text rejects shortcut control bytes", () => {
  assertEquals(normalizeKeyboardText(""), undefined);
  assertEquals(normalizeKeyboardText("\u0003"), undefined);
  assertEquals(normalizeKeyboardText("line\nfeed"), undefined);
  assertEquals(normalizeKeyboardText("ß"), "ß");
  assertEquals(normalizeKeyboardText("👩‍💻"), "👩‍💻");
});

Deno.test("X11 fallback lookup keeps controls out while retaining layout text", () => {
  assertEquals(fallbackLookupText(new Uint8Array([3]), "c"), undefined);
  assertEquals(fallbackLookupText(new TextEncoder().encode("€"), "e"), "€");
  assertEquals(fallbackLookupText(new Uint8Array([0xe4]), "ä"), "ä");
  assertEquals(fallbackLookupText(new Uint8Array(), "ß"), "ß");
});

Deno.test("X11 edit ownership includes dead keys and XIM semantic output", () => {
  assertEquals(x11KeyEditDisposition("c", false, false, false, false), "key-default");
  assertEquals(x11KeyEditDisposition("Dead", false, false, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("a", true, false, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("Unidentified", false, true, false, false), "text-input");
  assertEquals(x11KeyEditDisposition("Unidentified", false, false, false, true), "text-input");
});

Deno.test("X11 shortcut modifiers do not turn lookup text into edits", () => {
  const plain = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
    fnKey: false,
    numLock: false,
    scrollLock: false,
  };
  assertEquals(x11CommittedText("a", plain, false, false, false), "a");
  assertEquals(x11CommittedText("a", { ...plain, altKey: true }, false, false, false), undefined);
  assertEquals(x11CommittedText("a", { ...plain, metaKey: true }, false, false, false), undefined);
  assertEquals(x11CommittedText("@", { ...plain, altKey: true, altGraphKey: true }, false, false, false), "@");
  assertEquals(x11CommittedText("a", { ...plain, altKey: true }, true, false, false), "a");
});

Deno.test("XIM retains sources only inside their synchronous lookup batch", () => {
  const queued: XimEvent[] = [];
  const manager = {
    queue: (_window: bigint, event: XimEvent) => queued.push(event),
  } as unknown as XimManager;
  const context = new XimContext(manager, 1n);

  context.commit("asynchronous");
  context.beginLookup();
  assertEquals(context.claimDirectKeySource(() => 17), 17);
  assertEquals(context.claimDirectKeySource(() => 18), undefined);
  context.commit("direct");
  context.commit("second");
  assertDeepEquals(queued, [{ type: "ime", kind: "commit", text: "asynchronous" }]);
  context.finishLookup();
  assertDeepEquals(queued, [
    { type: "ime", kind: "commit", text: "asynchronous" },
    { type: "ime", kind: "commit", text: "direct", sourceKeyInputId: 17 },
    { type: "ime", kind: "commit", text: "second" },
  ]);

  context.beginLookup();
  context.noteCompositionCallback();
  assertEquals(context.claimDirectKeySource(() => 19), undefined);
  context.commit("composition");
  context.finishLookup();
  assertDeepEquals(queued.at(-1), { type: "ime", kind: "commit", text: "composition" });

  context.beginLookup();
  assertEquals(context.claimDirectKeySource(() => 20), 20);
  context.commit("");
  context.commit("after-empty");
  context.finishLookup();
  assertDeepEquals(queued.at(-1), { type: "ime", kind: "commit", text: "after-empty" });
});

Deno.test("XIM preedit draw applies scalar-indexed replacements", () => {
  const text = [..."aé文"];
  assertEquals(applyPreeditChange(text, 1, 1, [..."ßx"]), true);
  assertEquals(text.join(""), "aßx文");
  assertEquals(applyPreeditChange(text, 4, 0, []), true);
  assertEquals(applyPreeditChange(text, 5, 0, []), false);
  assertEquals(applyPreeditChange(text, -1, 1, []), false);
});

Deno.test("XIM feedback-only preedit draws preserve text and publish only caret changes", () => {
  const text = [..."aé文"];
  assertDeepEquals(
    applyXimPreeditDraw(text, 1, 2, 1, 99, { kind: "feedback", length: 2 }),
    { cursor: 2, emit: true },
  );
  assertEquals(text.join(""), "aé文");
  assertDeepEquals(
    applyXimPreeditDraw(text, 2, 2, 0, 99, { kind: "feedback", length: 3 }),
    { cursor: 2, emit: false },
  );
  assertEquals(text.join(""), "aé文");
  assertEquals(applyXimPreeditDraw(text, 2, 2, 2, 0, { kind: "feedback", length: 2 }), undefined);

  assertDeepEquals(
    applyXimPreeditDraw(text, 2, 2, 1, 1, { kind: "text", characters: [..."ßx"] }),
    { cursor: 2, emit: true },
  );
  assertEquals(text.join(""), "aßx文");
  assertDeepEquals(
    applyXimPreeditDraw(text, 2, 1, 1, 2, { kind: "delete" }),
    { cursor: 1, emit: true },
  );
  assertEquals(text.join(""), "a文");
});

Deno.test("XIMText decoding distinguishes feedback-only updates from malformed storage", () => {
  const offsets: number[] = [];
  const decode = (feedbackAddress: bigint) =>
    decodeXimTextLayout(
      (offset) => {
        offsets.push(offset);
        return 2;
      },
      (offset) => {
        offsets.push(offset);
        return 0;
      },
      (offset) => {
        offsets.push(offset);
        return offset === 8 ? feedbackAddress : 0n;
      },
      () => {
        throw new Error("Feedback-only XIMText must not decode string storage");
      },
    );
  assertDeepEquals(decode(0x1000n), { kind: "feedback", length: 2 });
  assertDeepEquals(offsets, [0, 8, 16, 24]);
  assertEquals(decode(0n), undefined);

  const decodedText = decodeXimTextLayout(
    () => 2,
    () => 1,
    (offset) => offset === 24 ? 0x2000n : 0n,
    (address, isWide, length) => {
      assertEquals(address, 0x2000n);
      assertEquals(isWide, true);
      assertEquals(length, 2);
      return [..."é文"];
    },
  );
  assertDeepEquals(decodedText, { kind: "text", characters: [..."é文"] });
});

Deno.test("XIM cursor scalar indices convert to UTF-8 byte offsets", () => {
  const text = [..."aé文"];
  assertEquals(preeditCursorByteOffset(text, 0), 0);
  assertEquals(preeditCursorByteOffset(text, 1), 1);
  assertEquals(preeditCursorByteOffset(text, 2), 3);
  assertEquals(preeditCursorByteOffset(text, 3), 6);
});

Deno.test("XIM caret directions update the one-line preedit synchronously", () => {
  const text = [..."one two"];
  assertEquals(movePreeditCaret(text, 0, XimCaretDirection.ForwardChar, 0), 1);
  assertEquals(movePreeditCaret(text, 1, XimCaretDirection.BackwardChar, 0), 0);
  assertEquals(movePreeditCaret(text, 0, XimCaretDirection.ForwardWord, 0), 4);
  assertEquals(movePreeditCaret(text, 7, XimCaretDirection.BackwardWord, 0), 4);
  assertEquals(movePreeditCaret(text, 4, XimCaretDirection.LineStart, 0), 0);
  assertEquals(movePreeditCaret(text, 4, XimCaretDirection.LineEnd, 0), 7);
  assertEquals(movePreeditCaret(text, 0, XimCaretDirection.AbsolutePosition, 99), 7);
});

Deno.test("XIM style selection accepts independent status choices", () => {
  const callbackWithStatusNone = 0x0002n | 0x0800n;
  const noneWithStatusNothing = 0x0010n | 0x0400n;
  assertEquals(
    selectXimStyles([callbackWithStatusNone, noneWithStatusNothing], true)?.preedit,
    callbackWithStatusNone,
  );
  assertEquals(
    selectXimStyles([callbackWithStatusNone, noneWithStatusNothing], true)?.none,
    noneWithStatusNothing,
  );
  assertEquals(selectXimStyles([callbackWithStatusNone], true)?.none, undefined);
});

Deno.test("X11 repeat detection requires an identical adjacent press", () => {
  const releaseBuffer = new ArrayBuffer(192);
  const pressBuffer = new ArrayBuffer(192);
  const release = new DataView(releaseBuffer);
  const press = new DataView(pressBuffer);
  release.setInt32(0, XEventType.KeyRelease, true);
  release.setBigUint64(32, 99n, true);
  release.setBigUint64(56, 1234n, true);
  release.setUint32(84, 24, true);
  press.setInt32(0, XEventType.KeyPress, true);
  press.setBigUint64(32, 99n, true);
  press.setBigUint64(56, 1234n, true);
  press.setUint32(84, 24, true);

  assertEquals(isAutoRepeatPair(release, press), true);
  press.setBigUint64(56, 1235n, true);
  assertEquals(isAutoRepeatPair(release, press), false);
  release.setBigUint64(56, 0n, true);
  press.setBigUint64(56, 0n, true);
  assertEquals(isAutoRepeatPair(release, press), false);
});

Deno.test("X11 focus includes grabbed moves but excludes descendants", () => {
  assertEquals(isTopLevelFocusTransition(0, 0), true);
  assertEquals(isTopLevelFocusTransition(3, 0), true);
  assertEquals(isTopLevelFocusTransition(1, 0), false);
  assertEquals(isTopLevelFocusTransition(0, 2), false);
});

Deno.test("X11 modifier snapshots apply the reported transition", () => {
  const mapping = {
    shiftMask: 1,
    controlMask: 4,
    altMask: 8,
    metaMask: 64,
    capsLockMask: 2,
    altGraphMask: 128,
    fnMask: 16,
    numLockMask: 32,
    scrollLockMask: 64,
    maskByKeycode: new Map([[50, 1], [66, 2], [77, 32], [78, 64], [79, 16]]),
    toggleKeycodes: new Set([66, 77, 78]),
  };
  assertEquals(x11ModifierSnapshot(0, 50, true, mapping).shiftKey, true);
  assertEquals(x11ModifierSnapshot(1, 50, false, mapping).shiftKey, false);
  assertEquals(x11ModifierSnapshot(0, 66, true, mapping).capsLock, true);
  assertEquals(x11ModifierSnapshot(2, 66, false, mapping).capsLock, true);
  assertEquals(x11ModifierSnapshot(0, 77, true, mapping).numLock, true);
  assertEquals(x11ModifierSnapshot(32, 77, false, mapping).numLock, true);
  assertEquals(x11ModifierSnapshot(0, 78, true, mapping).scrollLock, true);
  assertEquals(x11ModifierSnapshot(0, 79, true, mapping).fnKey, true);
  assertEquals(x11ModifierSnapshot(16, 79, false, mapping).fnKey, false);
});

Deno.test("X11 modifier chords remain active until their final side is released", () => {
  const groups = [
    { mask: 1, left: 50, right: 62, field: "shiftKey" },
    { mask: 4, left: 37, right: 105, field: "ctrlKey" },
    { mask: 8, left: 64, right: 108, field: "altKey" },
    { mask: 64, left: 133, right: 134, field: "metaKey" },
    { mask: 128, left: 92, right: 93, field: "altGraphKey" },
  ] as const;
  const mapping = {
    shiftMask: 1,
    controlMask: 4,
    altMask: 8,
    metaMask: 64,
    capsLockMask: 0,
    altGraphMask: 128,
    fnMask: 0,
    numLockMask: 0,
    scrollLockMask: 0,
    maskByKeycode: new Map(groups.flatMap(({ mask, left, right }) => [[left, mask], [right, mask]])),
    toggleKeycodes: new Set<number>(),
  };

  for (const { mask, left, right, field } of groups) {
    const modifiers = new X11ModifierKeyState();
    assertEquals(modifiers.snapshot(0, left, true, mapping)[field], true);
    assertEquals(modifiers.snapshot(mask, right, true, mapping)[field], true);
    assertEquals(modifiers.snapshot(mask, left, false, mapping)[field], true);
    assertEquals(modifiers.snapshot(mask, right, false, mapping)[field], false);
  }
});

Deno.test("X11 pointer snapshots retain extended-button chords", () => {
  const buttons = new X11PointerButtonState();

  assertEquals(buttons.snapshot(0, "back", true), 8);
  assertEquals(buttons.snapshot(0), 8);
  assertEquals(buttons.snapshot(0, "left", true), 9);
  assertEquals(buttons.snapshot(1 << 8), 9);
  assertEquals(buttons.snapshot(1 << 8, "forward", true), 25);
  assertEquals(buttons.snapshot(1 << 8), 25);
});

Deno.test("X11 pointer snapshots remove only the released extended button", () => {
  const buttons = new X11PointerButtonState();
  buttons.snapshot(0, "back", true);
  buttons.snapshot(0, "forward", true);

  assertEquals(buttons.snapshot(1 << 10, "back", false), 18);
  assertEquals(buttons.snapshot(1 << 10), 18);
  assertEquals(buttons.snapshot(1 << 10, "forward", false), 2);
  assertEquals(buttons.snapshot(0), 0);
});

Deno.test("X11 pointer reset discards retained extended buttons after an interrupted grab", () => {
  const buttons = new X11PointerButtonState();
  buttons.snapshot(0, "back", true);
  buttons.snapshot(0, "forward", true);

  const canceledButtons = buttons.snapshot(0);
  buttons.reset();

  assertEquals(canceledButtons, 24);
  assertEquals(buttons.snapshot(0), 0);
  assertEquals(buttons.snapshot(1 << 8), 1);
});

Deno.test("X11 pointer state distinguishes a normal final release from grab interruption", () => {
  const buttons = new X11PointerButtonState();
  assertEquals(buttons.snapshot(0, "left", true), 1);
  assertEquals(buttons.buttons, 1);

  // XButtonRelease.state describes the state before the transition. Applying
  // the changed button must still leave the retained post-transition chord empty.
  assertEquals(buttons.snapshot(1 << 8, "left", false), 0);
  assertEquals(buttons.buttons, 0);
});

Deno.test("X11 pointer snapshots expose root coordinates only on the same screen", () => {
  const bytes = new ArrayBuffer(96);
  const event = new DataView(bytes);
  event.setInt32(72, -320, true);
  event.setInt32(76, 1440, true);
  event.setInt32(88, 1, true);
  assertDeepEquals(x11ScreenPosition(event), { screenX: -320, screenY: 1440 });

  event.setInt32(88, 0, true);
  assertDeepEquals(x11ScreenPosition(event), { screenX: null, screenY: null });
});

Deno.test("X11 pixels follow the server visual masks and byte order", () => {
  const rgba = new Uint8Array([255, 128, 0, 7]);
  const bgrx = new Uint8Array(4);
  packRgbaPixels(rgba, bgrx, 1, 1, {
    byteOrder: 0,
    bytesPerLine: 4,
    bitsPerPixel: 32,
    redMask: 0xff0000n,
    greenMask: 0xff00n,
    blueMask: 0xffn,
  });
  assertArrayEquals(bgrx, [0, 128, 255, 0]);

  const rgb565 = new Uint8Array(2);
  packRgbaPixels(rgba, rgb565, 1, 1, {
    byteOrder: 1,
    bytesPerLine: 2,
    bitsPerPixel: 16,
    redMask: 0xf800n,
    greenMask: 0x07e0n,
    blueMask: 0x001fn,
  });
  assertArrayEquals(rgb565, [0xfc, 0x00]);
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertDeepEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertArrayEquals(actual: Uint8Array, expected: readonly number[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
  }
}

function assertThrows(callback: () => void): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("Expected callback to throw");
}
