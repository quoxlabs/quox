import { load } from "./mod.ts";
import type { ImeEvent, Window } from "../types.ts";
import {
  classConformsToProtocol,
  cStr,
  getClass,
  getProtocol,
  LIBOBJC,
  makeNSRange,
  NS_NOT_FOUND,
  NSPOINT,
  NSRANGE,
  openNSRectMsgSend,
  readNSRange,
  readStructF64,
  runtimeSymbols,
  sel,
} from "./ffi.ts";
import { __testing } from "./text_input.ts";

const TEXT_INPUT_SELECTORS = [
  "acceptsFirstResponder",
  "keyDown:",
  "keyUp:",
  "flagsChanged:",
  "insertText:replacementRange:",
  "setMarkedText:selectedRange:replacementRange:",
  "unmarkText",
  "hasMarkedText",
  "markedRange",
  "selectedRange",
  "validAttributesForMarkedText",
  "attributedSubstringForProposedRange:actualRange:",
  "characterIndexForPoint:",
  "firstRectForCharacterRange:actualRange:",
  "doCommandBySelector:",
] as const;

Deno.test("WindingContentView declares the complete NSTextInputClient responder surface", () => {
  const registered = new Set(__testing.requiredSelectors);
  for (const selector of TEXT_INPUT_SELECTORS) {
    assert(registered.has(selector), `missing Objective-C selector ${selector}`);
  }
});

Deno.test("Objective-C BOOL uses the architecture-correct method encoding", () => {
  const expected = Deno.build.arch === "x86_64" ? "c" : "B";
  assertEquals(__testing.boolEncoding, expected);
});

Deno.test("NSRange helpers preserve ordinary ranges and NSNotFound", () => {
  assertEquals(readNSRange(makeNSRange(2, 7)), { location: 2n, length: 7n });
  assertEquals(readNSRange(makeNSRange(NS_NOT_FOUND, 0)), {
    location: NS_NOT_FOUND,
    length: 0n,
  });
});

Deno.test("logical keys come from AppKit text rather than the physical key position", () => {
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyY",
      characters: "z",
      charactersIgnoringModifiers: "z",
    }),
    "z",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyQ",
      characters: "'",
      charactersIgnoringModifiers: "'",
    }),
    "'",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "€",
      charactersIgnoringModifiers: "e",
    }),
    "€",
  );
});

Deno.test("logical key resolution covers interpreted text, dead keys, and named keys", () => {
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "",
      producedText: "é",
    }),
    "é",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "Quote",
      characters: "",
      charactersIgnoringModifiers: "",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyK",
      characters: "k",
      charactersIgnoringModifiers: "k",
      producedPreedit: true,
    }),
    "k",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
      producedPreedit: true,
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "KeyE",
      characters: "",
      charactersIgnoringModifiers: "e",
    }),
    "Dead",
  );
  assertEquals(
    __testing.logicalKeyForEvent({
      code: "ArrowLeft",
      characters: "\uf702",
      charactersIgnoringModifiers: "\uf702",
    }),
    "ArrowLeft",
  );
});

Deno.test("Darwin key locations distinguish left, right, and keypad keys", () => {
  assertEquals(__testing.keyLocationForCode("ShiftLeft"), 1);
  assertEquals(__testing.keyLocationForCode("AltRight"), 2);
  assertEquals(__testing.keyLocationForCode("Numpad7"), 3);
  assertEquals(__testing.keyLocationForCode("KeyA"), 0);
});

Deno.test("candidate rectangles convert from top-left client to Cocoa view coordinates", () => {
  assertDeepEquals(
    __testing.cocoaRectFromClient({ x: 4.25, y: 8.5, width: 12.75, height: 16.5 }, 100),
    { x: 4.25, y: 75, width: 12.75, height: 16.5 },
  );
  assertDeepEquals(
    __testing.cocoaRectFromClient(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: -1, height: Number.NaN },
      100,
    ),
    { x: 0, y: 100, width: 0, height: 0 },
  );
  assertDeepEquals(
    __testing.cocoaRectFromClient({ x: -4, y: 110, width: 2, height: 3 }, 100),
    { x: -4, y: -13, width: 2, height: 3 },
  );
});

