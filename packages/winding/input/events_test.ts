import type { Window } from "../types.ts";
import { createKeyDownEvent, createKeyUpEvent, createTextInputEvent, type KeyEventInit } from "./events.ts";

const window = {} as Window;
const key: KeyEventInit = {
  window,
  keycode: 30,
  code: "KeyA",
  key: "a",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  accelKey: false,
  capsLock: false,
  altGraphKey: false,
};

Deno.test("final key builders fill every canonical field", () => {
  assertEquals(createKeyDownEvent({ ...key, repeat: false, editDisposition: "text-input" }), {
    type: "keydown",
    window,
    keycode: 30,
    code: "KeyA",
    key: "a",
    location: 0,
    repeat: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });
  assertEquals(createKeyUpEvent({ ...key, code: "ShiftRight", key: "Shift" }), {
    type: "keyup",
    window,
    keycode: 30,
    code: "ShiftRight",
    key: "Shift",
    location: 2,
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

Deno.test("textinput accepts nonempty Unicode and filters control text", () => {
  assertEquals(createTextInputEvent(window, ""), undefined);
  assertEquals(createTextInputEvent(window, "\u0003"), undefined);
  assertEquals(createTextInputEvent(window, "\u0085"), undefined);
  assertEquals(createTextInputEvent(window, "ß日本"), { type: "textinput", window, text: "ß日本" });
  assertEquals(Object.keys(createTextInputEvent(window, "é")!).sort(), ["text", "type", "window"]);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}
