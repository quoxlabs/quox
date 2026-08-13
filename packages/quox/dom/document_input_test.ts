import { assertEquals, assertStrictEquals } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxElement, type QuoxEvent } from "./node.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  clickPath: number[] = [];
  inputPath: number[] = [];
  title(): string {
    return "";
  }
  dispatch_key_event(...args: unknown[]): boolean {
    this.calls.push({ method: "keyEvent", args });
    return true;
  }
  dispatch_text_input(text: string): boolean {
    this.calls.push({ method: "textInput", args: [text] });
    return true;
  }
  dispatch_pointer_up(...args: unknown[]): boolean {
    this.calls.push({ method: "pointerUp", args });
    return true;
  }
  dispatch_apple_standard_keybinding(command: string): boolean {
    this.calls.push({ method: "appleCommand", args: [command] });
    return false;
  }
  take_click_path(): Uint32Array {
    const path = new Uint32Array(this.clickPath);
    this.clickPath = [];
    return path;
  }
  take_double_click_path(): Uint32Array {
    return new Uint32Array();
  }
  take_context_menu_path(): Uint32Array {
    return new Uint32Array();
  }
  take_input_path(): Uint32Array {
    const path = new Uint32Array(this.inputPath);
    this.inputPath = [];
    return path;
  }
  take_focus_path(): Uint32Array {
    return new Uint32Array();
  }
  take_blur_path(): Uint32Array {
    return new Uint32Array();
  }
  take_scroll_path(): Uint32Array {
    return new Uint32Array();
  }
}

Deno.test("onclick receives a browser-style event with the assigned element as this", () => {
  const { document, renderer } = createDocument();
  const button = new QuoxElement(document, 42);
  let clicks = 0;
  let dispatchedEvent: QuoxEvent | undefined;
  button.onclick = function (event) {
    assertEquals(event.type, "click");
    assertStrictEquals(this, button);
    assertStrictEquals(event.target, button);
    assertStrictEquals(event.currentTarget, button);
    dispatchedEvent = event;
    clicks++;
  };

  renderer.clickPath = [42];
  document.dispatchPointerUp(10, 20, 0, 0);

  assertEquals(renderer.calls, [{ method: "pointerUp", args: [10, 20, 0, 0] }]);
  assertEquals(clicks, 1);
  assertEquals(dispatchedEvent?.currentTarget, null);
});

Deno.test("a text hit is normalized to its button and bubbles target-to-root", () => {
  const { document, renderer } = createDocument();
  const button = new QuoxElement(document, 42);
  const parent = new QuoxElement(document, 7);
  const root = new QuoxElement(document, 1);
  const calls: string[] = [];

  button.onclick = function (event) {
    calls.push(`button:${event.target.nodeId}:${event.currentTarget?.nodeId}:${this.nodeId}`);
  };
  parent.onclick = function (event) {
    calls.push(`parent:${event.target.nodeId}:${event.currentTarget?.nodeId}:${this.nodeId}`);
    event.stopPropagation();
  };
  root.onclick = () => calls.push("root");

  // Rust removes the hit text node before exposing the frozen Blitz path.
  renderer.clickPath = [42, 7, 1];
  document.dispatchPointerUp(10, 20, 0, 0);

  assertEquals(calls, ["button:42:42:42", "parent:42:7:7"]);
});

function createDocument() {
  const renderer = new FakeInputRenderer();
  const renders = { count: 0 };
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => renders.count++,
    () => undefined,
  );
  return { document, renderer, renders };
}

Deno.test("keydown then textinput inserts once and emits one DOM input", () => {
  const { document, renderer, renders } = createDocument();
  let inputs = 0;
  const input = new QuoxElement(document, 42);
  input.oninput = function (event) {
    assertEquals(event.type, "input");
    assertStrictEquals(this, input);
    assertStrictEquals(event.target, input);
    assertStrictEquals(event.currentTarget, input);
    inputs++;
  };
  document.dispatchKey({
    type: "keydown",
    keycode: 44,
    code: "KeyZ",
    key: "y",
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
  renderer.inputPath = [42];
  document.dispatchTextInput({ type: "textinput", text: "y" });
  assertEquals(renderer.calls, [
    { method: "keyEvent", args: ["KeyZ", "y", 0, 0, 5] },
    { method: "textInput", args: ["y"] },
  ]);
  assertEquals(inputs, 1);
  assertEquals(renders.count, 2);
});

Deno.test("browser-style event properties can be read, replaced, and cleared", () => {
  const { document, renderer } = createDocument();
  const input = new QuoxElement(document, 42);
  const calls: string[] = [];
  const first = () => calls.push("first");
  const second = () => calls.push("second");

  input.oninput = first;
  assertEquals(input.oninput, first);
  input.oninput = second;
  assertEquals(input.oninput, second);

  renderer.inputPath = [42];
  document.dispatchTextInput({ type: "textinput", text: "a" });
  assertEquals(calls, ["second"]);

  input.oninput = null;
  assertEquals(input.oninput, null);
  renderer.inputPath = [42];
  document.dispatchTextInput({ type: "textinput", text: "b" });
  assertEquals(calls, ["second"]);
});

Deno.test("AppKit selectors retain the platform command entry point", () => {
  const { document, renderer } = createDocument();
  document.dispatchAppleStandardKeybinding({ type: "apple-standard-keybinding", command: "deleteBackward:" });
  assertEquals(renderer.calls, [{ method: "appleCommand", args: ["deleteBackward:"] }]);
});
