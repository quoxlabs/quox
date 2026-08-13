import type { KeyDownEvent, Window } from "../types.ts";
import { DarwinInputState } from "./input_state.ts";

const window = {} as Window;

function keyEvent(key = "z", code = "KeyY"): KeyDownEvent {
  return {
    type: "keydown",
    window,
    keycode: 16,
    code,
    key,
    location: 0,
    repeat: false,
    editDisposition: "key-default",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
}

Deno.test("Darwin batches keydown before committed text", () => {
  const state = new DarwinInputState(window);
  state.beginKey(keyEvent());
  state.insertText("z");
  assertEquals(state.finishKey(), [
    { ...keyEvent(), editDisposition: "text-input" },
    { type: "textinput", window, text: "z" },
  ]);
});

Deno.test("Darwin dead key emits no text and completion emits one composed value", () => {
  const state = new DarwinInputState(window);
  state.beginKey(keyEvent("Dead", "Quote"));
  state.insertText("");
  assertEquals(state.finishKey(), [keyEvent("Dead", "Quote")]);
  state.beginKey(keyEvent("é", "KeyE"));
  state.insertText("é");
  assertEquals(state.finishKey(), [
    { ...keyEvent("é", "KeyE"), editDisposition: "text-input" },
    { type: "textinput", window, text: "é" },
  ]);
});

Deno.test("Darwin dead-key cancellation emits a command but no text", () => {
  const state = new DarwinInputState(window);
  state.beginKey(keyEvent("Dead", "Quote"));
  assertEquals(state.finishKey(), [keyEvent("Dead", "Quote")]);

  state.beginKey(keyEvent("Escape", "Escape"));
  state.performCommand("cancelOperation:");
  const cancelled = state.finishKey();
  assertEquals(cancelled, [
    { ...keyEvent("Escape", "Escape"), editDisposition: "text-input" },
    { type: "apple-standard-keybinding", command: "cancelOperation:", window },
  ]);
  assertEquals(cancelled.some((event) => event.type === "textinput"), false);
});

Deno.test("Darwin retains AppKit editing commands", () => {
  const state = new DarwinInputState(window);
  state.beginKey(keyEvent("Backspace", "Backspace"));
  state.performCommand("deleteBackward:");
  assertEquals(state.finishKey(), [
    { ...keyEvent("Backspace", "Backspace"), editDisposition: "text-input" },
    { type: "apple-standard-keybinding", command: "deleteBackward:", window },
  ]);
});

Deno.test("Darwin tracks left and right modifier transitions independently", () => {
  const state = new DarwinInputState(window);
  const shift = 1n << 17n;
  assertEquals(state.modifierTransition("ShiftLeft", shift, shift), "keydown");
  assertEquals(state.modifierTransition("ShiftRight", shift, shift), "keydown");
  assertEquals(state.modifierTransition("ShiftLeft", shift, shift), "keyup");
  assertEquals(state.modifierTransition("ShiftRight", 0n, shift), "keyup");
});

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`);
}
