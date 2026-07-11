import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { setElementFunctionProp } from "./handlers.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  inputNode: number | undefined;
  throwOnPointerMove = false;
  pointerMoveError: unknown;
  #nextFrameId = 1;
  #nextEventId = 1;
  readonly #pendingFrames = new Map<number, unknown>();

  title(): string {
    return "";
  }

  create_element(_tagName: string): number {
    return 42;
  }

  begin_pointer_move(x: number, y: number, buttons: number, modifierBits: number): unknown {
    this.calls.push({ method: "pointerMove", args: [x, y, buttons, modifierBits] });
    if (this.throwOnPointerMove) throw this.pointerMoveError ?? new Error("pointer dispatch failed");
    return this.#complete(false);
  }

  begin_pointer_down(..._args: unknown[]): unknown {
    return this.#complete(false);
  }

  begin_pointer_up(..._args: unknown[]): unknown {
    return this.#complete(false);
  }

  begin_wheel(..._args: unknown[]): unknown {
    return this.#complete(false);
  }

  begin_key_event(...args: unknown[]): unknown {
    this.calls.push({ method: "keyEvent", args });
    return this.#complete(true);
  }

  begin_apple_standard_keybinding(command: string): unknown {
    this.calls.push({ method: "appleCommand", args: [command] });
    return this.#complete(false);
  }

  begin_ime_enabled(): unknown {
    this.calls.push({ method: "imeEnabled", args: [] });
    return this.#complete(false);
  }

  begin_ime_disabled(): unknown {
    this.calls.push({ method: "imeDisabled", args: [] });
    return this.#complete(false);
  }

  begin_ime_preedit(text: string, start?: number, end?: number): unknown {
    this.calls.push({ method: "imePreedit", args: [text, start, end] });
    return this.#complete(false);
  }

  begin_ime_commit(text: string): unknown {
    this.calls.push({ method: "imeCommit", args: [text] });
    return this.#inputOrComplete();
  }

  begin_ime_delete_surrounding(beforeBytes: number, afterBytes: number): unknown {
    this.calls.push({ method: "imeDeleteSurrounding", args: [beforeBytes, afterBytes] });
    return this.#inputOrComplete();
  }

  resume_dom_dispatch(frameId: number, _eventId: number, _defaultPrevented: boolean): unknown {
    const next = this.#pendingFrames.get(frameId);
    if (next === undefined) throw new Error("missing pending fake frame");
    this.#pendingFrames.delete(frameId);
    return next;
  }

  abort_dom_dispatch(frameId: number): boolean {
    this.#pendingFrames.delete(frameId);
    return false;
  }

  node_kind(_nodeHandle: number): number {
    return 1;
  }

  #complete(redrawRequested: boolean): unknown {
    return {
      kind: "complete",
      frameId: this.#nextFrameId++,
      redrawRequested,
    };
  }

  #inputOrComplete(): unknown {
    const target = this.inputNode;
    this.inputNode = undefined;
    if (target === undefined) return this.#complete(false);

    const frameId = this.#nextFrameId++;
    this.#pendingFrames.set(frameId, {
      kind: "complete",
      frameId,
      redrawRequested: false,
    });
    return {
      kind: "event",
      frameId,
      eventId: this.#nextEventId++,
      type: "input",
      target,
      path: [target],
      bubbles: true,
      cancelable: false,
      composed: true,
      timeStamp: 1,
    };
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
  const dispatchError = new Error("pointer dispatch failed");
  renderer.pointerMoveError = dispatchError;
  const { document, syncs } = createDocument(renderer);

  assertThrows(() => document.dispatchPointerMove(10, 20, 0, 0), Error, "pointer dispatch failed");
  assertEquals(syncs.count, 1);
});

Deno.test("dispatch and native IME synchronization failures are both preserved", () => {
  const renderer = new FakeInputRenderer();
  renderer.throwOnPointerMove = true;
  const dispatchError = new Error("pointer dispatch failed");
  renderer.pointerMoveError = dispatchError;
  const synchronizationError = new Error("IME synchronization failed");
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => undefined,
    undefined,
    () => {
      throw synchronizationError;
    },
  );

  const error = assertThrows(
    () => document.dispatchPointerMove(10, 20, 0, 0),
    AggregateError,
  );
  assertStrictEquals(error.errors[0], dispatchError);
  assertStrictEquals(error.errors[1], synchronizationError);
});

Deno.test("invalid numeric input is rejected before renderer or IME synchronization side effects", () => {
  const { document, renderer, renders, syncs } = createDocument();

  assertThrows(() => document.dispatchPointerMove(NaN, 20, 0, 0), RangeError);
  assertThrows(() => document.dispatchPointerDown(10, 20, 256, 1, 0), RangeError);
  assertThrows(() => document.dispatchPointerUp(10, 20, 0, 0x20, 0), RangeError);
  assertThrows(() => document.dispatchWheel(10, 20, Infinity, 0, 0, 0), RangeError);
  assertThrows(
    () => document.dispatchIme({ type: "ime", kind: "preedit", text: "éx", cursorRange: [1, 3] }),
    RangeError,
  );
  assertThrows(
    () =>
      document.dispatchIme({
        type: "ime",
        kind: "deleteSurrounding",
        beforeBytes: 0x1_0000_0000,
        afterBytes: 0,
      }),
    RangeError,
  );

  assertEquals(renderer.calls, []);
  assertEquals(renders.count, 0);
  assertEquals(syncs.count, 0);
});
