import { normalizeCommittedText } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";
import { XEventType } from "./ffi.ts";
import {
  fallbackLookupText,
  isAutoRepeatPair,
  isTopLevelFocusTransition,
  x11CommittedText,
  x11KeyEditDisposition,
  x11ModifierSnapshot,
} from "./input.ts";
import { applyPreeditChange, movePreeditCaret, preeditCursorByteOffset, XimCaretDirection } from "./xim_preedit.ts";
import { packRgbaPixels } from "./native_image.ts";
import { supportsX11Abi, validateX11Geometry } from "./mod.ts";
import { selectXimStyles } from "./xim.ts";

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
  assertEquals(normalizeCommittedText(""), undefined);
  assertEquals(normalizeCommittedText("\u0003"), undefined);
  assertEquals(normalizeCommittedText("line\nfeed"), undefined);
  assertEquals(normalizeCommittedText("ß"), "ß");
  assertEquals(normalizeCommittedText("👩‍💻"), "👩‍💻");
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
  };
  assertEquals(x11CommittedText("a", plain, false, false, false), "a");
  assertEquals(x11CommittedText("a", { ...plain, altKey: true }, false, false, false), undefined);
  assertEquals(x11CommittedText("a", { ...plain, metaKey: true }, false, false, false), undefined);
  assertEquals(x11CommittedText("@", { ...plain, altKey: true, altGraphKey: true }, false, false, false), "@");
  assertEquals(x11CommittedText("a", { ...plain, altKey: true }, true, false, false), "a");
});

Deno.test("XIM preedit draw applies scalar-indexed replacements", () => {
  const text = [..."aé文"];
  assertEquals(applyPreeditChange(text, 1, 1, [..."ßx"]), true);
  assertEquals(text.join(""), "aßx文");
  assertEquals(applyPreeditChange(text, 4, 0, []), true);
  assertEquals(applyPreeditChange(text, 5, 0, []), false);
  assertEquals(applyPreeditChange(text, -1, 1, []), false);
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
    maskByKeycode: new Map([[50, 1], [66, 2]]),
    toggleKeycodes: new Set([66]),
  };
  assertEquals(x11ModifierSnapshot(0, 50, true, mapping).shiftKey, true);
  assertEquals(x11ModifierSnapshot(1, 50, false, mapping).shiftKey, false);
  assertEquals(x11ModifierSnapshot(0, 66, true, mapping).capsLock, true);
  assertEquals(x11ModifierSnapshot(2, 66, false, mapping).capsLock, true);
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
