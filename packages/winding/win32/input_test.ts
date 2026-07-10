import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import {
  AltGraphControlFilter,
  decodeKeyLParam,
  isCommitText,
  keyboardModifiers,
  keyboardStateForTranslation,
  logicalKeyFromVirtualKey,
  repeatedWmCharText,
  ResultEchoSuppressor,
  TO_UNICODE_NO_STATE_CHANGE,
  translateLogicalKey,
  VK,
  win32KeyEditDisposition,
  win32KeyIdentity,
  WmCharDecoder,
} from "./input.ts";
import {
  CFS_EXCLUDE,
  CFS_POINT,
  encodeCandidateForm,
  encodeCompositionForm,
  encodeImeCharPosition,
  insertCompositionCharacter,
  readImmUtf16,
  utf16CursorRangeToUtf8,
  withImeContext,
} from "./imm.ts";
import {
  keyLocationForCode,
  normalizeImeCursorArea,
  PressedLogicalKeyCache,
  utf16IndexToUtf8Offset,
  utf8OffsetToUtf16Index,
} from "../input/mod.ts";

Deno.test("Win32 key lParam decoding preserves repeat, scan, extended, context, and transition fields", () => {
  const lParam = makeKeyLParam(0x38, {
    repeatCount: 7,
    extended: true,
    context: true,
    previous: true,
    transition: true,
  });
  assertEquals(decodeKeyLParam(lParam), {
    repeatCount: 7,
    scanCode: 0x38,
    extendedScanCode: 0xe038,
    isExtended: true,
    contextCode: true,
    previousKeyState: true,
    transitionState: true,
    isRepeat: true,
  });
  assertEquals(decodeKeyLParam(makeKeyLParam(0x1e)).isRepeat, false);
});

Deno.test("physical codes determine DOM key locations", () => {
  assertEquals(keyLocationForCode("NumpadEnter"), 3);
  assertEquals(keyLocationForCode("ShiftLeft"), 1);
  assertEquals(keyLocationForCode("AltRight"), 2);
  assertEquals(keyLocationForCode("KeyA"), 0);
});

Deno.test("logical virtual-key mapping covers named, function, translated, and unknown keys", () => {
  assertEquals(logicalKeyFromVirtualKey(VK.BACK, "\b"), "Backspace");
  assertEquals(logicalKeyFromVirtualKey(VK.F1 + 23), "F24");
  assertEquals(logicalKeyFromVirtualKey(0x59, "z"), "z");
  assertEquals(logicalKeyFromVirtualKey(0xba, "ö"), "ö");
  assertEquals(logicalKeyFromVirtualKey(VK.PACKET), "Unidentified");
});

Deno.test("injected ToUnicode translation follows the active layout and uses the non-mutating flag", () => {
  const state = new Uint8Array(256);
  const translated = translateLogicalKey(0x59, makeKeyLParam(0x15), state, {
    toUnicode(virtualKey, scanCode, keyboardState, flags) {
      assertEquals(virtualKey, 0x59);
      assertEquals(scanCode, 0x15);
      assertEquals(keyboardState, state);
      assertEquals(flags, TO_UNICODE_NO_STATE_CHANGE);
      return { result: 1, text: "z" };
    },
  });
  assertEquals(translated, {
    key: "z",
    text: "z",
    dead: false,
    modifiers: {
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      accelKey: false,
      capsLock: false,
      altGraphKey: false,
    },
  });
});

Deno.test("ToUnicode dead and failed translations degrade to semantic keys", () => {
  const state = new Uint8Array(256);
  assertEquals(
    translateLogicalKey(0xde, makeKeyLParam(0x28), state, {
      toUnicode: () => ({ result: -1, text: "´" }),
    }).key,
    "Dead",
  );
  assertEquals(
    translateLogicalKey(VK.LEFT, makeKeyLParam(0x4b, { extended: true }), state, {
      toUnicode: () => ({ result: 0, text: "" }),
    }).key,
    "ArrowLeft",
  );
  assertEquals(
    translateLogicalKey(VK.ESCAPE, makeKeyLParam(1), state, {
      toUnicode: () => {
        throw new Error("layout disappeared");
      },
    }).key,
    "Escape",
  );
});

