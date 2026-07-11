import type { KeyDownEvent, Window } from "../types.ts";
import { DarwinInputState, NS_NOT_FOUND, utf16RangeToUtf8 } from "./input_state.ts";

Deno.test("Darwin UTF-16 ranges become UTF-8 selections", () => {
  assertEquals(utf16RangeToUtf8("A🙂é", 1, 2), [1, 5]);
  assertEquals(utf16RangeToUtf8("A🙂é", 2, 1), null);
  assertEquals(utf16RangeToUtf8("e\u0301", 1, 1), [1, 3]);
  assertEquals(utf16RangeToUtf8("text", 99, 99), null);
  assertEquals(utf16RangeToUtf8("text", -8, -2), null);
  assertEquals(utf16RangeToUtf8("text", NS_NOT_FOUND, 0), null);
  assertEquals(utf16RangeToUtf8("text", -1, 0), null);
  assertEquals(utf16RangeToUtf8("text", -1n, 0), null);
});

Deno.test("Darwin interpreted text follows its key and suppresses duplicate default editing", () => {
  const state = inputState();
  state.beginKey(keyEvent({ key: "z", code: "KeyY" }));
  state.insertText("z");

  assertEquals(state.finishKey(), [
    keyEvent({ key: "z", code: "KeyY", editDisposition: "text-input" }),
    { type: "ime", kind: "commit", text: "z", window: TEST_WINDOW },
  ]);
});

Deno.test("Darwin discards empty commits without ending an active preedit", () => {
  const state = inputState();
  state.setMarkedText("live", 4, 0);
  state.drainEvents();
  state.beginKey(keyEvent({ key: "ArrowLeft", code: "ArrowLeft", isComposing: true }));
  state.insertText("");

  assertEquals(state.finishKey(), [
    keyEvent({ key: "ArrowLeft", code: "ArrowLeft", isComposing: true }),
  ]);
  assertEquals(state.composing, true);
  assertEquals(state.markedText, "live");
});

Deno.test("Darwin composition updates and completion preserve callback ordering", () => {
  const state = inputState();
  state.beginKey(keyEvent({ key: "Dead" }));
  state.setMarkedText("🙂e", 2, 1);
  assertEquals(state.finishKey(), [
    keyEvent({ key: "Dead", editDisposition: "text-input" }),
    {
      type: "ime",
      kind: "preedit",
      text: "🙂e",
      cursorRange: [4, 5],
      window: TEST_WINDOW,
    },
  ]);

  state.beginKey(keyEvent({ key: "e", isComposing: true }));
  state.insertText("é");
  assertEquals(state.finishKey(), [
    keyEvent({ key: "e", isComposing: true, editDisposition: "text-input" }),
    { type: "ime", kind: "commit", text: "é", window: TEST_WINDOW },
  ]);
  assertEquals(state.hasMarkedText, false);
});

Deno.test("Darwin applies marked replacement ranges in marked-text UTF-16 coordinates", () => {
  const state = inputState();
  state.setMarkedText("ab🙂cd", 1, 0);
  state.drainEvents();

  state.setMarkedText("Z", 1, 0, 1, 3);
  assertEquals(state.markedText, "aZcd");
  assertEquals(state.markedSelection, { location: 2, length: 0 });
  assertEquals(state.drainEvents(), [{
    type: "ime",
    kind: "preedit",
    text: "aZcd",
    cursorRange: [2, 2],
    window: TEST_WINDOW,
  }]);

  assertThrows(
    () => state.setMarkedText("bad", 0, 0, 99, 1),
    "marked-text replacementRange is outside marked text",
  );
});

Deno.test("Darwin turns document replacement ranges into atomic application edits", () => {
  const state = inputState();
  // The replacement is deliberately away from the cursor; it cannot be
  // represented by a relative delete-surrounding event without over-deleting.
  state.setSurroundingText("A🙂BC", 7, 7);
  state.insertText("x", 1, 3);
  assertEquals(state.drainEvents(), [
    {
      type: "ime",
      kind: "replace",
      startBytes: 1,
      endBytes: 6,
      text: "x",
      window: TEST_WINDOW,
    },
  ]);

  const withoutContext = inputState();
  assertThrows(
    () => withoutContext.insertText("x", 0, 1),
    "concrete replacementRange requires setImeSurroundingText() state",
  );
});

Deno.test("Darwin starts marked text at an arbitrary document replacement range", () => {
  const state = inputState();
  state.setSurroundingText("A🙂BC", 7, 7);
  state.setMarkedText("候", 1, 0, 1, 3);
  assertEquals(state.drainEvents(), [
    {
      type: "ime",
      kind: "replace",
      startBytes: 1,
      endBytes: 6,
      text: "",
      window: TEST_WINDOW,
    },
    {
      type: "ime",
      kind: "preedit",
      text: "候",
      cursorRange: [3, 3],
      window: TEST_WINDOW,
    },
  ]);
});

