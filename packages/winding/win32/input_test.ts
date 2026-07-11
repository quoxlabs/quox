import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import type { KeyDownEvent, UIEvent } from "../types.ts";
import {
  AltGraphControlFilter,
  decodeKeyLParam,
  decodeMouseLParam,
  decodeWin32ClientRect,
  decodeWin32QueuedMessage,
  isCommitText,
  keyboardModifiers,
  keyboardStateForTranslation,
  logicalKeyFromVirtualKey,
  matchesWin32KeyMessage,
  repeatedWmCharText,
  ResultEchoSuppressor,
  shouldExposeAltGraph,
  TO_UNICODE_NO_STATE_CHANGE,
  translateLogicalKey,
  TranslateMessageReentrancyGuard,
  validateWin32Geometry,
  VK,
  Win32ClientState,
  Win32ImeAssociationState,
  win32KeyEditDisposition,
  win32KeyIdentity,
  Win32MessageQueueGate,
  Win32MouseCaptureState,
  Win32MouseTrackingState,
  win32QuitExitCode,
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
import { imm32functions, user32functions, WM } from "./ffi.ts";
import { Win32InputController, type Win32InputWindow } from "./input_controller.ts";
import {
  ImeActivationState,
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

Deno.test({
  name: "packed printable key repeats emit per-transition keydowns and one exactly-sized commit",
  fn() {
    const harness = createInputControllerHarness({ keyText: new Map([[0x41, "a"]]) });
    harness.controller.attach(harness.window);
    const lParam = makeKeyLParam(0x1e, { repeatCount: 3 });
    dispatchKeyDown(harness, 0x41, lParam);
    harness.controller.handleMessage(harness.window, WM.CHAR, "a".charCodeAt(0), lParam);

    const keydowns = harness.events.filter((event): event is KeyDownEvent => event.type === "keydown");
    assertEquals(keydowns.map((event) => event.repeat), [false, true, true]);
    assertEquals(keydowns.map((event) => [event.key, event.editDisposition]), [
      ["a", "text-input"],
      ["a", "text-input"],
      ["a", "text-input"],
    ]);
    assertEquals(
      harness.events.filter((event) => event.type === "ime"),
      [{ type: "ime", kind: "commit", text: "aaa", window: harness.window }],
    );
  },
});

Deno.test({
  name: "packed non-text repeats preserve Backspace, Delete, arrow, and shortcut edit multiplicity",
  fn() {
    const cases: ReadonlyArray<{
      name: string;
      virtualKey: number;
      scanCode: number;
      character?: number;
      extended?: boolean;
      shortcut?: boolean;
    }> = [
      { name: "Backspace", virtualKey: VK.BACK, scanCode: 0x0e, character: 0x08 },
      { name: "Delete", virtualKey: VK.DELETE, scanCode: 0x53, character: 0x7f, extended: true },
      { name: "ArrowLeft", virtualKey: VK.LEFT, scanCode: 0x4b, extended: true },
      { name: "z", virtualKey: 0x5a, scanCode: 0x2c, character: 0x1a, shortcut: true },
    ];

    for (const testCase of cases) {
      const harness = createInputControllerHarness({
        ...(testCase.shortcut
          ? {
            keyText: new Map([[testCase.virtualKey, "z"]]),
            keyboardState: [[VK.CONTROL, 0x80], [VK.LCONTROL, 0x80]],
          }
          : {}),
      });
      harness.controller.attach(harness.window);
      const lParam = makeKeyLParam(testCase.scanCode, {
        repeatCount: 4,
        previous: true,
        extended: testCase.extended ?? false,
      });
      dispatchKeyDown(harness, testCase.virtualKey, lParam);
      if (testCase.character !== undefined) {
        harness.controller.handleMessage(harness.window, WM.CHAR, testCase.character, lParam);
      }

      const keydowns = harness.events.filter((event): event is KeyDownEvent => event.type === "keydown");
      assertEquals(keydowns.length, 4, `${testCase.name} keydown count`);
      assertEquals(keydowns.map((event) => event.repeat), [true, true, true, true]);
      assertEquals(keydowns.map((event) => event.key), [
        testCase.name,
        testCase.name,
        testCase.name,
        testCase.name,
      ]);
      assertEquals(keydowns.map((event) => event.editDisposition), [
        "key-default",
        "key-default",
        "key-default",
        "key-default",
      ]);
      assertEquals(harness.events.filter((event) => event.type === "ime"), []);
    }
  },
});

Deno.test("TranslateMessage guard defers only sent-message reentry and preserves FIFO order", () => {
  const guard = new TranslateMessageReentrancyGuard();
  const order: string[] = [];
  assertEquals(guard.shouldDefer(1), false);
  guard.defer(() => order.push("outside"));
  guard.begin();
  assertEquals(guard.shouldDefer(0), false);
  assertEquals(guard.shouldDefer(1), true);
  guard.defer(() => order.push("focus"));
  guard.begin();
  guard.defer(() => order.push("ime"));
  guard.end();
  assertEquals(order, ["outside"]);
  guard.end();
  assertEquals(order, ["outside", "focus", "ime"]);
  assertThrows(() => guard.end());
});

Deno.test("Win32 queue gate leaves thread messages in FIFO order for its embedding host", () => {
  const ownedWindow = 0x1111n;
  const foreignWindow = 0x2222n;
  const customThreadMessage = 0x8007;
  const gate = new Win32MessageQueueGate();
  const queue = [
    { windowId: ownedWindow, message: WM.PAINT, wParam: 0n, lParam: 0n },
    { windowId: 0n, message: customThreadMessage, wParam: 0x1234n, lParam: -77n },
    { windowId: ownedWindow, message: WM.UNICHAR, wParam: 0x41n, lParam: 1n },
    { windowId: foreignWindow, message: WM.CLOSE, wParam: 0n, lParam: 0n },
  ];
  const dispatched: number[] = [];
  const pumpOwnedPrefix = () => {
    while (gate.mayPump && queue.length > 0) {
      const next = queue[0];
      if (gate.observe(next, next.windowId === ownedWindow) !== "dispatch") break;
      dispatched.push(queue.shift()!.message);
    }
  };

  pumpOwnedPrefix();
  assertEquals(dispatched, [WM.PAINT]);
  assertEquals(queue[0], {
    windowId: 0n,
    message: customThreadMessage,
    wParam: 0x1234n,
    lParam: -77n,
  });

  // Once the host removes its thread message, Winding resumes at the exact
  // next queue record and stops again before a foreign HWND.
  queue.shift();
  pumpOwnedPrefix();
  assertEquals(dispatched, [WM.PAINT, WM.UNICHAR]);
  assertEquals(queue[0].windowId, foreignWindow);
});

Deno.test("Win32 queue gate preserves WM_QUIT and latches after its signed exit code", () => {
  const buffer = new ArrayBuffer(48);
  const view = new DataView(buffer);
  view.setBigUint64(0, 0n, true);
  view.setUint32(8, WM.QUIT, true);
  view.setBigUint64(16, BigInt.asUintN(64, -123n), true);
  view.setBigInt64(24, 0n, true);
  const quit = decodeWin32QueuedMessage(buffer);
  assertEquals(quit, { windowId: 0n, message: WM.QUIT, wParam: 0xffffffffffffff85n, lParam: 0n });
  assertEquals(win32QuitExitCode(quit.wParam), -123);

  const gate = new Win32MessageQueueGate();
  assertEquals(gate.observe(quit, false), "quit");
  assertEquals(gate.mayPump, false);
  // The queue record was only observed, not removed; a second poll will not
  // repeatedly rediscover it and cannot turn into a busy loop.
  assertEquals(quit.wParam, 0xffffffffffffff85n);
});

Deno.test("Win32 client state reports visibility and authoritative size independently", () => {
  const state = new Win32ClientState();
  assertEquals(state.observe(false, 800, 600), { size: { width: 800, height: 600 } });
  assertEquals(state.observe(true, 800, 600), { visible: false });

  // A size change while minimized must not wait for an unrelated later resize.
  assertEquals(state.observe(true, 640, 480), { size: { width: 640, height: 480 } });
  // Restore can carry both visibility and a new drawable size.
  assertEquals(state.observe(false, 1024, 768), {
    visible: true,
    size: { width: 1024, height: 768 },
  });
  assertEquals(state.observe(false, 1024, 768), {});
  // Maximize is still visible, so only its dimensions change.
  assertEquals(state.observe(false, 1920, 1080), { size: { width: 1920, height: 1080 } });
});

Deno.test("Win32 client state preserves zero and dimensions wider than WM_SIZE words", () => {
  const rectangle = new ArrayBuffer(16);
  const view = new DataView(rectangle);
  view.setInt32(0, 0, true);
  view.setInt32(4, 0, true);
  view.setInt32(8, 70_000, true);
  view.setInt32(12, 0, true);
  const oversizedZeroHeight = decodeWin32ClientRect(rectangle);
  assertEquals(oversizedZeroHeight, { width: 70_000, height: 0 });

  const state = new Win32ClientState();
  assertEquals(state.observe(false, oversizedZeroHeight.width, oversizedZeroHeight.height), {
    size: oversizedZeroHeight,
  });
  assertEquals(state.contains(69_999, 0), false);
  assertThrows(() => decodeWin32ClientRect(new ArrayBuffer(15)), RangeError, "truncated RECT");

  view.setInt32(0, 10, true);
  view.setInt32(8, 9, true);
  assertThrows(() => decodeWin32ClientRect(rectangle), Error, "invalid client rectangle");
});

Deno.test("Win32 HIMC association remains independent across SETCONTEXT and focus orders", () => {
  const setContextFirst = new ImeActivationState();
  setContextFirst.setAvailable(true);
  setContextFirst.setDesired(true);
  setContextFirst.setFocused(true);
  setContextFirst.markActive(true);
  const firstAssociation = new Win32ImeAssociationState(true);

  // WM_IME_SETCONTEXT(FALSE) observes native deactivation but does not prove
  // that the persistent HWND association was removed.
  setContextFirst.markActive(false);
  assertEquals(setContextFirst.active, false);
  assertEquals(firstAssociation.associated, true);
  setContextFirst.setFocused(false);
  const firstTransitions: boolean[] = [];
  firstAssociation.reconcile(setContextFirst.shouldBeActive, (associated) => {
    firstTransitions.push(associated);
    return true;
  });
  assertEquals(firstTransitions, [false]);
  assertEquals(firstAssociation.associated, false);

  const focusFirst = new ImeActivationState();
  focusFirst.setAvailable(true);
  focusFirst.setDesired(true);
  focusFirst.setFocused(true);
  focusFirst.markActive(true);
  const secondAssociation = new Win32ImeAssociationState(true);
  focusFirst.setFocused(false);
  const secondTransitions: boolean[] = [];
  secondAssociation.reconcile(focusFirst.shouldBeActive, (associated) => {
    secondTransitions.push(associated);
    return true;
  });
  focusFirst.reconcile({ activate: () => true, deactivate: () => {} });
  focusFirst.markActive(false);
  assertEquals(secondTransitions, [false]);
  assertEquals(secondAssociation.associated, false);
  assertEquals(focusFirst.active, false);
});

Deno.test("Win32 HIMC association advances only after confirmed native success", () => {
  const association = new Win32ImeAssociationState(true);
  const attempts: boolean[] = [];
  assertEquals(
    association.reconcile(false, (next) => {
      attempts.push(next);
      return false;
    }),
    false,
  );
  assertEquals(association.associated, true);
  assertEquals(
    association.reconcile(false, (next) => {
      attempts.push(next);
      return true;
    }),
    true,
  );
  assertEquals(attempts, [false, false]);
  assertEquals(association.associated, false);
});

Deno.test("Win32 input rejects failed initial disassociation", () => {
  const harness = createInputControllerHarness({ associateResults: [0] });
  assertThrows(() => harness.controller.attach(harness.window), Error, "initial HIMC");
  assertEquals(harness.calls.associationFlags, [0]);
});

Deno.test("Win32 input reports both failed IME placement operations", () => {
  const harness = createInputControllerHarness({ candidateResult: 0, compositionResult: 0 });
  harness.controller.attach(harness.window);
  harness.controller.observeNativeFocus(harness.window, true);
  harness.controller.setImeCursorArea(harness.window, 1, 2, 3, 4);
  assertThrows(() => harness.controller.setImeEnabled(harness.window, true), AggregateError);
  assertEquals(harness.calls.candidatePlacements, 1);
  assertEquals(harness.calls.compositionPlacements, 1);
  assertEquals(harness.calls.releases, 1);
});

Deno.test("Win32 input recovers association after native cancellation failure", () => {
  const harness = createInputControllerHarness({ notifyResult: 0 });
  harness.controller.attach(harness.window);
  harness.controller.observeNativeFocus(harness.window, true);
  harness.controller.setImeEnabled(harness.window, true);
  assertEquals(harness.controller.handleMessage(harness.window, WM.IME_STARTCOMPOSITION, 0n, 0n), 0n);
  assertThrows(() => harness.controller.setImeEnabled(harness.window, false), Error, "cancellation failed");
  assertEquals(harness.calls.notifications, 1);
  assertEquals(harness.calls.associationFlags.at(-1), 0);
});

Deno.test("Win32 input reports context release failure", () => {
  const harness = createInputControllerHarness({ releaseResult: 0 });
  harness.controller.attach(harness.window);
  harness.controller.observeNativeFocus(harness.window, true);
  harness.controller.setImeEnabled(harness.window, true);
  assertEquals(harness.controller.handleMessage(harness.window, WM.IME_STARTCOMPOSITION, 0n, 0n), 0n);
  assertThrows(() => harness.controller.setImeEnabled(harness.window, false), Error, "ImmReleaseContext failed");
  assertEquals(harness.calls.releases, 1);
});

Deno.test("prepared Win32 keys match the complete native message identity", () => {
  const prepared = { windowId: 1n, message: 0x0104, virtualKey: 0x51, lParam: 0x2010001n };
  assertEquals(matchesWin32KeyMessage(prepared, { ...prepared }), true);
  assertEquals(matchesWin32KeyMessage(prepared, { ...prepared, windowId: 2n }), false);
  assertEquals(matchesWin32KeyMessage(prepared, { ...prepared, message: 0x0100 }), false);
  assertEquals(matchesWin32KeyMessage(prepared, { ...prepared, lParam: prepared.lParam | (1n << 30n) }), false);
});

Deno.test("Win32 validates signed outer-window geometry before native creation", () => {
  validateWin32Geometry(-100, 20, 800, 600);
  validateWin32Geometry(-0x80000000, 0x7fffffff, 1, 0x7fffffff);
  assertThrows(() => validateWin32Geometry(Number.NaN, 0, 1, 1));
  assertThrows(() => validateWin32Geometry(0, 0.5, 1, 1));
  assertThrows(() => validateWin32Geometry(-0x80000001, 0, 1, 1));
  assertThrows(() => validateWin32Geometry(0, 0, 0, 1));
  assertThrows(() => validateWin32Geometry(0, 0, 1.5, 1));
  assertThrows(() => validateWin32Geometry(0, 0, 0x80000000, 1));
});

Deno.test("Win32 mouse coordinates sign-extend and leave tracking follows real crossings", () => {
  assertEquals(decodeMouseLParam(0xfffeffffn), { x: -1, y: -2 });
  assertEquals(decodeMouseLParam(0x80007fffn), { x: 0x7fff, y: -0x8000 });

  const tracking = new Win32MouseTrackingState();
  assertEquals(tracking.needsLeaveTracking(false), false);
  assertEquals(tracking.observeMove(false), false);
  assertEquals(tracking.needsLeaveTracking(true), true);
  tracking.markLeaveTrackingArmed();
  assertEquals(tracking.observeMove(true), true);
  assertEquals(tracking.needsLeaveTracking(true), false);
  assertEquals(tracking.observeMove(true), false);
  assertEquals(tracking.observeLeave(), true);
  assertEquals(tracking.observeLeave(), false);
  assertEquals(tracking.needsLeaveTracking(false), false);
  assertEquals(tracking.needsLeaveTracking(true), true);
});

Deno.test("Win32 mouse capture state follows one owner and complete button chords", () => {
  const capture = new Win32MouseCaptureState();
  capture.recordDown(1n, "left");
  capture.recordDown(1n, "left");
  capture.recordDown(1n, "middle");
  assertEquals(capture.owner, 1n);
  assertEquals(capture.buttonCount, 2);
  assertEquals(capture.releaseWouldEnd(1n, "left"), false);
  capture.recordUp(1n, "left");
  assertEquals(capture.releaseWouldEnd(1n, "middle"), true);
  assertEquals(capture.resetOwner(2n), false);
  assertEquals(capture.resetOwner(1n), true);
  assertEquals(capture.buttonCount, 0);

  capture.recordDown(1n, "right");
  capture.recordDown(2n, "left");
  assertEquals(capture.owner, 2n);
  assertEquals(capture.buttonCount, 1);
  assertEquals(capture.hasButton("right"), false);
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

Deno.test("printable physical Ctrl+Alt layout levels use browser AltGraph ownership", () => {
  const state = keyboardState([
    [VK.SHIFT, 0x80],
    [VK.CONTROL, 0x80],
    [VK.LCONTROL, 0x80],
    [VK.MENU, 0x80],
    [VK.LMENU, 0x80],
  ]);
  const translated = translateLogicalKey(0x51, makeKeyLParam(0x10), state, {
    toUnicode(_virtualKey, _scanCode, translatedState) {
      assert(translatedState[VK.SHIFT] >= 0x80);
      assert(translatedState[VK.LCONTROL] >= 0x80);
      assert(translatedState[VK.LMENU] >= 0x80);
      return { result: 1, text: "@" };
    },
  }, true);
  assertEquals(translated.key, "@");
  assertEquals(translated.text, "@");
  assertEquals(translated.modifiers.altGraphKey, false);

  const altGraphKey = shouldExposeAltGraph(translated.modifiers, true, translated.text !== undefined);
  const browserModifiers = {
    ...translated.modifiers,
    altGraphKey,
    accelKey: translated.modifiers.ctrlKey && !altGraphKey,
  };
  assertEquals(browserModifiers.altGraphKey, true);
  assertEquals(browserModifiers.accelKey, false);
  assertEquals(win32KeyEditDisposition("@", false, browserModifiers, "@", true), "text-input");
});

Deno.test("non-text Ctrl+Alt shortcuts keep their plain key and platform ownership", () => {
  const state = keyboardState([
    [VK.CONTROL, 0x80],
    [VK.LCONTROL, 0x80],
    [VK.MENU, 0x80],
    [VK.LMENU, 0x80],
  ]);
  let calls = 0;
  const translated = translateLogicalKey(0x43, makeKeyLParam(0x2e), state, {
    toUnicode(_virtualKey, _scanCode, translatedState) {
      calls++;
      if ((translatedState[VK.CONTROL] & 0x80) !== 0) return { result: 0, text: "" };
      assertEquals(translatedState[VK.LCONTROL] & 0x80, 0);
      assertEquals(translatedState[VK.LMENU] & 0x80, 0);
      return { result: 1, text: "c" };
    },
  }, true);
  assertEquals(calls, 2);
  assertEquals(translated.key, "c");
  assertEquals(translated.text, undefined);
  assertEquals(shouldExposeAltGraph(translated.modifiers, true, false), false);
  assertEquals(win32KeyEditDisposition("c", false, translated.modifiers, undefined, true), "platform");
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

Deno.test("IME context helper reports release failure without hiding operation failure", () => {
  assertThrows(
    () =>
      withImeContext(
        () => ({ id: 1 }),
        () => {
          throw new Error("release failed");
        },
        () => "done",
      ),
    Error,
    "release failed",
  );
  assertThrows(
    () =>
      withImeContext(
        () => ({ id: 2 }),
        () => {
          throw new Error("release failed");
        },
        () => {
          throw new Error("operation failed");
        },
      ),
    AggregateError,
  );
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

interface FakeImmBehavior {
  associateResults?: number[];
  candidateResult?: number;
  compositionResult?: number;
  notifyResult?: number;
  releaseResult?: number;
  keyText?: ReadonlyMap<number, string>;
  keyboardState?: ReadonlyArray<readonly [virtualKey: number, state: number]>;
}

function createInputControllerHarness(behavior: FakeImmBehavior = {}) {
  const hwnd = {} as Deno.PointerObject;
  const context = {} as Deno.PointerObject;
  const calls = {
    associationFlags: [] as number[],
    candidatePlacements: 0,
    compositionPlacements: 0,
    notifications: 0,
    releases: 0,
  };
  const events: UIEvent[] = [];
  const user32 = {
    symbols: {
      DefWindowProcW: () => 0n,
      GetKeyboardState(target: Uint8Array) {
        target.fill(0);
        for (const [virtualKey, state] of behavior.keyboardState ?? []) target[virtualKey] = state;
        return 1;
      },
      GetKeyboardLayout: () => null,
      GetKeyState: () => 0,
      PeekMessageW: () => 0,
      ToUnicodeEx(
        virtualKey: number,
        _scanCode: number,
        _keyboardState: Uint8Array,
        output: Uint16Array,
      ) {
        const text = behavior.keyText?.get(virtualKey);
        if (text === undefined) return 0;
        for (let index = 0; index < text.length; index++) output[index] = text.charCodeAt(index);
        return text.length;
      },
    },
  } as unknown as Deno.DynamicLibrary<typeof user32functions>;
  const imm32 = {
    symbols: {
      ImmAssociateContextEx(_window: unknown, _context: unknown, flags: number) {
        calls.associationFlags.push(flags);
        return behavior.associateResults?.shift() ?? 1;
      },
      ImmGetContext: () => context,
      ImmReleaseContext() {
        calls.releases++;
        return behavior.releaseResult ?? 1;
      },
      ImmNotifyIME() {
        calls.notifications++;
        return behavior.notifyResult ?? 1;
      },
      ImmSetCandidateWindow() {
        calls.candidatePlacements++;
        return behavior.candidateResult ?? 1;
      },
      ImmSetCompositionWindow() {
        calls.compositionPlacements++;
        return behavior.compositionResult ?? 1;
      },
      ImmGetCompositionStringW: () => 0,
    },
  } as unknown as Deno.DynamicLibrary<typeof imm32functions>;
  const window: Win32InputWindow = {
    id: 1n,
    hwnd,
    close() {},
    setTitle() {},
    blit() {},
    setImeEnabled() {},
    setImeSurroundingText() {},
    setImeCursorArea() {},
    [Symbol.dispose]() {},
  };
  const controller = new Win32InputController(
    user32,
    imm32,
    (event) => events.push(event),
    (id) => id === window.id ? window : undefined,
  );
  return { calls, controller, events, window };
}

function dispatchKeyDown(
  harness: ReturnType<typeof createInputControllerHarness>,
  virtualKey: number,
  lParam: bigint,
): void {
  harness.controller.handleMessage(harness.window, WM.KEYDOWN, virtualKey, lParam);
}
