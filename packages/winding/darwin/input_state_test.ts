import type { KeyEvent, Window } from "../types.ts";
import { DarwinInputState, NS_NOT_FOUND, utf16OffsetToUtf8, utf16RangeToUtf8 } from "./input_state.ts";

Deno.test("Darwin UTF-16 offsets become clamped UTF-8 byte offsets", () => {
  assertEquals(utf16OffsetToUtf8("plain", 3), 3);
  assertEquals(utf16OffsetToUtf8("A🙂é", 1), 1);
  // Offset 2 splits the emoji's surrogate pair and clamps backward.
  assertEquals(utf16OffsetToUtf8("A🙂é", 2), 1);
  assertEquals(utf16OffsetToUtf8("A🙂é", 3), 5);
  assertEquals(utf16OffsetToUtf8("A🙂é", 4), 7);
  assertEquals(utf16OffsetToUtf8("e\u0301", 2), 3);
  assertEquals(utf16OffsetToUtf8("text", -100), 0);
  assertEquals(utf16OffsetToUtf8("text", 10_000n), 4);
});

Deno.test("Darwin UTF-16 ranges become UTF-8 selections", () => {
  assertEquals(utf16RangeToUtf8("A🙂é", 1, 2), { start: 1, end: 5 });
  assertEquals(utf16RangeToUtf8("A🙂é", 2, 1), { start: 1, end: 5 });
  assertEquals(utf16RangeToUtf8("e\u0301", 1, 1), { start: 1, end: 3 });
  assertEquals(utf16RangeToUtf8("text", 99, 99), { start: 4, end: 4 });
  assertEquals(utf16RangeToUtf8("text", -8, -2), { start: 0, end: 0 });
  assertEquals(utf16RangeToUtf8("text", NS_NOT_FOUND, 0), null);
  assertEquals(utf16RangeToUtf8("text", -1, 0), null);
  assertEquals(utf16RangeToUtf8("text", -1n, 0), null);
});

Deno.test("Darwin interpreted text follows its key and suppresses duplicate default editing", () => {
  const state = new DarwinInputState();
  state.beginKey(keyEvent({ key: "z", code: "KeyY", text: "z" }));
  state.insertText("z");

  assertEquals(state.finishKey(), [
    keyEvent({ key: "z", code: "KeyY", text: "z", textInputHandled: true }),
    { type: "ime", kind: "preedit", text: "", selection: null },
    { type: "ime", kind: "commit", text: "z" },
  ]);
});

Deno.test("Darwin composition updates and completion preserve callback ordering", () => {
  const state = new DarwinInputState();
  state.beginKey(keyEvent({ key: "Dead" }));
  state.setMarkedText("🙂e", 2, 1);
  assertEquals(state.finishKey(), [
    keyEvent({ key: "Dead", isComposing: true, textInputHandled: true }),
    {
      type: "ime",
      kind: "preedit",
      text: "🙂e",
      selection: { start: 4, end: 5 },
    },
  ]);

  state.beginKey(keyEvent({ key: "e", text: "é" }));
  state.insertText("é");
  assertEquals(state.finishKey(), [
    keyEvent({ key: "e", text: "é", isComposing: true, textInputHandled: true }),
    { type: "ime", kind: "preedit", text: "", selection: null },
    { type: "ime", kind: "commit", text: "é" },
  ]);
  assertEquals(state.hasMarkedText, false);
});

Deno.test("Darwin unmark accepts composition while cancel and disable do not", () => {
  const state = new DarwinInputState();
  state.setImeEnabled(true);
  assertEquals(state.drainEvents(), [{ type: "ime", kind: "enabled" }]);

  state.setMarkedText("日本", 1, 1);
  state.drainEvents();
  state.unmarkText();
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "preedit", text: "", selection: null },
    { type: "ime", kind: "commit", text: "日本" },
  ]);

  state.setMarkedText("discard me", 0, 0);
  state.drainEvents();
  state.cancelComposition();
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "preedit", text: "", selection: null },
  ]);

  state.setMarkedText("also discard", 0, 0);
  state.drainEvents();
  state.setImeEnabled(false);
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "preedit", text: "", selection: null },
    { type: "ime", kind: "disabled" },
  ]);
  state.setImeEnabled(false);
  assertEquals(state.drainEvents(), []);
});

Deno.test("Darwin native commands follow their physical key exactly once", () => {
  const state = new DarwinInputState();
  state.beginKey(keyEvent({ key: "Backspace", code: "Backspace" }));
  state.performCommand("deleteBackward:");
  assertEquals(state.finishKey(), [
    keyEvent({ key: "Backspace", code: "Backspace", textInputHandled: true }),
    { type: "apple-standard-keybinding", command: "deleteBackward:" },
  ]);

  state.beginKey(keyEvent({ key: "ArrowLeft", code: "ArrowLeft" }));
  assertEquals(state.finishKey(), [
    keyEvent({ key: "ArrowLeft", code: "ArrowLeft", textInputHandled: false }),
  ]);
});

Deno.test("Darwin key batches preserve layout, repeat, location, and modifier state", () => {
  const state = new DarwinInputState();
  const shift = 1n << 17n;
  assertEquals(state.modifierTransition("ShiftLeft", shift, shift), "keydown");
  assertEquals(state.modifierTransition("ShiftRight", shift, shift), "keydown");
  assertEquals(state.modifierTransition("ShiftLeft", shift, shift), "keyup");
  assertEquals(state.modifierTransition("ShiftRight", 0n, shift), "keyup");
  assertEquals(state.modifierFlags, 0n);

  assertEquals(state.modifierTransition("Unidentified", 0n, undefined), "keydown");
  assertEquals(state.modifierTransition("Unidentified", 0n, undefined), "keyup");
  state.modifierTransition("ShiftLeft", shift, shift);
  state.resetModifiers();
  assertEquals(state.modifierFlags, 0n);
  assertEquals(state.modifierTransition("ShiftLeft", shift, shift), "keydown");

  state.beginKey(keyEvent({
    key: "'",
    code: "KeyQ",
    location: 2,
    repeat: true,
    metaKey: true,
    accelKey: true,
  }));
  assertEquals(state.finishKey(), [keyEvent({
    key: "'",
    code: "KeyQ",
    location: 2,
    repeat: true,
    metaKey: true,
    accelKey: true,
    textInputHandled: false,
  })]);
});

Deno.test("Darwin input state remains isolated per window", () => {
  const firstWindow = {} as Window;
  const secondWindow = {} as Window;
  const first = new DarwinInputState(firstWindow);
  const second = new DarwinInputState(secondWindow);

  first.setImeEnabled(true);
  first.setMarkedText("first", 0, 5);
  second.setCursorArea(1, 2, 3, 4);

  assertEquals(first.hasMarkedText, true);
  assertEquals(second.hasMarkedText, false);
  assertEquals(first.cursorArea, { x: 0, y: 0, width: 0, height: 0 });
  assertEquals(second.cursorArea, { x: 1, y: 2, width: 3, height: 4 });
  assertEquals(first.drainEvents().every((event) => event.window === firstWindow), true);
  assertEquals(second.drainEvents(), []);
});

function keyEvent(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    type: "keydown",
    keycode: 12,
    code: "KeyQ",
    key: "q",
    location: 0,
    repeat: false,
    isComposing: false,
    text: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    ...overrides,
  };
}

function assertEquals(actual: unknown, expected: unknown): void {
  const encode = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? `${item}n` : item,
    );
  const actualJson = encode(actual);
  const expectedJson = encode(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