Deno.test({
  name: "Darwin NSString, attributed text, preedit, commit, and command callbacks preserve order",
  ignore: Deno.build.os !== "darwin",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const library = load();
    const window = library.openWindow(0, 0, 64, 48) as Window & {
      contentView: Deno.PointerValue;
    };
    const handles: Array<{ close(): void }> = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendIdBuffer = openMessage(handles, ["pointer", "pointer", "buffer"], "pointer");
      const sendIdBufferUsize = openMessage(
        handles,
        ["pointer", "pointer", "buffer", "usize"],
        "pointer",
      );
      const sendIdId = openMessage(handles, ["pointer", "pointer", "pointer"], "pointer");
      const sendVoid = openMessage(handles, ["pointer", "pointer"], "void");
      const sendVoidId = openMessage(handles, ["pointer", "pointer", "pointer"], "void");
      const sendVoidIdRange = openMessage(
        handles,
        ["pointer", "pointer", "pointer", NSRANGE],
        "void",
      );
      const sendVoidIdRangeRange = openMessage(
        handles,
        ["pointer", "pointer", "pointer", NSRANGE, NSRANGE],
        "void",
      );

      const stringAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
      const string = sendIdBuffer(stringAlloc, sel(runtime, "initWithUTF8String:"), cStr("🙂e"));
      assert(string !== null, "failed to create NSString");
      const attributedAlloc = sendId(getClass(runtime, "NSAttributedString"), sel(runtime, "alloc"));
      const attributed = sendIdId(attributedAlloc, sel(runtime, "initWithString:"), string);
      assert(attributed !== null, "failed to create NSAttributedString");
      const embeddedNulAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
      const embeddedNul = sendIdBufferUsize(
        embeddedNulAlloc,
        sel(runtime, "initWithCharacters:length:"),
        new Uint16Array([0x61, 0, 0x62]),
        3n,
      );
      assert(embeddedNul !== null, "failed to create embedded-NUL NSString");

      drainEvents(library);
      window.setImeEnabled?.(true);
      assertIme(library.event(), "enabled");

      sendVoidIdRangeRange(
        window.contentView,
        sel(runtime, "setMarkedText:selectedRange:replacementRange:"),
        string,
        makeNSRange(2, 1),
        makeNSRange(NS_NOT_FOUND, 0),
      );
      const preedit = assertIme(library.event(), "preedit");
      assertEquals(preedit.text, "🙂e");
      assertEquals(preedit.selection, { start: 4, end: 5 });

      sendVoidIdRange(
        window.contentView,
        sel(runtime, "insertText:replacementRange:"),
        attributed,
        makeNSRange(NS_NOT_FOUND, 0),
      );
      assertIme(library.event(), "preedit");
      const commit = assertIme(library.event(), "commit");
      assertEquals(commit.text, "🙂e");

      sendVoidIdRange(
        window.contentView,
        sel(runtime, "insertText:replacementRange:"),
        embeddedNul,
        makeNSRange(NS_NOT_FOUND, 0),
      );
      assertIme(library.event(), "preedit");
      const nulCommit = assertIme(library.event(), "commit");
      assertEquals(nulCommit.text, "a\0b");

      sendVoidId(
        window.contentView,
        sel(runtime, "doCommandBySelector:"),
        sel(runtime, "deleteBackward:"),
      );
      const command = library.event();
      assert(command?.type === "apple-standard-keybinding", "expected native command event");
      assertEquals(command.command, "deleteBackward:");

      sendVoid(embeddedNul, sel(runtime, "release"));
      sendVoid(attributed, sel(runtime, "release"));
      sendVoid(string, sel(runtime, "release"));
    } finally {
      window.close();
      library.close();
      for (let i = handles.length - 1; i >= 0; i--) handles[i].close();
    }
  },
});

