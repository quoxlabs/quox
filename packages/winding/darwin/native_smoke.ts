import { load } from "./mod.ts";
import type { ImeEvent, Library, Window } from "../types.ts";
import {
  APPKIT,
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
import { REQUIRED_TEXT_INPUT_SELECTORS } from "./text_input.ts";

// AppKit requires all window work on the process main thread. Deno.test runs
// test bodies on worker threads, so this file must be invoked with `deno run`.
type Closeable = { close(): void };
type NativeWindow = Window & {
  contentView: Deno.PointerValue;
  nsWindow: Deno.PointerValue;
};

if (Deno.build.os !== "darwin") {
  throw new Error("winding(darwin): native smoke test requires macOS");
}

assertProcessMainThread();
withAutoreleasePool(() => {
  runCase(
    "NSString, attributed text, preedit, commit, and command callbacks preserve order",
    testTextCallbacks,
  );
  runCase(
    "keydown is ordered before its synchronous preedit and commit callbacks",
    testKeydownOrdering,
  );
  runCase(
    "NSTextInputClient protocol and struct-return ABIs work through Objective-C dispatch",
    testProtocolAndStructAbis,
  );
  runCase("text input survives repeated library and window lifecycles", testRepeatedLifecycles);
  console.log("Darwin native smoke: 4 passed");
});

function testTextCallbacks(): void {
  withNativeWindow(64, 48, (library, window) => {
    const handles: Closeable[] = [];
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
      const owned: Deno.PointerObject[] = [];
      try {
        const stringAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
        const string = own(
          owned,
          sendIdBuffer(stringAlloc, sel(runtime, "initWithUTF8String:"), cStr("🙂e")),
          "NSString",
        );
        const attributedAlloc = sendId(
          getClass(runtime, "NSAttributedString"),
          sel(runtime, "alloc"),
        );
        const attributed = own(
          owned,
          sendIdId(attributedAlloc, sel(runtime, "initWithString:"), string),
          "NSAttributedString",
        );
        const embeddedNulAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
        const embeddedNul = own(
          owned,
          sendIdBufferUsize(
            embeddedNulAlloc,
            sel(runtime, "initWithCharacters:length:"),
            new Uint16Array([0x61, 0, 0x62]),
            3n,
          ),
          "embedded-NUL NSString",
        );

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
      } finally {
        for (let i = owned.length - 1; i >= 0; i--) {
          sendVoid(owned[i], sel(runtime, "release"));
        }
      }
    } finally {
      closeAll(handles);
    }
  });
}

function testKeydownOrdering(): void {
  withNativeWindow(64, 48, (library, window) => {
    const handles: Closeable[] = [];
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
      const owned: Deno.PointerObject[] = [];
      try {
        const stringAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
        const string = own(
          owned,
          sendIdBuffer(stringAlloc, sel(runtime, "initWithUTF8String:"), cStr("a")),
          "key event characters",
        );
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
      } finally {
        for (let i = owned.length - 1; i >= 0; i--) {
          sendVoid(owned[i], sel(runtime, "release"));
        }
      }
    } finally {
      closeAll(handles);
    }
  });
}

function testProtocolAndStructAbis(): void {
  withNativeWindow(64, 48, (_library, window) => {
    const handles: Closeable[] = [];
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
      for (const selector of REQUIRED_TEXT_INPUT_SELECTORS) {
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
      assertEquals(selected, { location: NS_NOT_FOUND, length: 0n });
      const marked = readNSRange(
        rangeSend.symbols.objc_msgSend(window.contentView, sel(runtime, "markedRange")) as Uint8Array,
      );
      assertEquals(marked, { location: NS_NOT_FOUND, length: 0n });

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
      closeAll(handles);
    }
  });
}

function testRepeatedLifecycles(): void {
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
}

function withNativeWindow(
  width: number,
  height: number,
  fn: (library: Library, window: NativeWindow) => void,
): void {
  const library = load();
  let window: NativeWindow | undefined;
  try {
    window = library.openWindow(0, 0, width, height) as NativeWindow;
    fn(library, window);
  } finally {
    try {
      window?.close();
    } finally {
      library.close();
    }
  }
}

function assertProcessMainThread(): void {
  const pthread = Deno.dlopen(
    "/usr/lib/libSystem.B.dylib",
    { pthread_main_np: { parameters: [], result: "i32" } } as const,
  );
  try {
    assert(
      pthread.symbols.pthread_main_np() !== 0,
      "Darwin native smoke must run via `deno run` on the process main thread",
    );
  } finally {
    pthread.close();
  }
}

function withAutoreleasePool(fn: () => void): void {
  const handles: Closeable[] = [];
  try {
    const appKit = Deno.dlopen(APPKIT, {});
    handles.push(appKit);
    const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
    handles.push(runtime);
    const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
    const sendVoid = openMessage(handles, ["pointer", "pointer"], "void");
    const poolAlloc = sendId(getClass(runtime, "NSAutoreleasePool"), sel(runtime, "alloc"));
    const pool = sendId(poolAlloc, sel(runtime, "init"));
    assert(pool !== null, "failed to create NSAutoreleasePool");
    try {
      fn();
    } finally {
      sendVoid(pool, sel(runtime, "drain"));
    }
  } finally {
    closeAll(handles);
  }
}

function runCase(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

function own(
  owned: Deno.PointerObject[],
  value: Deno.PointerValue,
  description: string,
): Deno.PointerObject {
  assert(value !== null, `failed to create ${description}`);
  owned.push(value);
  return value;
}

function closeAll(handles: Closeable[]): void {
  for (let i = handles.length - 1; i >= 0; i--) handles[i].close();
}

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
  event: ReturnType<Library["event"]>,
  kind: K,
): ImeEventOfKind<K> {
  assert(event?.type === "ime" && event.kind === kind, `expected IME ${kind} event`);
  return event as ImeEventOfKind<K>;
}

function openMessage<
  const P extends readonly Deno.NativeType[],
  const R extends Deno.NativeResultType,
>(
  handles: Closeable[],
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

function assertClose(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

function drainEvents(library: Library): void {
  while (library.event() !== undefined) {
    // Drain activation, focus, and resize notifications queued at window creation.
  }
}
