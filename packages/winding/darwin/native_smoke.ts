import { load } from "./mod.ts";
import type { ImeEvent, Library, Window } from "../types.ts";
import {
  cfSymbols,
  classConformsToProtocol,
  CORE_FOUNDATION,
  CORE_GRAPHICS,
  cStr,
  getClass,
  getProtocol,
  LIBOBJC,
  makeNSRange,
  NS_NOT_FOUND,
  NSPOINT,
  NSRANGE,
  openNSRectMsgSend,
  readCFString,
  readNSRange,
  readStructF64,
  runtimeSymbols,
  sel,
} from "./ffi.ts";
import { REQUIRED_TEXT_INPUT_SELECTORS } from "./text_input.ts";
import { POINTER_INPUT_SELECTORS, WINDOW_GEOMETRY_SELECTORS } from "./native_classes.ts";
import { DarwinInputState } from "./input_state.ts";

// AppKit requires all window work on the process main thread. Deno.test runs
// test bodies on worker threads, so this file must be invoked with `deno run`.
type Closeable = { close(): void };
type NativeWindow = Window & {
  contentView: Deno.PointerValue;
  nsWindow: Deno.PointerValue;
  inputState: DarwinInputState;
  lib: {
    nativeClasses: {
      contentView: Deno.PointerObject;
      delegate: Deno.PointerObject;
    };
  };
};

if (Deno.build.os !== "darwin") {
  throw new Error("winding(darwin): native smoke test requires macOS");
}

assertProcessMainThread();
runCase(
  "NSString, attributed text, preedit, commit, and command callbacks preserve order",
  testTextCallbacks,
);
runCase(
  "keydown is ordered before its synchronous preedit and commit callbacks",
  testKeydownOrdering,
);
runCase("modifier transitions never query key-only character properties", testModifierTransitions);
runCase("blit copies pixels into storage retained by Core Graphics", testBlitStorageLifetime);
runCase("windows opt into ordinary mouse-move delivery", testMouseMoveDeliveryEnabled);
runCase("closed windows and libraries reject every native operation", testClosedMethodGuards);
runCase("only one library owns the process-wide AppKit queue", testSingleLibraryOwnership);
runCase("activation messages use their declared BOOL and object call shapes", testActivationCallShapes);
runCase(
  "NSTextInputClient protocol and struct-return ABIs work through Objective-C dispatch",
  testProtocolAndStructAbis,
);
runCase("text input survives repeated library and window lifecycles", testRepeatedLifecycles);
await runAsyncCase("duplicate module copies share one AppKit owner", testDuplicateModuleOwnership);
console.log("Darwin native smoke: 11 passed");

