import {
  type ComposeAdapter,
  ComposeFeedResult,
  ComposeStatus,
  KeyRepeatController,
  resolveComposeLocale,
  toXkbKeycode,
  translateKey,
  waylandKeyEditDisposition,
  type XkbKeyTranslator,
} from "./keyboard.ts";
import { WlOp } from "./ffi.ts";
import { TextInputV3Batch } from "./text_input.ts";
import { keyLocationForCode, normalizeImeCursorArea, validateImeCursorRange } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";
import {
  hasFatalPollEvent,
  POLLERR,
  POLLHUP,
  POLLIN,
  POLLNVAL,
  pointerCapabilityAction,
  waylandConnectionError,
} from "./protocol.ts";
import {
  damageOpcodeForSurfaceVersion,
  frameMatchesConfiguration,
  WaylandConfigureState,
} from "./window.ts";

Deno.test("Wayland surface damage uses only requests supported by the bound version", () => {
  assertEquals(damageOpcodeForSurfaceVersion(1), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(3), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(4), WlOp.SURFACE_DAMAGE_BUFFER);
  assertEquals(damageOpcodeForSurfaceVersion(6), WlOp.SURFACE_DAMAGE_BUFFER);
});

Deno.test("Wayland connection errors retain protocol object details", () => {
  assertEquals(
    waylandConnectionError("dispatching display events", 71, "xdg_surface", 42, 3).message,
    "winding Wayland connection failed during dispatching display events: " +
      "xdg_surface@42 reported protocol error 3 (display error 71)",
  );
  assertEquals(
    waylandConnectionError("reading display events", 0).message,
    "winding Wayland connection closed during reading display events",
  );
});

Deno.test("Wayland poll errors and disconnects are terminal readiness", () => {
  assertEquals(hasFatalPollEvent(POLLIN), false);
  assertEquals(hasFatalPollEvent(POLLERR), true);
  assertEquals(hasFatalPollEvent(POLLHUP), true);
  assertEquals(hasFatalPollEvent(POLLNVAL), true);
  assertEquals(hasFatalPollEvent(POLLIN | POLLHUP), true);
});

Deno.test("Wayland pointer capability transitions are symmetric", () => {
  assertEquals(pointerCapabilityAction(true, false), "acquire");
  assertEquals(pointerCapabilityAction(false, true), "release");
  assertEquals(pointerCapabilityAction(true, true), undefined);
  assertEquals(pointerCapabilityAction(false, false), undefined);
});

Deno.test("Wayland configurations latch role state and serial as one generation", () => {
  const state = new WaylandConfigureState(640, 480);
  state.stageToplevel(800, 600, false);
  const first = state.complete(17);
  state.stageToplevel(1920, 1080, true);
  const second = state.complete(18);

  assertEquals(first, {
    configuration: {
      serial: 17,
      width: 800,
      height: 600,
      suspended: false,
      frameToken: 1,
    },
    visibilityChanged: false,
  });
  assertEquals(second, {
    configuration: {
      serial: 18,
      width: 1920,
      height: 1080,
      suspended: true,
      frameToken: 2,
    },
    visibilityChanged: true,
  });
  assertEquals(frameMatchesConfiguration(second.configuration, 800, 600, 1), false);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, 1), false);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, 2), true);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, undefined), true);
});

Deno.test("zero configure dimensions retain each client-selected axis independently", () => {
  const state = new WaylandConfigureState(640, 480);
  state.stageToplevel(1200, 0, false);
  assertEquals(state.complete(0).configuration, {
    serial: 0,
    width: 1200,
    height: 480,
    suspended: false,
    frameToken: 1,
  });

  state.stageToplevel(0, 900, false);
  assertEquals(state.complete(1).configuration, {
    serial: 1,
    width: 1200,
    height: 900,
    suspended: false,
    frameToken: 2,
  });
});

Deno.test("Compose locale resolution follows the locale precedence and ignores empty values", () => {
  const environment = new Map([
    ["LC_ALL", ""],
    ["LC_CTYPE", "de_DE.UTF-8"],
    ["LANG", "en_US.UTF-8"],
  ]);

  assertEquals(resolveComposeLocale((name) => environment.get(name)), "de_DE.UTF-8");
  environment.set("LC_ALL", "pl_PL.UTF-8");
  assertEquals(resolveComposeLocale((name) => environment.get(name)), "pl_PL.UTF-8");
});

