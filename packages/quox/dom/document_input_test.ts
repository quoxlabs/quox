import { assertEquals } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { setElementFunctionProp } from "./handlers.ts";
import { QuoxElement } from "./node.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  inputNode: number | undefined;
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
  dispatch_apple_standard_keybinding(command: string): boolean {
    this.calls.push({ method: "appleCommand", args: [command] });
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
  setElementFunctionProp(new QuoxElement(document, 42), "onInput", () => inputs++);
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
  renderer.inputNode = 42;
  document.dispatchTextInput({ type: "textinput", text: "y" });
  assertEquals(renderer.calls, [
    { method: "keyEvent", args: ["KeyZ", "y", 0, 0, 5] },
    { method: "textInput", args: ["y"] },
  ]);
  assertEquals(inputs, 1);
  assertEquals(renders.count, 2);
});

Deno.test("AppKit selectors retain the platform command entry point", () => {
  const { document, renderer } = createDocument();
  document.dispatchAppleStandardKeybinding({ type: "apple-standard-keybinding", command: "deleteBackward:" });
  assertEquals(renderer.calls, [{ method: "appleCommand", args: ["deleteBackward:"] }]);
});