Deno.test({
  name: "Darwin keydown is ordered before its synchronous preedit and commit callbacks",
  ignore: Deno.build.os !== "darwin",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const library = load();
    const window = library.openWindow(0, 0, 64, 48) as Window & {
      contentView: Deno.PointerValue;
      nsWindow: Deno.PointerValue;
    };
    const handles: Array<{ close(): void }> = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendIdBuffer = openMessage(handles, ["pointer", "pointer", "buffer"], "pointer");
      const sendI64 = openMessage(handles, ["pointer", "pointer"], "i64");
      const sendVoid = openMessage(handles, ["pointer", "pointer"], "void");
      const sendVoidId = openMessage(handles, ["pointer", "pointer", "pointer"], "void");
      const makeKeyEvent = openMessage(
        handles,
        [
          "pointer",
          "pointer",
          "u64",
          NSPOINT,
          "u64",
          "f64",
          "i64",
          "pointer",
          "pointer",
          "pointer",
          "bool",
          "u16",
        ],
        "pointer",
      );

      const stringAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
      const string = sendIdBuffer(stringAlloc, sel(runtime, "initWithUTF8String:"), cStr("a"));
      assert(string !== null, "failed to create key event characters");
      const event = makeKeyEvent(
        getClass(runtime, "NSEvent"),
        sel(
          runtime,
          "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
        ),
        10n,
        new Float64Array([0, 0]),
        0n,
        0,
        sendI64(window.nsWindow, sel(runtime, "windowNumber")),
        null,
        string,
        string,
        false,
        0,
      );
      assert(event !== null, "failed to create synthetic key event");

      drainEvents(library);
      window.setImeEnabled?.(true);
      assertIme(library.event(), "enabled");
      sendVoidId(window.contentView, sel(runtime, "keyDown:"), event);

      const key = library.event();
      assert(key?.type === "keydown", "expected keydown before text input callbacks");
      assertEquals(key.code, "KeyA");
      assertEquals(key.key, "a");
      assertEquals(key.text, "a");
      assertEquals(key.textInputHandled, true);
      const clear = assertIme(library.event(), "preedit");
      assertEquals(clear.text, "");
      const commit = assertIme(library.event(), "commit");
      assertEquals(commit.text, "a");

      sendVoid(string, sel(runtime, "release"));
    } finally {
      window.close();
      library.close();
      for (let i = handles.length - 1; i >= 0; i--) handles[i].close();
    }
  },
});