Deno.test("Compose locale resolution tolerates inaccessible variables and falls back to C", () => {
  assertEquals(
    resolveComposeLocale((name) => {
      if (name === "LC_ALL") throw new Error("permission denied");
      return name === "LANG" ? "fr_FR.UTF-8" : undefined;
    }),
    "fr_FR.UTF-8",
  );
  assertEquals(resolveComposeLocale(() => undefined), "C");
});

Deno.test("Wayland raw keycodes remain separate from xkb keycodes", () => {
  assertEquals(toXkbKeycode(0), 8);
  assertEquals(toXkbKeycode(16), 24);

  let receivedKeycode = -1;
  const translator = translatorFor({
    keysym: 0x71,
    keyText: "q",
    text: "q",
    onKeycode: (keycode) => receivedKeycode = keycode,
  });
  const translated = translateKey(16, "press", translator);

  assertEquals(receivedKeycode, 24);
  assertEquals(translated, {
    rawKeycode: 16,
    xkbKeycode: 24,
    keysym: 0x71,
    key: "q",
    text: "q",
    isComposing: false,
  });
});

Deno.test("key locations distinguish modifiers and numpad keys from arrows", () => {
  assertEquals(keyLocationForCode("ShiftLeft"), 1);
  assertEquals(keyLocationForCode("AltRight"), 2);
  assertEquals(keyLocationForCode("Numpad1"), 3);
  assertEquals(keyLocationForCode("NumpadParenLeft"), 3);
  assertEquals(keyLocationForCode("ArrowLeft"), 0);
  assertEquals(keyLocationForCode("ArrowRight"), 0);
  assertEquals(keyLocationForCode("KeyA"), 0);
});

Deno.test("key release resolves a logical key without generating text or feeding Compose", () => {
  let textLookups = 0;
  const translator = translatorFor({
    keysym: 0xff51,
    keyText: "",
    text: "ignored",
    onTextLookup: () => textLookups++,
  });
  const compose = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.NOTHING, "ignored");

  assertEquals(translateKey(105, "release", translator, compose), {
    rawKeycode: 105,
    xkbKeycode: 113,
    keysym: 0xff51,
    key: "ArrowLeft",
    isComposing: false,
  });
  assertEquals(textLookups, 0);
  assertEquals(compose.feedCount, 0);
});

Deno.test("Compose translation handles composing, composed, cancelled, and ignored feeds", () => {
  const translator = translatorFor({ keysym: 0x65, keyText: "e", text: "e" });

  const composing = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.COMPOSING, "");
  assertEquals(translateKey(18, "press", translator, composing), {
    rawKeycode: 18,
    xkbKeycode: 26,
    keysym: 0x65,
    key: "e",
    isComposing: true,
  });
  assertEquals(composing.resetCount, 0);

  const composed = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.COMPOSED, "é");
  assertEquals(translateKey(18, "press", translator, composed), {
    rawKeycode: 18,
    xkbKeycode: 26,
    keysym: 0x65,
    key: "é",
    text: "é",
    isComposing: false,
  });
  assertEquals(composed.resetCount, 1);

  const cancelled = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.CANCELLED, "unused");
  assertEquals(translateKey(18, "press", translator, cancelled).text, undefined);
  assertEquals(cancelled.resetCount, 1);

  const ignored = new FakeCompose(ComposeFeedResult.IGNORED, ComposeStatus.COMPOSING, "unused");
  const ignoredResult = translateKey(18, "press", translator, ignored);
  assertEquals(ignoredResult.text, undefined);
  assertEquals(ignoredResult.isComposing, true);
  assertEquals(ignored.resetCount, 0);
});

Deno.test("Compose NOTHING falls back to the active xkb layout text", () => {
  const translator = translatorFor({ keysym: 0x010020ac, keyText: "€", text: "€" });
  const compose = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.NOTHING, "");

  const result = translateKey(18, "repeat", translator, compose);
  assertEquals(result.key, "€");
  assertEquals(result.text, "€");
  assertEquals(result.isComposing, false);
});

Deno.test("xkb control strings stay named keys and are not committed as text", () => {
  const controls = [
    { keysym: 0xff08, keyText: "\b", text: "\b", key: "Backspace" },
    { keysym: 0xff09, keyText: "\t", text: "\t", key: "Tab" },
    { keysym: 0xff0d, keyText: "\r", text: "\r", key: "Enter" },
  ];

  for (const control of controls) {
    const result = translateKey(1, "press", translatorFor(control));
    assertEquals(result.key, control.key);
    assertEquals(result.text, undefined);
  }
});