Deno.test("ordinary Ctrl shortcuts translate without Ctrl while retaining event modifiers", () => {
  const state = keyboardState([[VK.CONTROL, 0x80], [VK.LCONTROL, 0x80]]);
  const translated = translateLogicalKey(0x43, makeKeyLParam(0x2e), state, {
    toUnicode(_virtualKey, _scanCode, translatedState) {
      assertEquals(translatedState[VK.CONTROL] & 0x80, 0);
      assertEquals(translatedState[VK.LCONTROL] & 0x80, 0);
      return { result: 1, text: "c" };
    },
  });
  assertEquals(translated.key, "c");
  assertEquals(translated.modifiers.ctrlKey, true);
  assertEquals(translated.modifiers.accelKey, true);
  assertEquals(translated.modifiers.altGraphKey, false);
});

Deno.test("AltGr preserves Control and right Alt for layout translation without becoming an accelerator", () => {
  const state = keyboardState([
    [VK.CONTROL, 0x80],
    [VK.LCONTROL, 0x80],
    [VK.MENU, 0x80],
    [VK.RMENU, 0x80],
  ]);
  const modifiers = keyboardModifiers(state);
  assertEquals(modifiers.ctrlKey, true);
  assertEquals(modifiers.altKey, true);
  assertEquals(modifiers.altGraphKey, true);
  assertEquals(modifiers.accelKey, false);
  assertEquals(keyboardStateForTranslation(state), state);

  const translated = translateLogicalKey(0x51, makeKeyLParam(0x10), state, {
    toUnicode(_virtualKey, _scanCode, translatedState) {
      assert(translatedState[VK.CONTROL] >= 0x80);
      assert(translatedState[VK.RMENU] >= 0x80);
      return { result: 1, text: "@" };
    },
  });
  assertEquals(translated.key, "@");
  assertEquals(translated.modifiers.altGraphKey, true);
});

