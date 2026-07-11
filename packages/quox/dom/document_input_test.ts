import { assertEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { setElementFunctionProp } from "./handlers.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  inputNode: number | undefined;
  throwOnPointerMove = false;

  title(): string {
    return "";
  }

  create_element(_tagName: string): number {
    return 42;
  }

  dispatch_pointer_move(x: number, y: number, buttons: number, modifierBits: number): boolean {
    this.calls.push({ method: "pointerMove", args: [x, y, buttons, modifierBits] });
    if (this.throwOnPointerMove) throw new Error("pointer dispatch failed");
    return false;
  }

  dispatch_key_event(...args: unknown[]): boolean {
    this.calls.push({ method: "keyEvent", args });
    return true;
  }

  dispatch_apple_standard_keybinding(command: string): boolean {
    this.calls.push({ method: "appleCommand", args: [command] });
    return false;
  }

  dispatch_ime_enabled(): boolean {
    this.calls.push({ method: "imeEnabled", args: [] });
    return false;
  }

  dispatch_ime_disabled(): boolean {
    this.calls.push({ method: "imeDisabled", args: [] });
    return false;
  }

  dispatch_ime_preedit(text: string, start?: number, end?: number): boolean {
    this.calls.push({ method: "imePreedit", args: [text, start, end] });
    return false;
  }

  dispatch_ime_commit(text: string): boolean {
    this.calls.push({ method: "imeCommit", args: [text] });
    return false;
  }

  dispatch_ime_delete_surrounding(beforeBytes: number, afterBytes: number): boolean {
    this.calls.push({ method: "imeDeleteSurrounding", args: [beforeBytes, afterBytes] });
    return false;
  }

  take_click_node(): number | undefined {
    return undefined;
  }

  take_double_click_node(): number | undefined {
    return undefined;
  }

  take_context_menu_node(): number | undefined {
    return undefined;
  }

  take_input_node(): number | undefined {
    const node = this.inputNode;
    this.inputNode = undefined;
    return node;
  }

  take_focus_node(): number | undefined {
    return undefined;
  }

  take_blur_node(): number | undefined {
    return undefined;
  }

  take_scroll_node(): number | undefined {
    return undefined;
  }

  node_kind(_nodeHandle: number): number {
    return 1;
  }
}

function createDocument(renderer = new FakeInputRenderer()): {
  document: QuoxDocument;
  renderer: FakeInputRenderer;
  renders: { count: number };
  syncs: { count: number };
} {
  const renders = { count: 0 };
  const syncs = { count: 0 };
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => renders.count++,
    () => undefined,
    undefined,
    () => syncs.count++,
  );
  return { document, renderer, renders, syncs };
}

Deno.test("keyboard dispatch forwards logical key, policy, and repeat without synthesis", () => {
  const { document, renderer, renders, syncs } = createDocument();

  document.dispatchKey({
    type: "keydown",
    keycode: 44,
    code: "KeyZ",
    key: "y",
    location: 0,
    repeat: true,
    isComposing: false,
    editDisposition: "text-input",
    shiftKey: true,
    ctrlKey: false,
    altKey: true,
    metaKey: false,
    accelKey: false,
    capsLock: true,
    altGraphKey: false,
  });

  assertEquals(renderer.calls, [{
    method: "keyEvent",
    // modifiers = Shift | Alt | CapsLock; flags = Pressed | Repeat | PreventDefault
    args: ["KeyZ", "y", 11, 0, 11],
  }]);
  assertEquals(renders.count, 1);
  assertEquals(syncs.count, 1);
});

Deno.test("IME dispatch preserves UTF-8 preedit ranges and emits DOM input for commit", () => {
  const { document, renderer, syncs } = createDocument();
  let inputs = 0;
  setElementFunctionProp(document.createElement("input"), "onInput", () => inputs++);

  document.dispatchIme({ type: "ime", kind: "enabled" });
  document.dispatchIme({ type: "ime", kind: "preedit", text: "éx", cursorRange: [2, 3] });
  document.dispatchIme({ type: "ime", kind: "preedit", text: "hidden", cursorRange: null });
  renderer.inputNode = 42;
  document.dispatchIme({ type: "ime", kind: "commit", text: "é" });
  document.dispatchIme({
    type: "ime",
    kind: "deleteSurrounding",
    beforeBytes: 4,
    afterBytes: 2,
  });
  document.dispatchIme({ type: "ime", kind: "disabled" });

  assertEquals(renderer.calls, [
    { method: "imeEnabled", args: [] },
    { method: "imePreedit", args: ["éx", 2, 3] },
    { method: "imePreedit", args: ["hidden", undefined, undefined] },
    { method: "imeCommit", args: ["é"] },
    { method: "imeDeleteSurrounding", args: [4, 2] },
    { method: "imeDisabled", args: [] },
  ]);
  assertEquals(inputs, 1);
  assertEquals(syncs.count, 6);
});

Deno.test("IME replacement dispatches surrounding deletion before commit and drains both inputs", () => {
  const { document, renderer, syncs } = createDocument();
  let inputs = 0;
  setElementFunctionProp(document.createElement("input"), "onInput", () => inputs++);

  renderer.inputNode = 42;
  document.dispatchIme({
    type: "ime",
    kind: "deleteSurrounding",
    beforeBytes: 3,
    afterBytes: 1,
  });
  renderer.inputNode = 42;
  document.dispatchIme({ type: "ime", kind: "commit", text: "好" });

  assertEquals(renderer.calls, [
    { method: "imeDeleteSurrounding", args: [3, 1] },
    { method: "imeCommit", args: ["好"] },
  ]);
  assertEquals(inputs, 2);
  assertEquals(syncs.count, 2);
});

Deno.test("AppKit selectors use the dedicated renderer entry point", () => {
  const { document, renderer, syncs } = createDocument();

  document.dispatchAppleStandardKeybinding({
    type: "apple-standard-keybinding",
    command: "deleteBackward:",
  });

  assertEquals(renderer.calls, [{ method: "appleCommand", args: ["deleteBackward:"] }]);
  assertEquals(syncs.count, 1);
});

Deno.test("native IME requests are synchronized even when renderer dispatch throws", () => {
  const renderer = new FakeInputRenderer();
  renderer.throwOnPointerMove = true;
  const { document, syncs } = createDocument(renderer);

  assertThrows(() => document.dispatchPointerMove(10, 20, 0, 0), Error, "pointer dispatch failed");
  assertEquals(syncs.count, 1);
});
