import { assertEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { setElementFunctionProp } from "./handlers.ts";
import { QuoxElement } from "./node.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  inputNode: number | undefined;
  throwOnPointerMove = false;

  title(): string {
    return "";
  }

  dispatch_pointer_move(x: number, y: number, buttons: number): boolean {
    this.calls.push({ method: "pointerMove", args: [x, y, buttons] });
    if (this.throwOnPointerMove) throw new Error("pointer dispatch failed");
    return false;
  }

  dispatch_key_down(...args: unknown[]): boolean {
    this.calls.push({ method: "keyDown", args });
    return true;
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

Deno.test("keyboard dispatch forwards logical key, text, and repeat without synthesis", () => {
  const { document, renderer, renders, syncs } = createDocument();

  document.dispatchKeyDown("KeyZ", true, false, true, false, true, "y", "y", true);

  assertEquals(renderer.calls, [{
    method: "keyDown",
    args: ["KeyZ", true, false, true, false, true, "y", "y", true],
  }]);
  assertEquals(renders.count, 1);
  assertEquals(syncs.count, 1);
});

Deno.test("IME dispatch preserves UTF-8 preedit ranges and emits DOM input for commit", () => {
  const { document, renderer, syncs } = createDocument();
  let inputs = 0;
  setElementFunctionProp(new QuoxElement(document, 42), "onInput", () => inputs++);

  document.dispatchIme({ type: "ime", kind: "enabled" });
  document.dispatchIme({ type: "ime", kind: "preedit", text: "éx", cursorRange: [2, 3] });
  document.dispatchIme({ type: "ime", kind: "preedit", text: "hidden" });
  renderer.inputNode = 42;
  document.dispatchIme({ type: "ime", kind: "commit", text: "é" });
  document.dispatchIme({
    type: "ime",
    kind: "deleteSurrounding",
    beforeLength: 4,
    afterLength: 2,
  });
  document.dispatchIme({ type: "ime", kind: "disabled" });

  assertEquals(renderer.calls, [
    { method: "imeEnabled", args: [] },
    { method: "imePreedit", args: ["éx", 2, 3] },
    { method: "imePreedit", args: ["hidden", undefined, undefined] },
    { method: "imeCommit", args: ["é"] },
    { method: "imeDisabled", args: [] },
  ]);
  assertEquals(inputs, 1);
  assertEquals(syncs.count, 6);
});

Deno.test("native IME requests are synchronized even when renderer dispatch throws", () => {
  const renderer = new FakeInputRenderer();
  renderer.throwOnPointerMove = true;
  const { document, syncs } = createDocument(renderer);

  assertThrows(() => document.dispatchPointerMove(10, 20, 0), Error, "pointer dispatch failed");
  assertEquals(syncs.count, 1);
});