Deno.test("Darwin commit retracts a synchronous marked-text clear", () => {
  const state = inputState();
  state.setMarkedText("é", 1, 0);
  state.drainEvents();
  state.beginKey(keyEvent({ key: "e", isComposing: true }));
  state.setMarkedText("", 0, 0);
  state.insertText("é");

  assertEquals(state.finishKey(), [
    keyEvent({ key: "e", isComposing: true, editDisposition: "text-input" }),
    { type: "ime", kind: "commit", text: "é", window: TEST_WINDOW },
  ]);
  assertEquals(state.composing, false);
});

Deno.test("Darwin filters control and AppKit function-key commit text", () => {
  const state = inputState();
  assertEquals(state.insertText("\u0003"), undefined);
  assertEquals(state.insertText("\uf702"), undefined);
  assertEquals(state.drainEvents(), []);
});

Deno.test("Darwin unmark accepts composition while cancel and disable do not", () => {
  const state = inputState();
  state.setImeEnabled(true);
  assertEquals(state.drainEvents(), []);
  state.setNativeFocused(true);
  assertEquals(state.drainEvents(), [{ type: "ime", kind: "enabled", window: TEST_WINDOW }]);

  state.setMarkedText("日本", 1, 1);
  state.drainEvents();
  state.unmarkText();
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "commit", text: "日本", window: TEST_WINDOW },
  ]);

  state.setMarkedText("discard me", 0, 0);
  state.drainEvents();
  state.cancelComposition();
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "preedit", text: "", cursorRange: null, window: TEST_WINDOW },
  ]);

  state.setMarkedText("also discard", 0, 0);
  state.drainEvents();
  state.setImeEnabled(false);
  assertEquals(state.drainEvents(), [
    { type: "ime", kind: "preedit", text: "", cursorRange: null, window: TEST_WINDOW },
    { type: "ime", kind: "disabled", window: TEST_WINDOW },
  ]);
  state.setImeEnabled(false);
  assertEquals(state.drainEvents(), []);
});

Deno.test("Darwin native commands follow their physical key exactly once", () => {
  const state = inputState();
  state.beginKey(keyEvent({ key: "Backspace", code: "Backspace" }));
  state.performCommand("deleteBackward:");
  assertEquals(state.finishKey(), [
    keyEvent({ key: "Backspace", code: "Backspace", editDisposition: "text-input" }),
    { type: "apple-standard-keybinding", command: "deleteBackward:", window: TEST_WINDOW },
  ]);

  state.beginKey(keyEvent({ key: "ArrowLeft", code: "ArrowLeft" }));
  assertEquals(state.finishKey(), [
    keyEvent({ key: "ArrowLeft", code: "ArrowLeft" }),
  ]);

  state.beginKey(keyEvent({ key: "F10", code: "F10", editDisposition: "platform" }));
  assertEquals(state.finishKey(), [
    keyEvent({ key: "F10", code: "F10", editDisposition: "platform" }),
  ]);
});

Deno.test("Darwin key batches preserve layout, repeat, location, and modifier state", () => {
  const state = inputState();
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

Deno.test("Darwin cursor geometry preserves subpixels and ignores invalid updates", () => {
  const state = inputState();
  state.setCursorArea(1.25, 2.5, 3.75, 4.5);
  state.setCursorArea(Number.NaN, 9, 9, 9);
  assertEquals(state.cursorArea, { x: 1.25, y: 2.5, width: 3.75, height: 4.5 });
  state.setCursorArea(-2, -3, -4, -5);
  assertEquals(state.cursorArea, { x: -2, y: -3, width: 0, height: 0 });
});

const TEST_WINDOW = {} as Window;

function inputState(): DarwinInputState {
  return new DarwinInputState(TEST_WINDOW);
}

function keyEvent(overrides: Partial<KeyDownEvent> = {}): KeyDownEvent {
  return {
    type: "keydown",
    keycode: 12,
    code: "KeyQ",
    key: "q",
    location: 0,
    repeat: false,
    isComposing: false,
    editDisposition: "key-default",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
    window: TEST_WINDOW,
    ...overrides,
  };
}

function assertEquals(actual: unknown, expected: unknown): void {
  const encode = (value: unknown) => JSON.stringify(canonical(value));
  const actualJson = encode(actual);
  const expectedJson = encode(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error) || !thrown.message.includes(message)) {
    throw new Error(`Expected error containing ${JSON.stringify(message)}, got ${String(thrown)}`);
  }
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [
      key,
      canonical(item),
    ]),
  );
}