function testTextCallbacks(): void {
  withNativeWindow(64, 48, (library, window) => {
    const handles: Closeable[] = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendIdBuffer = openMessage(handles, ["pointer", "pointer", "buffer"], "pointer");
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
        const replacementAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
        const replacement = own(
          owned,
          sendIdBuffer(replacementAlloc, sel(runtime, "initWithUTF8String:"), cStr("x")),
          "marked-text replacement",
        );
        drainEvents(library);
        establishNativeFocus(library, window);
        enableTextInputForSmoke(library, window);

        sendVoidIdRangeRange(
          window.contentView,
          sel(runtime, "setMarkedText:selectedRange:replacementRange:"),
          string,
          makeNSRange(2, 1),
          makeNSRange(NS_NOT_FOUND, 0),
        );
        const preedit = assertIme(library.event(), "preedit");
        assertEquals(preedit.text, "🙂e");
        assertEquals(preedit.cursorRange, [4, 5]);

        sendVoidIdRangeRange(
          window.contentView,
          sel(runtime, "setMarkedText:selectedRange:replacementRange:"),
          replacement,
          makeNSRange(1, 0),
          makeNSRange(2, 1),
        );
        const replacedPreedit = assertIme(library.event(), "preedit");
        assertEquals(replacedPreedit.text, "🙂x");
        assertEquals(replacedPreedit.cursorRange, [5, 5]);

        sendVoidIdRange(
          window.contentView,
          sel(runtime, "insertText:replacementRange:"),
          attributed,
          makeNSRange(NS_NOT_FOUND, 0),
        );
        const commit = assertIme(library.event(), "commit");
        assertEquals(commit.text, "🙂e");

        window.setImeSurroundingText("A🙂BC", 7, 7);
        sendVoidIdRange(
          window.contentView,
          sel(runtime, "insertText:replacementRange:"),
          replacement,
          makeNSRange(1, 3),
        );
        const absoluteReplacement = assertIme(library.event(), "replace");
        assertEquals(absoluteReplacement.startBytes, 1);
        assertEquals(absoluteReplacement.endBytes, 6);
        assertEquals(absoluteReplacement.text, "x");

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
        const shiftedStringAlloc = sendId(getClass(runtime, "NSString"), sel(runtime, "alloc"));
        const shiftedString = own(
          owned,
          sendIdBuffer(shiftedStringAlloc, sel(runtime, "initWithUTF8String:"), cStr("A")),
          "shifted key event characters",
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
        establishNativeFocus(library, window);
        enableTextInputForSmoke(library, window);
        sendVoidId(window.contentView, sel(runtime, "keyDown:"), event);

        const key = library.event();
        assert(key?.type === "keydown", "expected keydown before text input callbacks");
        assertEquals(key.code, "KeyA");
        assertEquals(key.key, "a");
        assertEquals(key.editDisposition, "text-input");
        const commit = assertIme(library.event(), "commit");
        assertEquals(commit.text, "a");

        const repeatEvent = makeKeyEvent(
          getClass(runtime, "NSEvent"),
          sel(
            runtime,
            "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
          ),
          10n,
          new Float64Array([0, 0]),
          1n << 17n,
          0,
          sendI64(window.nsWindow, sel(runtime, "windowNumber")),
          null,
          shiftedString,
          shiftedString,
          true,
          0,
        );
        assert(repeatEvent !== null, "failed to create synthetic repeat event");
        sendVoidId(window.contentView, sel(runtime, "keyDown:"), repeatEvent);
        const repeat = library.event();
        assert(repeat?.type === "keydown", "expected repeated keydown");
        assertEquals(repeat.repeat, true);
        assertEquals(repeat.key, "A");
        assertEquals(assertIme(library.event(), "commit").text, "A");

        const keyUpEvent = makeKeyEvent(
          getClass(runtime, "NSEvent"),
          sel(
            runtime,
            "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
          ),
          11n,
          new Float64Array([0, 0]),
          1n << 17n,
          0,
          sendI64(window.nsWindow, sel(runtime, "windowNumber")),
          null,
          shiftedString,
          shiftedString,
          false,
          0,
        );
        assert(keyUpEvent !== null, "failed to create synthetic key-up event");
        sendVoidId(window.contentView, sel(runtime, "keyUp:"), keyUpEvent);
        const keyUp = library.event();
        assert(keyUp?.type === "keyup", "expected keyup");
        assertEquals(keyUp.key, "A");

        // A key may already be held when the backend becomes active, so its
        // release has no cached press to pair with.
        sendVoidId(window.contentView, sel(runtime, "keyUp:"), keyUpEvent);
        const initiallyHeldKeyUp = library.event();
        assert(initiallyHeldKeyUp?.type === "keyup", "expected unmatched keyup");
        assertEquals(initiallyHeldKeyUp.key, "A");

        // Losing focus deliberately clears the press cache. AppKit's current
        // characters must still give the subsequent release a useful key.
        sendVoidId(window.contentView, sel(runtime, "keyDown:"), event);
        drainEvents(library);
        const delegate = sendId(window.nsWindow, sel(runtime, "delegate"));
        assert(delegate !== null, "Darwin window has no native delegate");
        sendVoidId(delegate, sel(runtime, "windowDidResignKey:"), null);
        drainEvents(library);
        sendVoidId(delegate, sel(runtime, "windowDidBecomeKey:"), null);
        drainEvents(library);
        sendVoidId(window.contentView, sel(runtime, "keyUp:"), keyUpEvent);
        const recoveredKeyUp = library.event();
        assert(recoveredKeyUp?.type === "keyup", "expected recovered keyup");
        assertEquals(recoveredKeyUp.key, "A");
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

function testModifierTransitions(): void {
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
        const empty = own(
          owned,
          sendIdBuffer(stringAlloc, sel(runtime, "initWithUTF8String:"), cStr("")),
          "empty key event characters",
        );
        const makeModifierEvent = (flags: bigint) => {
          const event = makeKeyEvent(
            getClass(runtime, "NSEvent"),
            sel(
              runtime,
              "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
            ),
            12n,
            new Float64Array([0, 0]),
            flags,
            0,
            sendI64(window.nsWindow, sel(runtime, "windowNumber")),
            null,
            empty,
            empty,
            false,
            0x38,
          );
          assert(event !== null, "failed to create synthetic flags-changed event");
          return event;
        };

        drainEvents(library);
        sendVoidId(window.contentView, sel(runtime, "flagsChanged:"), makeModifierEvent(1n << 17n));
        const down = library.event();
        assert(down?.type === "keydown", "expected Shift keydown");
        assertEquals(down.code, "ShiftLeft");
        assertEquals(down.key, "Shift");
        assertEquals(down.shiftKey, true);

        sendVoidId(window.contentView, sel(runtime, "flagsChanged:"), makeModifierEvent(0n));
        const up = library.event();
        assert(up?.type === "keyup", "expected Shift keyup");
        assertEquals(up.code, "ShiftLeft");
        assertEquals(up.key, "Shift");
        assertEquals(up.shiftKey, false);
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

function testBlitStorageLifetime(): void {
  withNativeWindow(2, 1, (_library, window) => {
    const handles: Closeable[] = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendVoid = openMessage(handles, ["pointer", "pointer"], "void");
      const cg = Deno.dlopen(
        CORE_GRAPHICS,
        {
          CGImageGetDataProvider: { parameters: ["pointer"], result: "pointer" },
          CGDataProviderCopyData: { parameters: ["pointer"], result: "pointer" },
        } as const,
      );
      handles.push(cg);
      const cf = Deno.dlopen(
        CORE_FOUNDATION,
        {
          CFDataGetLength: { parameters: ["pointer"], result: "i64" },
          CFDataGetBytePtr: { parameters: ["pointer"], result: "pointer" },
          CFRelease: { parameters: ["pointer"], result: "void" },
        } as const,
      );
      handles.push(cf);

      const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      assertThrowsMessage(() => window.blit(pixels, 0, 1), "positive safe integers");
      assertThrowsMessage(() => window.blit(pixels, 1.5, 1), "positive safe integers");
      assertThrowsMessage(() => window.blit(pixels, 1, 2), "do not match client size");
      assertThrowsMessage(() => window.blit(pixels.subarray(0, 7), 2, 1), "expected 8");
      window.blit(pixels, 2, 1);
      pixels.fill(0);

      sendVoid(window.contentView, sel(runtime, "displayIfNeeded"));
      const layer = sendId(window.contentView, sel(runtime, "layer"));
      assert(layer !== null, "content view has no layer after blit");
      const image = sendId(layer, sel(runtime, "contents"));
      assert(image !== null, "content layer has no image after blit");
      const provider = cg.symbols.CGImageGetDataProvider(image);
      assert(provider !== null, "installed image has no data provider");
      const data = cg.symbols.CGDataProviderCopyData(provider);
      assert(data !== null, "could not copy installed provider bytes");
      try {
        const length = cf.symbols.CFDataGetLength(data);
        assertEquals(length, 8n);
        const pointer = cf.symbols.CFDataGetBytePtr(data);
        assert(pointer !== null, "installed provider returned null bytes");
        const actual = new Uint8Array(new Deno.UnsafePointerView(pointer).getArrayBuffer(8));
        assertEquals([...actual], [1, 2, 3, 4, 5, 6, 7, 8]);
      } finally {
        cf.symbols.CFRelease(data);
      }
    } finally {
      closeAll(handles);
    }
  });
}

function testMouseMoveDeliveryEnabled(): void {
  withNativeWindow(64, 48, (_library, window) => {
    const handles: Closeable[] = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendBool = openMessage(handles, ["pointer", "pointer"], "bool");
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendU64 = openMessage(handles, ["pointer", "pointer"], "u64");
      assert(
        sendBool(window.nsWindow, sel(runtime, "acceptsMouseMovedEvents")),
        "NSWindow did not enable ordinary mouse-move delivery",
      );
      const trackingAreas = sendId(window.contentView, sel(runtime, "trackingAreas"));
      assert(trackingAreas !== null, "content view has no tracking-area collection");
      const trackingArea = sendId(trackingAreas, sel(runtime, "firstObject"));
      assert(trackingArea !== null, "content view has no pointer tracking area");
      const options = sendU64(trackingArea, sel(runtime, "options"));
      assert((options & 0x80n) !== 0n, "tracking area is not active for non-key windows");
      assert((options & 0x400n) !== 0n, "tracking area is not enabled during drags");
    } finally {
      closeAll(handles);
    }
  });
}

function testClosedMethodGuards(): void {
  const library = load();
  const window = library.openWindow(0, 0, 2, 1) as NativeWindow & { cancelComposition(): void };
  window.close();

  const closedWindowOperations = [
    () => window.setTitle("closed"),
    () => window.blit(new Uint8Array(8), 2, 1),
    () => window.setImeEnabled(true),
    () => window.setImeCursorArea(0, 0, 0, 0),
    () => window.setImeSurroundingText("", 0, 0),
    () => window.cancelComposition(),
  ];
  for (const operation of closedWindowOperations) {
    assertThrowsMessage(operation, "window is closed");
  }
  window.close();

  library.close();
  assertThrowsMessage(() => library.openWindow(), "library is closed");
  assertThrowsMessage(() => library.event(), "library is closed");
  assertThrowsMessage(() => window.setTitle("library closed"), "window is closed");
  library.close();
}

function testSingleLibraryOwnership(): void {
  const first = load();
  try {
    assertThrowsMessage(() => load(), "only one Darwin library");
  } finally {
    first.close();
  }

  const replacement = load();
  replacement.close();
}

async function testDuplicateModuleOwnership(): Promise<void> {
  const first = load();
  try {
    const duplicate = await import("./mod.ts?duplicate-native-smoke");
    assertThrowsMessage(() => duplicate.load(), "only one Darwin library");
  } finally {
    first.close();
  }
}

function testActivationCallShapes(): void {
  withNativeWindow(64, 48, (library, window) => {
    const handles: Closeable[] = [];
    try {
      const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
      handles.push(runtime);
      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const setPolicy = openMessage(handles, ["pointer", "pointer", "i64"], "bool");
      const orderFront = openMessage(
        handles,
        ["pointer", "pointer", "pointer"],
        "void",
      );
      const nsApp = sendId(getClass(runtime, "NSApplication"), sel(runtime, "sharedApplication"));
      assert(nsApp !== null, "NSApplication.sharedApplication returned nil");
      assert(
        setPolicy(nsApp, sel(runtime, "setActivationPolicy:"), 0n),
        "NSApplication rejected its existing activation policy",
      );
      orderFront(window.nsWindow, sel(runtime, "makeKeyAndOrderFront:"), null);
      drainEvents(library);
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
      const cf = Deno.dlopen(CORE_FOUNDATION, cfSymbols);
      handles.push(cf);
      const viewClass = window.lib.nativeClasses.contentView;
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
      for (const selector of POINTER_INPUT_SELECTORS) {
        assert(
          respondsToSelector(
            viewClass,
            sel(runtime, "instancesRespondToSelector:"),
            sel(runtime, selector),
          ),
          `WindingContentView does not respond to ${selector}`,
        );
      }
      for (const selector of ["wantsUpdateLayer", "updateLayer"]) {
        assert(
          respondsToSelector(
            viewClass,
            sel(runtime, "instancesRespondToSelector:"),
            sel(runtime, selector),
          ),
          `WindingContentView does not respond to ${selector}`,
        );
      }
      const delegateClass = window.lib.nativeClasses.delegate;
      assert(
        classConformsToProtocol(runtime, delegateClass, getProtocol(runtime, "NSWindowDelegate")),
        "WindingWindowDelegate does not conform to NSWindowDelegate",
      );
      for (const selector of WINDOW_GEOMETRY_SELECTORS) {
        assert(
          respondsToSelector(
            delegateClass,
            sel(runtime, "instancesRespondToSelector:"),
            sel(runtime, selector),
          ),
          `WindingWindowDelegate does not respond to ${selector}`,
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

      window.setImeSurroundingText("A🙂B", 1, 5);
      const documentSelection = readNSRange(
        rangeSend.symbols.objc_msgSend(window.contentView, sel(runtime, "selectedRange")) as Uint8Array,
      );
      assertEquals(documentSelection, { location: 1n, length: 2n });

      const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
      const sendIdCharacters = openMessage(
        handles,
        ["pointer", "pointer", "buffer", "usize"],
        "pointer",
      );
      const sendVoid = openMessage(handles, ["pointer", "pointer"], "void");
      window.setTitle("left\0🙂right");
      const exactTitle = sendId(window.nsWindow, sel(runtime, "title"));
      assert(exactTitle !== null, "NSWindow returned a nil title");
      assertEquals(readCFString(cf, exactTitle), "left\0🙂right");
      window.setTitle("\ufeffleading BOM");
      const bomTitle = sendId(window.nsWindow, sel(runtime, "title"));
      assert(bomTitle !== null, "NSWindow returned a nil BOM title");
      assertEquals(readCFString(cf, bomTitle), "\ufeffleading BOM");

      const malformedAlloc = sendId(
        getClass(runtime, "NSString"),
        sel(runtime, "alloc"),
      );
      assert(malformedAlloc !== null, "failed to allocate malformed NSString");
      const malformed = sendIdCharacters(
        malformedAlloc,
        sel(runtime, "initWithCharacters:length:"),
        new Uint16Array([0xd800]),
        1,
      );
      assert(malformed !== null, "failed to initialize malformed NSString");
      try {
        assertThrowsMessage(
          () => readCFString(cf, malformed),
          "failed to convert complete CFString",
        );
      } finally {
        sendVoid(malformed, sel(runtime, "release"));
      }
      const attributedSubstring = openMessage(
        handles,
        ["pointer", "pointer", NSRANGE, "pointer"],
        "pointer",
      );
      const substringActualRange = makeNSRange(0, 0);
      const attributed = attributedSubstring(
        window.contentView,
        sel(runtime, "attributedSubstringForProposedRange:actualRange:"),
        makeNSRange(1, 2),
        Deno.UnsafePointer.of(substringActualRange),
      );
      assert(attributed !== null, "expected attributed surrounding-text substring");
      const plainString = sendId(attributed, sel(runtime, "string"));
      assert(plainString !== null, "attributed substring has no plain string");
      assertEquals(readCFString(cf, plainString), "🙂");
      assertEquals(readNSRange(substringActualRange), { location: 1n, length: 2n });

      const rectSend = openNSRectMsgSend(handles);
      const frame = rectSend.noArgs(window.contentView, sel(runtime, "frame"));
      assertEquals(readStructF64(frame, 16), 64);
      assertEquals(readStructF64(frame, 24), 48);

      window.setImeCursorArea(4, 6, 2, 14);
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
        rectSend.rectPointerArg(
          window.contentView,
          sel(runtime, "convertRect:toView:"),
          new Float64Array([4, 28, 2, 14]),
          null,
        ),
      );
      for (const offset of [0, 8, 16, 24]) {
        assertClose(
          readStructF64(screenRect, offset),
          readStructF64(expectedScreenRect, offset),
        );
      }
      assertEquals(readNSRange(actualRange).location, NS_NOT_FOUND);

      const caretActualRange = makeNSRange(0, 0);
      const caretRect = rectSend.rangePointerArgs(
        window.contentView,
        sel(runtime, "firstRectForCharacterRange:actualRange:"),
        makeNSRange(3, 0),
        Deno.UnsafePointer.of(caretActualRange),
      );
      assertClose(readStructF64(caretRect, 0), readStructF64(expectedScreenRect, 0));
      assertClose(readStructF64(caretRect, 8), readStructF64(expectedScreenRect, 8));
      assertEquals(readStructF64(caretRect, 16), 0);
      assertClose(readStructF64(caretRect, 24), readStructF64(expectedScreenRect, 24));
      assertEquals(readNSRange(caretActualRange), { location: 3n, length: 0n });
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
        for (let update = 0; update < 32; update++) window.setTitle(`autorelease-${iteration}-${update}`);
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

/**
 * AppKit does not reliably grant an unbundled command-line process foreground
 * focus on hosted CI runners. Drive the registered delegate callback through
 * Objective-C so the smoke test exercises the same native focus bridge without
 * depending on the runner's desktop session.
 */
function establishNativeFocus(library: Library, window: NativeWindow): void {
  const handles: Closeable[] = [];
  try {
    const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
    handles.push(runtime);
    const sendId = openMessage(handles, ["pointer", "pointer"], "pointer");
    const sendVoidId = openMessage(handles, ["pointer", "pointer", "pointer"], "void");
    const delegate = sendId(window.nsWindow, sel(runtime, "delegate"));
    assert(delegate !== null, "Darwin window has no native delegate");
    sendVoidId(delegate, sel(runtime, "windowDidBecomeKey:"), null);
    const focus = library.event();
    assert(
      focus?.type === "focus" && focus.window === window,
      "expected native focus event before enabling IME",
    );
  } finally {
    closeAll(handles);
  }
}

function enableTextInputForSmoke(library: Library, window: NativeWindow): void {
  window.setImeEnabled(true);
  // Crash-prone callback ABI tests use a synthetic focus notification because
  // unbundled CI processes are not guaranteed foreground activation. Mark the
  // context observed only inside this harness; production never synthesizes it.
  window.inputState.setNativeAvailable(true);
  window.inputState.observeNativeActive(true);
  assertIme(library.event(), "enabled");
}

function runCase(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

async function runAsyncCase(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
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

function assertThrowsMessage(operation: () => unknown, expected: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error && thrown.message.includes(expected),
    `expected error containing ${JSON.stringify(expected)}, got ${String(thrown)}`,
  );
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
