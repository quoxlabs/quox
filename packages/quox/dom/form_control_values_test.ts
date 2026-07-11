import { assertEquals, assertInstanceOf, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxInputElement, QuoxTextAreaElement } from "./node.ts";

interface ControlState {
  readonly tagName: string;
  readonly attributes: Map<string, string>;
  defaultText: string;
  value: string;
  dirty: boolean;
}

class FakeLiveControlRenderer {
  readonly #controls = new Map<number, ControlState>();
  readonly #pending = new Map<number, unknown>();
  #nextHandle = 1;
  #nextFrame = 1;
  nativeValue = "";

  title(): string {
    return "";
  }

  create_element(tagName: string): number {
    const handle = this.#nextHandle++;
    this.#controls.set(handle, {
      tagName: tagName.toLowerCase(),
      attributes: new Map(),
      defaultText: "",
      value: "",
      dirty: false,
    });
    return handle;
  }

  element_interface(nodeHandle: number): number {
    switch (this.#control(nodeHandle).tagName) {
      case "input":
        return 1;
      case "textarea":
        return 2;
      default:
        return 0;
    }
  }

  node_kind(_nodeHandle: number): number {
    return 1;
  }

  form_control_value(nodeHandle: number): string {
    return this.#control(nodeHandle).value;
  }

  set_form_control_value(nodeHandle: number, value: string): boolean {
    const control = this.#control(nodeHandle);
    const changed = control.value !== value;
    control.value = value;
    control.dirty = true;
    return changed;
  }

  get_attribute(nodeHandle: number, name: string): string | undefined {
    return this.#control(nodeHandle).attributes.get(name.toLowerCase());
  }

  set_attribute(nodeHandle: number, name: string, value: string): void {
    const control = this.#control(nodeHandle);
    control.attributes.set(name.toLowerCase(), value);
    if (control.tagName === "input" && name.toLowerCase() === "value" && !control.dirty) {
      control.value = value;
    }
  }

  remove_attribute(nodeHandle: number, name: string): void {
    const control = this.#control(nodeHandle);
    control.attributes.delete(name.toLowerCase());
    if (control.tagName === "input" && name.toLowerCase() === "value" && !control.dirty) {
      control.value = "";
    }
  }

  text_content(nodeHandle: number): string {
    return this.#control(nodeHandle).defaultText;
  }

  set_text_content(nodeHandle: number, value: string): Uint32Array {
    const control = this.#control(nodeHandle);
    control.defaultText = value;
    if (control.tagName === "textarea" && !control.dirty) control.value = value;
    return new Uint32Array();
  }

  begin_key_event(): unknown {
    const input = [...this.#controls.entries()].find(([, control]) => control.tagName === "input");
    if (input === undefined) throw new Error("fake native edit needs an input");
    input[1].value = this.nativeValue;
    input[1].dirty = true;
    const frameId = this.#nextFrame++;
    this.#pending.set(frameId, {
      kind: "complete",
      frameId,
      redrawRequested: true,
    });
    return {
      kind: "event",
      frameId,
      eventId: 1,
      type: "input",
      target: input[0],
      path: [input[0]],
      bubbles: true,
      cancelable: false,
      composed: true,
      timeStamp: 1,
      payload: { data: "x", inputType: "insertText", isComposing: false },
    };
  }

  resume_dom_dispatch(frameId: number): unknown {
    const step = this.#pending.get(frameId);
    if (step === undefined) throw new Error("fake dispatch frame is not pending");
    this.#pending.delete(frameId);
    return step;
  }

  abort_dom_dispatch(frameId: number): boolean {
    this.#pending.delete(frameId);
    return false;
  }

  #control(nodeHandle: number): ControlState {
    const control = this.#controls.get(nodeHandle);
    if (control === undefined) throw new RangeError(`unknown fake control ${nodeHandle}`);
    return control;
  }
}

function createDocument(): {
  readonly document: QuoxDocument;
  readonly renderer: FakeLiveControlRenderer;
  readonly renders: { count: number };
} {
  const renderer = new FakeLiveControlRenderer();
  const renders = { count: 0 };
  return {
    document: new QuoxDocument(
      renderer as unknown as WasmRenderer,
      () => renders.count++,
      () => undefined,
    ),
    renderer,
    renders,
  };
}

Deno.test("document creates tag-specific input and textarea wrappers", () => {
  const { document } = createDocument();
  const input: QuoxInputElement = document.createElement("input");
  const textarea: QuoxTextAreaElement = document.createElement("textarea");

  assertInstanceOf(input, QuoxInputElement);
  assertInstanceOf(textarea, QuoxTextAreaElement);
  assertStrictEquals(document.createElement("INPUT").constructor, QuoxInputElement);
});

Deno.test("defaultValue follows the live value only until it becomes dirty", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");

  input.defaultValue = "input default";
  textarea.defaultValue = "textarea default";
  assertEquals(input.value, "input default");
  assertEquals(textarea.value, "textarea default");

  input.value = "input live";
  textarea.value = "textarea live";
  input.defaultValue = "new input default";
  textarea.defaultValue = "new textarea default";

  assertEquals(input.defaultValue, "new input default");
  assertEquals(textarea.defaultValue, "new textarea default");
  assertEquals(input.value, "input live");
  assertEquals(textarea.value, "textarea live");
});

Deno.test("value setters use Web IDL string conversion, repair surrogates, and emit no event", () => {
  const { document, renders } = createDocument();
  const input = document.createElement("input");
  let inputEvents = 0;
  input.addEventListener("input", () => inputEvents++);
  let conversions = 0;

  (input as unknown as { value: unknown }).value = {
    toString() {
      conversions += 1;
      return "a\ud800b";
    },
  };

  assertEquals(input.value, "a\ufffdb");
  assertEquals(conversions, 1);
  assertEquals(inputEvents, 0);
  assertEquals(renders.count, 1);

  input.value = "a\ufffdb";
  assertEquals(renders.count, 1, "assigning the same value should not request paint");
  assertThrows(
    () => ((input as unknown as { value: unknown }).value = Symbol("value")),
    TypeError,
    "Web IDL string",
  );

  (input as unknown as { value: unknown }).value = null;
  assertEquals(input.value, "", "value uses LegacyNullToEmptyString");
  (input as unknown as { defaultValue: unknown }).defaultValue = null;
  assertEquals(input.defaultValue, "null", "defaultValue remains an ordinary DOMString");

  const textarea = document.createElement("textarea");
  (textarea as unknown as { value: unknown }).value = null;
  assertEquals(textarea.value, "");
  (textarea as unknown as { defaultValue: unknown }).defaultValue = null;
  assertEquals(textarea.defaultValue, "null");
});

Deno.test("a native edit is visible before its first input listener", () => {
  const { document, renderer } = createDocument();
  const input = document.createElement("input");
  const seen: string[] = [];
  input.addEventListener("input", () => seen.push(input.value));
  renderer.nativeValue = "native edit";

  document.dispatchKey({
    type: "keydown",
    code: "KeyX",
    key: "x",
    keycode: 88,
    location: 0,
    repeat: false,
    isComposing: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });

  assertEquals(seen, ["native edit"]);
});