Deno.test("Wayland edit ownership leaves delivered shortcuts to key defaults", () => {
  const plain = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
  assertEquals(waylandKeyEditDisposition("a", "a", false, plain), "text-input");
  assertEquals(waylandKeyEditDisposition("ArrowLeft", undefined, false, plain), "key-default");
  assertEquals(
    waylandKeyEditDisposition("a", "a", false, { ...plain, altKey: true }),
    "key-default",
  );
  assertEquals(
    waylandKeyEditDisposition("c", undefined, false, { ...plain, ctrlKey: true, accelKey: true }),
    "key-default",
  );
  assertEquals(
    waylandKeyEditDisposition("@", "@", false, {
      ...plain,
      ctrlKey: true,
      altKey: true,
      altGraphKey: true,
    }),
    "text-input",
  );
  assertEquals(waylandKeyEditDisposition("Dead", undefined, false, plain), "text-input");
});

Deno.test("logical keysym mapping covers printable, named, dead, function, and keypad keys", () => {
  assertEquals(logicalKeyFromKeysym(0x010020ac, "€"), "€");
  assertEquals(logicalKeyFromKeysym(0x0101f642), "🙂");
  assertEquals(logicalKeyFromKeysym(0xff08), "Backspace");
  assertEquals(logicalKeyFromKeysym(0xffca), "F13");
  assertEquals(logicalKeyFromKeysym(0xffb7), "7");
  assertEquals(logicalKeyFromKeysym(0xfe51), "Dead");
  assertEquals(logicalKeyFromKeysym(0xfe03), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0x1234, "\n"), "Unidentified");
  assertEquals(logicalKeyFromKeysym(0x1234), "Unidentified");
});

Deno.test("preedit cursor ranges use UTF-8 byte boundaries", () => {
  assertEquals(validateImeCursorRange("plain", 1, 4), [1, 4]);
  assertEquals(validateImeCursorRange("é日", 2, 5), [2, 5]);
  assertEquals(validateImeCursorRange("é日", 1, 5), null);
  assertEquals(validateImeCursorRange("é日", 2, 4), null);
  assertEquals(validateImeCursorRange("é日", 5, 6), null);
  assertEquals(validateImeCursorRange("text", -1, -1), null);
  assertEquals(validateImeCursorRange("text", 3, 2), null);
  assertEquals(validateImeCursorRange("", 0, 0), [0, 0]);
});

