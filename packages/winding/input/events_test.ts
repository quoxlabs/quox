import type { Window } from "../types.ts";
import {
  ClickCounter,
  createImeCommitEvent,
  createImeDeleteSurroundingEvent,
  createImePreeditEvent,
  createImeReplaceEvent,
  createKeyDownEvent,
  createKeyUpEvent,
  type KeyEventInit,
  NativeEventClock,
} from "./events.ts";

Deno.test("click counters preserve releases and reset by button, time, or distance", () => {
  const clicks = new ClickCounter<string>(500, 4);
  assertEquals(clicks.detail("left", true, 100, 10, 10), 1);
  assertEquals(clicks.detail("left", false, 110, 10, 10), 1);
  assertEquals(clicks.detail("left", true, 200, 12, 13), 2);
  assertEquals(clicks.detail("left", false, 210, 12, 13), 2);
  assertEquals(clicks.detail("right", true, 220, 12, 13), 1);
  assertEquals(clicks.detail("left", true, 800, 12, 13), 1);
  assertEquals(clicks.detail("left", true, 900, 30, 13), 1);
});

Deno.test("native event clocks map monotonic time and unwrap 32-bit rollover", () => {
  const clock = new NativeEventClock(2 ** 32, () => 250);
  assertEquals(clock.timeStamp(0xffff_fff0), 250);
  assertEquals(clock.timeStamp(0xffff_fff8), 258);
  assertEquals(clock.timeStamp(8), 274);
  assertEquals(clock.timeStamp(Number.NaN), 250);
});

const window = {} as Window;
const key: KeyEventInit = {
  window,
  keycode: 30,
  code: "KeyA",
  key: "a",
  isComposing: false,
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

Deno.test("final key builders fill every canonical field", () => {
  assertEquals(
    createKeyDownEvent({
      ...key,
      repeat: false,
      editDisposition: "text-input",
      sourceKeyInputId: 17,
    }),
    {
      type: "keydown",
      window,
      keycode: 30,
      code: "KeyA",
      key: "a",
      location: 0,
      isComposing: false,
      repeat: false,
      editDisposition: "text-input",
      sourceKeyInputId: 17,
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
    },
  );

  const control = createKeyDownEvent({
    ...key,
    code: "",
    key: undefined,
    repeat: true,
    editDisposition: "platform",
  });
  assertEquals(control.code, "Unidentified");
  assertEquals(control.key, "Unidentified");

  assertEquals(createKeyUpEvent({ ...key, code: "ShiftRight", key: "Shift" }), {
    type: "keyup",
    window,
    keycode: 30,
    code: "ShiftRight",
    key: "Shift",
    location: 2,
    isComposing: false,
    repeat: false,
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
  });
});

Deno.test("final key builders sanitize native location hints after logical remapping", () => {
  assertEquals(
    createKeyDownEvent({
      ...key,
      code: "ShiftLeft",
      key: "a",
      location: 1,
      repeat: false,
      editDisposition: "text-input",
    }).location,
    0,
  );
  assertEquals(createKeyUpEvent({ ...key, code: "KeyA", key: "Control", location: 1 }).location, 1);
  assertEquals(createKeyUpEvent({ ...key, code: "NumLock", key: "NumLock", location: 3 }).location, 0);
  assertEquals(createKeyUpEvent({ ...key, code: "Numpad1", key: "End", location: 3 }).location, 3);
});

Deno.test("IME builders enforce canonical cursor, commit, and deletion shapes", () => {
  assertEquals(createImePreeditEvent(window, "éx", [2, 3]), {
    type: "ime",
    kind: "preedit",
    window,
    text: "éx",
    cursorRange: [2, 3],
  });
  assertEquals(createImePreeditEvent(window, "éx", [1, 3]), {
    type: "ime",
    kind: "preedit",
    window,
    text: "éx",
    cursorRange: null,
  });
  assertEquals(createImePreeditEvent(window, "", [0, 0]), {
    type: "ime",
    kind: "preedit",
    window,
    text: "",
    cursorRange: null,
  });
  assertEquals(createImeCommitEvent(window, ""), undefined);
  for (
    const text of ["\u0000", "\t", "\n", "\u001f", "\u007f", "\u0080", "\u009f"]
  ) {
    assertEquals(createImeCommitEvent(window, text), {
      type: "ime",
      kind: "commit",
      window,
      text,
    });
  }
  assertEquals(createImeCommitEvent(window, "日本"), {
    type: "ime",
    kind: "commit",
    window,
    text: "日本",
  });
  assertEquals(createImeCommitEvent(window, "paired", 17), {
    type: "ime",
    kind: "commit",
    window,
    text: "paired",
    sourceKeyInputId: 17,
  });
  assertEquals(createImeDeleteSurroundingEvent(window, 0, 0), undefined);
  assertEquals(createImeDeleteSurroundingEvent(window, -1, 2), undefined);
  assertEquals(createImeDeleteSurroundingEvent(window, 4, 2), {
    type: "ime",
    kind: "deleteSurrounding",
    window,
    beforeBytes: 4,
    afterBytes: 2,
  });
  assertEquals(createImeReplaceEvent(window, "A🙂B", 1, 5, "x"), {
    type: "ime",
    kind: "replace",
    window,
    startBytes: 1,
    endBytes: 5,
    text: "x",
  });
  assertEquals(createImeReplaceEvent(window, "A🙂B", 2, 5, "x"), undefined);
  assertEquals(createImeReplaceEvent(window, "A🙂B", 5, 1, "x"), undefined);
});

Deno.test("source key input ids must be positive uint32 values", () => {
  assertRangeError(() =>
    createKeyDownEvent({
      ...key,
      repeat: false,
      editDisposition: "text-input",
      sourceKeyInputId: 0,
    })
  );
  assertRangeError(() => createImeCommitEvent(window, "x", 1.5));
  assertRangeError(() => createImeCommitEvent(window, "x", 0x1_0000_0000));
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertRangeError(callback: () => unknown): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof RangeError) return;
    throw error;
  }
  throw new Error("Expected RangeError");
}
