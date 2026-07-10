import type { Window } from "../types.ts";
import {
  createImeCommitEvent,
  createImeDeleteSurroundingEvent,
  createImePreeditEvent,
  createKeyDownEvent,
  createKeyUpEvent,
  type KeyEventInit,
} from "./events.ts";

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
};

Deno.test("final key builders fill every canonical field", () => {
  assertEquals(
    createKeyDownEvent({
      ...key,
      repeat: false,
      editDisposition: "text-input",
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
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      accelKey: false,
      capsLock: false,
      altGraphKey: false,
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
  });
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
  assertEquals(createImeCommitEvent(window, "\u0003"), undefined);
  assertEquals(createImeCommitEvent(window, "\u0085"), undefined);
  assertEquals(createImeCommitEvent(window, "日本"), {
    type: "ime",
    kind: "commit",
    window,
    text: "日本",
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
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