Deno.test("Win32 edit ownership follows WM_SYSKEYDOWN rather than inferred Alt state", () => {
  const ordinary = {
    shiftKey: false,
    ctrlKey: false,
    altKey: true,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
  assertEquals(win32KeyEditDisposition("F10", false, ordinary, undefined, true), "platform");
  assertEquals(win32KeyEditDisposition("ArrowLeft", false, ordinary, undefined, false), "key-default");
  assertEquals(win32KeyEditDisposition("x", false, ordinary, "x", false), "text-input");

  const altGraph = { ...ordinary, ctrlKey: true, altGraphKey: true };
  assertEquals(win32KeyEditDisposition("@", false, altGraph, "@", true), "text-input");
});

Deno.test("AltGr's paired fake Control transitions are suppressed", () => {
  const filter = new AltGraphControlFilter();
  const controlDown = {
    phase: "down" as const,
    virtualKey: VK.CONTROL,
    lParam: makeKeyLParam(0x1d),
    timestamp: 10,
  };
  const rightAltDown = {
    phase: "down" as const,
    virtualKey: VK.MENU,
    lParam: makeKeyLParam(0x38, { extended: true }),
    timestamp: 10,
  };
  assertEquals(filter.shouldSuppress(controlDown, rightAltDown), true);
  assertEquals(filter.shouldSuppress({ ...controlDown, phase: "up" }), true);
  assertEquals(filter.shouldSuppress(controlDown, { ...rightAltDown, timestamp: 11 }), false);
  assertEquals(filter.shouldSuppress(controlDown), false);
});

Deno.test("logical key cache resolves keyup using the keydown identity", () => {
  const cache = new PressedLogicalKeyCache<string>();
  const down = makeKeyLParam(0x15);
  const repeat = makeKeyLParam(0x15, { previous: true, repeatCount: 5 });
  const up = makeKeyLParam(0x15, { previous: true, transition: true });

  assertEquals(cache.press(win32KeyIdentity(0x59, down), "z"), "z");
  assertEquals(cache.press(win32KeyIdentity(0x59, repeat), "y"), "z");
  assertEquals(cache.release(win32KeyIdentity(0x59, up)), "z");
  assertEquals(cache.size, 0);
});

Deno.test("WM_CHAR decoder filters controls and applies repeat after scalar decoding", () => {
  const decoder = new WmCharDecoder();
  assertEquals(decoder.push("A".charCodeAt(0), 3), [{ text: "A", repeatCount: 3 }]);
  assertEquals(decoder.push(0x08, 10), []);
  assertEquals(decoder.push(0x09), []);
  assertEquals(decoder.push(0x0d), []);
  assertEquals(decoder.push(0x1b), []);
  assertEquals(decoder.push(0x7f), []);
  assertEquals(repeatedWmCharText({ text: "é", repeatCount: 3 }), "ééé");
  assertEquals(decoder.push(0x85), []);
  assertEquals(isCommitText("\u0085"), false);
});

Deno.test("WM_CHAR decoder assembles surrogate pairs and recovers malformed UTF-16", () => {
  const decoder = new WmCharDecoder();
  assertEquals(decoder.push(0xd83d, 2), []);
  assertEquals(decoder.push(0xde42, 2), [{ text: "🙂", repeatCount: 2 }]);

  assertEquals(decoder.push(0xd800), []);
  assertEquals(decoder.push("x".charCodeAt(0)), [
    { text: "�", repeatCount: 1 },
    { text: "x", repeatCount: 1 },
  ]);
  assertEquals(decoder.push(0xdc00, 4), [{ text: "�", repeatCount: 4 }]);
  assertEquals(decoder.push(0xdbff, 2), []);
  assertEquals(decoder.flush(), [{ text: "�", repeatCount: 2 }]);
  assertEquals(decoder.flush(), []);
});

Deno.test("mismatched surrogate repeat counts preserve valid pairs and recover leftovers", () => {
  const decoder = new WmCharDecoder();
  decoder.push(0xd83d, 3);
  assertEquals(decoder.push(0xde42, 1), [
    { text: "🙂", repeatCount: 1 },
    { text: "�", repeatCount: 2 },
  ]);
});

Deno.test("IMM UTF-16 cursor positions convert to UTF-8 byte offsets only at scalar boundaries", () => {
  const text = "a🙂é日";
  assertEquals(utf16IndexToUtf8Offset(text, 0), 0);
  assertEquals(utf16IndexToUtf8Offset(text, 1), 1);
  assertEquals(utf16IndexToUtf8Offset(text, 2), undefined);
  assertEquals(utf16IndexToUtf8Offset(text, 3), 5);
  assertEquals(utf16IndexToUtf8Offset(text, 4), 7);
  assertEquals(utf16CursorRangeToUtf8(text, 3), [5, 5]);
  assertEquals(utf16IndexToUtf8Offset(text, -1), undefined);
  assertEquals(utf16IndexToUtf8Offset(text, text.length + 1), undefined);
  assertEquals(utf8OffsetToUtf16Index(text, 0), 0);
  assertEquals(utf8OffsetToUtf16Index(text, 1), 1);
  assertEquals(utf8OffsetToUtf16Index(text, 5), 3);
  assertEquals(utf8OffsetToUtf16Index(text, 2), undefined);
  assertEquals(utf8OffsetToUtf16Index(text, 100), undefined);
});

Deno.test("CS_INSERTCHAR splices into cached preedit and applies its caret flag", () => {
  const text = "a🙂b";
  assertEquals(insertCompositionCharacter(text, [1, 1], "漢", false), {
    text: "a漢🙂b",
    cursorRange: [4, 4],
  });
  assertEquals(insertCompositionCharacter(text, [1, 1], "漢", true), {
    text: "a漢🙂b",
    cursorRange: [1, 1],
  });
});

Deno.test("cursor rectangles round outward, reject invalid values, and clamp to Win32 LONGs", () => {
  assertEquals(normalizeImeCursorArea(10.25, 20.75, 3.1, 4.1), {
    x: 10,
    y: 20,
    width: 4,
    height: 5,
  });
  assertEquals(normalizeImeCursorArea(10.25, 20.75, -3, 0), {
    x: 10,
    y: 20,
    width: 0,
    height: 0,
  });
  assertEquals(normalizeImeCursorArea(-1e20, -1e20, 2e20, 2e20), {
    x: -0x80000000,
    y: -0x80000000,
    width: 0x7fffffff,
    height: 0x7fffffff,
  });
  assertEquals(normalizeImeCursorArea(Number.NaN, 0, 1, 1), undefined);
});

Deno.test("native IME structure encoders use the documented little-endian layouts", () => {
  const caret = { x: 10, y: 20, width: 4, height: 5 };
  const candidate = new DataView(encodeCandidateForm(caret, 3));
  assertEquals(candidate.byteLength, 32);
  assertEquals(candidate.getUint32(0, true), 3);
  assertEquals(candidate.getUint32(4, true), CFS_EXCLUDE);
  assertEquals(readPoint(candidate, 8), [10, 25]);
  assertEquals(readRect(candidate, 16), [10, 20, 14, 25]);

  const composition = new DataView(encodeCompositionForm(caret));
  assertEquals(composition.byteLength, 28);
  assertEquals(composition.getUint32(0, true), CFS_POINT);
  assertEquals(readPoint(composition, 4), [10, 25]);
  assertEquals(readRect(composition, 12), [10, 20, 14, 25]);

  const character = new DataView(encodeImeCharPosition(7, caret, { x: 1, y: 2, width: 30, height: 40 }));
  assertEquals(character.byteLength, 36);
  assertEquals(character.getUint32(0, true), 36);
  assertEquals(character.getUint32(4, true), 7);
  assertEquals(readPoint(character, 8), [10, 20]);
  assertEquals(character.getUint32(16, true), 5);
  assertEquals(readRect(character, 20), [1, 2, 31, 42]);
});

Deno.test("result echo suppression consumes matching text and expires or clears on mismatches", () => {
  let now = 100;
  const suppressor = new ResultEchoSuppressor(50, () => now);
  suppressor.expect("好🙂");
  assertEquals(suppressor.consume("好"), true);
  assertEquals(suppressor.pendingText, "🙂");
  assertEquals(suppressor.consume("🙂"), true);
  assertEquals(suppressor.pendingText, "");

  suppressor.expect("aa");
  assertEquals(suppressor.consume("a", 2), true);
  suppressor.expect("expected");
  assertEquals(suppressor.consume("other"), false);
  assertEquals(suppressor.pendingText, "");

  suppressor.expect("late");
  now = 151;
  assertEquals(suppressor.consume("late"), false);
});

Deno.test("IMM reader honors byte counts and retries a growing composition buffer", () => {
  const encoded = utf16Le("é日");
  let queries = 0;
  let firstCopy = true;
  const text = readImmUtf16({
    getCompositionString(_index, buffer) {
      if (buffer === undefined) return ++queries === 1 ? 2 : encoded.byteLength;
      if (firstCopy) {
        firstCopy = false;
        return -1;
      }
      buffer.set(encoded);
      return encoded.byteLength;
    },
  }, 8);
  assertEquals(text, "é日");
  assertEquals(queries, 4);
});

Deno.test("IMM reader handles empty, odd, and native-error responses without decoding garbage", () => {
  assertEquals(readImmUtf16({ getCompositionString: () => 0 }, 8), "");
  assertEquals(readImmUtf16({ getCompositionString: () => -1 }, 8), undefined);
  assertEquals(readImmUtf16({ getCompositionString: () => 3 }, 8), undefined);
  assertEquals(
    readImmUtf16({
      getCompositionString(_index, buffer) {
        if (buffer === undefined) return 2;
        return -2;
      },
    }, 8),
    undefined,
  );
});

Deno.test("IME context helper releases exactly once after success or failure", () => {
  let releases = 0;
  assertEquals(withImeContext(() => ({ id: 1 }), () => releases++, (context) => context.id + 1), 2);
  assertEquals(releases, 1);

  assertThrows(() =>
    withImeContext(
      () => ({ id: 2 }),
      () => releases++,
      () => {
        throw new Error("read failed");
      },
    )
  );
  assertEquals(releases, 2);
  assertEquals(withImeContext(() => null, () => releases++, () => "unreachable"), undefined);
  assertEquals(releases, 2);
});

interface KeyLParamOptions {
  repeatCount?: number;
  extended?: boolean;
  context?: boolean;
  previous?: boolean;
  transition?: boolean;
}

function makeKeyLParam(scanCode: number, options: KeyLParamOptions = {}): bigint {
  let result = BigInt(options.repeatCount ?? 1) | (BigInt(scanCode) << 16n);
  if (options.extended) result |= 1n << 24n;
  if (options.context) result |= 1n << 29n;
  if (options.previous) result |= 1n << 30n;
  if (options.transition) result |= 1n << 31n;
  return result;
}

function keyboardState(entries: Array<readonly [virtualKey: number, state: number]>): Uint8Array {
  const state = new Uint8Array(256);
  for (const [virtualKey, value] of entries) state[virtualKey] = value;
  return state;
}

function readPoint(view: DataView, offset: number): [number, number] {
  return [view.getInt32(offset, true), view.getInt32(offset + 4, true)];
}

function readRect(view: DataView, offset: number): [number, number, number, number] {
  return [
    view.getInt32(offset, true),
    view.getInt32(offset + 4, true),
    view.getInt32(offset + 8, true),
    view.getInt32(offset + 12, true),
  ];
}

function utf16Le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true);
  return bytes;
}