Deno.test({
  name: "Darwin NSTextInputClient protocol and struct-return ABIs work through Objective-C dispatch",
  ignore: Deno.build.os !== "darwin",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const library = load();
    const window = library.openWindow(0, 0, 64, 48) as Window & {
      contentView: Deno.PointerValue;
      nsWindow: Deno.PointerValue;
    };
    const handles: Array<{ close(): void }> = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const viewClass = getClass(runtime, "WindingContentView");
      assert(
        classConformsToProtocol(runtime, viewClass, getProtocol(runtime, "NSTextInputClient")),
        "WindingContentView does not conform to NSTextInputClient",
      );
      const respondsToSelector = openMessage(
        handles,
        ["pointer", "pointer", "pointer"],
        "bool",
      );
      for (const selector of TEXT_INPUT_SELECTORS) {
        assert(
          respondsToSelector(
            viewClass,
            sel(runtime, "instancesRespondToSelector:"),
            sel(runtime, selector),
          ),
          `WindingContentView does not respond to ${selector}`,
        );
      }

      const rangeSend = Deno.dlopen(
        LIBOBJC,
        {
          objc_msgSend: {
            parameters: ["pointer", "pointer"],
            result: NSRANGE,
          },
        } as const,
      );
      handles.push(rangeSend);
      const selected = readNSRange(
        rangeSend.symbols.objc_msgSend(window.contentView, sel(runtime, "selectedRange")) as Uint8Array,
      );
      assertEquals(selected.location, NS_NOT_FOUND);
      assertEquals(selected.length, 0n);
      const marked = readNSRange(
        rangeSend.symbols.objc_msgSend(window.contentView, sel(runtime, "markedRange")) as Uint8Array,
      );
      assertEquals(marked.location, NS_NOT_FOUND);
      assertEquals(marked.length, 0n);

      const rectSend = openNSRectMsgSend(handles);
      const frame = rectSend.noArgs(window.contentView, sel(runtime, "frame"));
      assertEquals(readStructF64(frame, 16), 64);
      assertEquals(readStructF64(frame, 24), 48);

      window.setImeCursorArea?.(4, 6, 2, 14);
      const actualRange = makeNSRange(0, 0);
      const screenRect = rectSend.rangePointerArgs(
        window.contentView,
        sel(runtime, "firstRectForCharacterRange:actualRange:"),
        makeNSRange(NS_NOT_FOUND, 0),
        Deno.UnsafePointer.of(actualRange),
      );
      const expectedScreenRect = rectSend.rectArg(
        window.nsWindow,
        sel(runtime, "convertRectToScreen:"),
        new Float64Array([4, 28, 2, 14]),
      );
      for (const offset of [0, 8, 16, 24]) {
        assertClose(
          readStructF64(screenRect, offset),
          readStructF64(expectedScreenRect, offset),
        );
      }
      assertEquals(readNSRange(actualRange).location, NS_NOT_FOUND);
    } finally {
      window.close();
      library.close();
      for (let i = handles.length - 1; i >= 0; i--) handles[i].close();
    }
  },
});

Deno.test({
  name: "Darwin text input survives repeated library and window lifecycles",
  ignore: Deno.build.os !== "darwin",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    for (let iteration = 0; iteration < 2; iteration++) {
      const library = load();
      try {
        const window = library.openWindow(0, 0, 64, 64);
        try {
          assert(
            typeof window.setImeEnabled === "function",
            "Darwin window does not expose setImeEnabled",
          );
          assert(
            typeof window.setImeCursorArea === "function",
            "Darwin window does not expose setImeCursorArea",
          );

          window.setImeEnabled(true);
          window.setImeCursorArea(4.25, 8.5, 12.75, 16.5);
          window.setImeEnabled(false);
        } finally {
          window.close();
        }
      } finally {
        library.close();
      }
    }
  },
});

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const encode = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? `${item}n` : item,
    );
  if (encode(actual) !== encode(expected)) {
    throw new Error(`expected ${encode(expected)}, got ${encode(actual)}`);
  }
}

type ImeEventOfKind<K extends ImeEvent["kind"]> = ImeEvent extends infer Event
  ? Event extends { kind: infer EventKind } ? K extends EventKind ? Event & { kind: K }
    : never
  : never
  : never;

function assertIme<K extends ImeEvent["kind"]>(
  event: ReturnType<ReturnType<typeof load>["event"]>,
  kind: K,
): ImeEventOfKind<K> {
  assert(event?.type === "ime" && event.kind === kind, `expected IME ${kind} event`);
  return event as ImeEventOfKind<K>;
}

function openMessage<
  const P extends readonly Deno.NativeType[],
  const R extends Deno.NativeResultType,
>(
  handles: Array<{ close(): void }>,
  parameters: P,
  result: R,
) {
  const library = Deno.dlopen(
    LIBOBJC,
    { objc_msgSend: { parameters, result } } as const,
  );
  handles.push(library);
  return library.symbols.objc_msgSend;
}

function assertDeepEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertClose(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

function drainEvents(library: ReturnType<typeof load>): void {
  while (library.event() !== undefined) {
    // Drain activation, focus, and resize notifications queued at window creation.
  }
}