Deno.test("cursor rectangles are outward-rounded and clamped to Wayland ints", () => {
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

Deno.test("text-input done flushes edits in protocol order and reports serial matches", () => {
  const batch = new TextInputV3Batch();
  assertEquals(batch.recordClientCommit(), 1);
  batch.setPreedit("éx", 2, 3);

  assertEquals(batch.done(1), {
    serial: 1,
    serialMatches: true,
    edits: [{ type: "preedit", text: "éx", cursorRange: [2, 3] }],
  });
  assert(batch.hasVisiblePreedit);

  batch.setDeleteSurrounding(4, 2);
  batch.setCommit("好");
  batch.setPreedit("next", 1, 3);
  assertEquals(batch.done(0), {
    serial: 0,
    serialMatches: false,
    edits: [
      { type: "deleteSurrounding", beforeBytes: 4, afterBytes: 2 },
      { type: "commit", text: "好" },
      { type: "preedit", text: "next", cursorRange: [1, 3] },
    ],
  });
});

Deno.test("text-input pending fields reset after every done and invalid cursors are hidden", () => {
  const batch = new TextInputV3Batch();
  batch.setDeleteSurrounding(-10, Number.POSITIVE_INFINITY);
  batch.setCommit(null);
  batch.setCommit("\u0003");
  batch.setPreedit("é", 1, 2);

  assertEquals(batch.done(0).edits, [
    { type: "preedit", text: "é", cursorRange: null },
  ]);
  assertEquals(batch.done(0).edits, []);
  assertEquals(batch.hasVisiblePreedit, true);
});

Deno.test("text-input commits atomically end preedit without a separate clear", () => {
  const batch = new TextInputV3Batch();
  batch.setCommit("committed");

  assertEquals(batch.done(0).edits, [{ type: "commit", text: "committed" }]);
});

Deno.test("resetEdits clears both visible and uncommitted text-input state", () => {
  const batch = new TextInputV3Batch();
  batch.setPreedit("visible", 0, 0);
  batch.done(0);
  batch.setCommit("must not leak");

  assertEquals(batch.resetEdits(), [{ type: "preedit", text: "", cursorRange: null }]);
  assertEquals(batch.done(0).edits, []);
});

Deno.test("key repeat honors delay and rate while skipping missed catch-up events", () => {
  let now = 0;
  const repeat = new KeyRepeatController(() => now);
  repeat.setRepeatInfo(25, 400);
  repeat.press(30, true);

  now = 399;
  assertEquals(repeat.poll(), undefined);
  now = 400;
  assertEquals(repeat.poll(), 30);
  assertEquals(repeat.nextDeadline, 440);
  assertEquals(repeat.poll(), undefined);

  now = 600;
  assertEquals(repeat.poll(), 30);
  assertEquals(repeat.nextDeadline, 640);
  assertEquals(repeat.poll(), undefined);
});

Deno.test("repeat returns the raw key for translation under the latest xkb state", () => {
  let now = 0;
  let text = "a";
  const repeat = new KeyRepeatController(() => now);
  const translator: XkbKeyTranslator = {
    keysymForKeycode: () => text.codePointAt(0)!,
    utf8ForKeycode: () => text,
    utf8ForKeysym: () => text,
  };
  repeat.setRepeatInfo(10, 0);
  repeat.press(30, true);

  const firstKeycode = repeat.poll();
  assertEquals(firstKeycode, 30);
  assertEquals(translateKey(firstKeycode!, "repeat", translator).text, "a");

  text = "A";
  now = 100;
  const secondKeycode = repeat.poll();
  assertEquals(secondKeycode, 30);
  assertEquals(translateKey(secondKeycode!, "repeat", translator).text, "A");
});

Deno.test("key repeat replaces repeatable keys and cancels only on matching release", () => {
  const now = 10;
  const repeat = new KeyRepeatController(() => now);
  repeat.setRepeatInfo(10, 100);
  repeat.press(20, true);
  repeat.press(21, false);
  assertEquals(repeat.activeKeycode, 20);

  repeat.release(21);
  assertEquals(repeat.activeKeycode, 20);
  repeat.press(22, true);
  assertEquals(repeat.activeKeycode, 22);
  assertEquals(repeat.nextDeadline, 110);

  repeat.release(22);
  assertEquals(repeat.activeKeycode, undefined);
  assertEquals(repeat.nextDeadline, undefined);
});

Deno.test("non-positive repeat rates disable an active repeat", () => {
  const repeat = new KeyRepeatController(() => 0);
  repeat.setRepeatInfo(30, 200);
  repeat.press(12, true);
  repeat.setRepeatInfo(0, 200);

  assertEquals(repeat.activeKeycode, undefined);
  assertEquals(repeat.poll(), undefined);
});

interface TranslatorOptions {
  keysym: number;
  keyText: string;
  text: string;
  onKeycode?: (keycode: number) => void;
  onTextLookup?: () => void;
}

function translatorFor(options: TranslatorOptions): XkbKeyTranslator {
  return {
    keysymForKeycode(keycode) {
      options.onKeycode?.(keycode);
      return options.keysym;
    },
    utf8ForKeycode() {
      options.onTextLookup?.();
      return options.text;
    },
    utf8ForKeysym() {
      return options.keyText;
    },
  };
}

class FakeCompose implements ComposeAdapter {
  feedCount = 0;
  resetCount = 0;

  constructor(
    readonly feedResult: number,
    readonly composeStatus: number,
    readonly composedText: string,
  ) {}

  feed(): number {
    this.feedCount++;
    return this.feedResult;
  }

  status(): number {
    return this.composeStatus;
  }

  utf8(): string {
    return this.composedText;
  }

  reset(): void {
    this.resetCount++;
  }
}

function assert(value: unknown, message = "Expected value to be truthy"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (deepEquals(actual, expected)) return;
  throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
}

function deepEquals(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) {
    return false;
  }

  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  if (actualKeys.length !== expectedKeys.length) return false;
  return actualKeys.every((key) =>
    Object.hasOwn(expectedRecord, key) && deepEquals(actualRecord[key], expectedRecord[key])
  );
}
