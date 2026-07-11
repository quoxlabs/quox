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

type InputValueMode = "value" | "unsupported-value" | "default" | "default-on" | "filename";

function inputValueMode(control: ControlState): InputValueMode {
  const type = (control.attributes.get("type") ?? "").toLowerCase();
  switch (type) {
    case "date":
    case "datetime-local":
    case "month":
    case "week":
    case "time":
    case "range":
    case "color":
      return "unsupported-value";
    case "hidden":
    case "submit":
    case "image":
    case "reset":
    case "button":
      return "default";
    case "checkbox":
    case "radio":
      return "default-on";
    case "file":
      return "filename";
    default:
      return "value";
  }
}

function isValueMode(mode: InputValueMode): boolean {
  return mode === "value" || mode === "unsupported-value";
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
    const control = this.#control(nodeHandle);
    if (control.tagName === "textarea") return control.value;
    if (control.tagName !== "input") throw new TypeError("fake node is not a form control");
    switch (inputValueMode(control)) {
      case "value":
        return control.value;
      case "default":
        return control.attributes.get("value") ?? "";
      case "default-on":
        return control.attributes.get("value") ?? "on";
      case "unsupported-value":
      case "filename":
        throw new TypeError("fake input value mode is intentionally unsupported");
    }
  }

  set_form_control_value(nodeHandle: number, value: string): boolean {
    const control = this.#control(nodeHandle);
    if (control.tagName === "input") {
      switch (inputValueMode(control)) {
        case "default":
        case "default-on": {
          if (control.attributes.get("value") === value && control.attributes.has("value")) {
            return false;
          }
          control.attributes.set("value", value);
          return true;
        }
        case "unsupported-value":
        case "filename":
          throw new TypeError("fake input value mode is intentionally unsupported");
        case "value":
          break;
      }
    }
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
    name = name.toLowerCase();
    const previousMode = control.tagName === "input" && name === "type" ? inputValueMode(control) : undefined;
    control.attributes.set(name, value);
    if (previousMode !== undefined) {
      this.#applyTypeTransition(control, previousMode);
    } else if (
      control.tagName === "input" && name === "value" &&
      isValueMode(inputValueMode(control)) && !control.dirty
    ) {
      control.value = value;
    }
  }

  remove_attribute(nodeHandle: number, name: string): void {
    const control = this.#control(nodeHandle);
    name = name.toLowerCase();
    const previousMode = control.tagName === "input" && name === "type" ? inputValueMode(control) : undefined;
    control.attributes.delete(name);
    if (previousMode !== undefined) {
      this.#applyTypeTransition(control, previousMode);
    } else if (
      control.tagName === "input" && name === "value" &&
      isValueMode(inputValueMode(control)) && !control.dirty
    ) {
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

  #applyTypeTransition(control: ControlState, previousMode: InputValueMode): void {
    const nextMode = inputValueMode(control);
    if (
      isValueMode(previousMode) && !isValueMode(nextMode) && nextMode !== "filename" &&
      control.value !== ""
    ) {
      control.attributes.set("value", control.value);
    } else if (!isValueMode(previousMode) && isValueMode(nextMode)) {
      control.value = control.attributes.get("value") ?? "";
      control.dirty = false;
    } else if (previousMode !== "filename" && nextMode === "filename") {
      control.value = "";
    }
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

Deno.test("default input value modes reflect the value content attribute", () => {
  for (const type of ["hidden", "submit", "image", "reset", "button"]) {
    const { document, renders } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    let inputEvents = 0;
    let changeEvents = 0;
    input.addEventListener("input", () => inputEvents++);
    input.addEventListener("change", () => changeEvents++);
    const setupRenders = renders.count;

    assertEquals(input.value, "", `${type} has an empty missing-attribute fallback`);
    assertEquals(input.getAttribute("value"), null);

    input.value = "";
    assertEquals(input.value, "");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(renders.count, setupRenders + 1, "creating an empty attribute must repaint");

    input.value = "";
    assertEquals(renders.count, setupRenders + 1, "an identical present attribute is unchanged");

    input.value = "button label";
    assertEquals(input.value, "button label");
    assertEquals(input.defaultValue, "button label");
    assertEquals(renders.count, setupRenders + 2);

    input.removeAttribute("value");
    assertEquals(input.value, "");
    assertEquals(input.getAttribute("value"), null);
    assertEquals(inputEvents, 0);
    assertEquals(changeEvents, 0);
  }
});

Deno.test("checkbox and radio value modes use on only for a missing attribute", () => {
  for (const type of ["checkbox", "radio"]) {
    const { document, renders } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    let inputEvents = 0;
    let changeEvents = 0;
    input.addEventListener("input", () => inputEvents++);
    input.addEventListener("change", () => changeEvents++);
    const setupRenders = renders.count;

    assertEquals(input.value, "on");
    assertEquals(input.defaultValue, "");
    assertEquals(input.getAttribute("value"), null);

    input.value = "on";
    assertEquals(input.value, "on");
    assertEquals(input.getAttribute("value"), "on");
    assertEquals(renders.count, setupRenders + 1, "creating the fallback text as an attribute repaints");

    input.value = "on";
    assertEquals(renders.count, setupRenders + 1);

    input.value = "";
    assertEquals(input.value, "", "a present empty attribute does not use the on fallback");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(renders.count, setupRenders + 2);

    input.removeAttribute("value");
    assertEquals(input.value, "on");
    (input as unknown as { value: unknown }).value = null;
    assertEquals(input.value, "", "LegacyNullToEmptyString creates an empty attribute");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(inputEvents, 0);
    assertEquals(changeEvents, 0);
  }
});

Deno.test("input type changes transfer values between value and attribute modes", () => {
  const { document } = createDocument();

  for (const type of ["checkbox", "hidden"]) {
    const dirty = document.createElement("input");
    dirty.defaultValue = "old default";
    dirty.value = "live value";
    dirty.setAttribute("type", type);
    assertEquals(dirty.value, "live value");
    assertEquals(dirty.getAttribute("value"), "live value");

    dirty.setAttribute("type", "text");
    assertEquals(dirty.value, "live value");
    dirty.defaultValue = "new default";
    assertEquals(dirty.value, "new default", "returning to value mode resets the dirty flag");

    const empty = document.createElement("input");
    empty.defaultValue = "old default";
    empty.value = "";
    empty.setAttribute("type", type);
    assertEquals(empty.value, "old default", "an empty live value does not overwrite the old attribute");
  }

  const checkbox = document.createElement("input");
  checkbox.setAttribute("type", "checkbox");
  assertEquals(checkbox.value, "on");
  checkbox.setAttribute("type", "text");
  assertEquals(checkbox.value, "", "the default-on fallback is not copied into value mode");

  const assignedCheckbox = document.createElement("input");
  assignedCheckbox.setAttribute("type", "checkbox");
  assignedCheckbox.value = "choice";
  assignedCheckbox.setAttribute("type", "text");
  assertEquals(assignedCheckbox.value, "choice");
  assignedCheckbox.defaultValue = "replacement default";
  assertEquals(assignedCheckbox.value, "replacement default");

  const fallback = document.createElement("input");
  fallback.setAttribute("type", "hidden");
  assertEquals(fallback.value, "");
  fallback.setAttribute("type", "radio");
  assertEquals(fallback.value, "on");
  fallback.setAttribute("type", "hidden");
  assertEquals(fallback.value, "");
  assertEquals(fallback.getAttribute("value"), null);
});

Deno.test("complex and filename input values remain explicitly unsupported", () => {
  for (const type of ["date", "datetime-local", "month", "week", "time", "range", "color", "file"]) {
    const { document } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);

    assertThrows(() => input.value, TypeError, "intentionally unsupported");
    assertThrows(
      () => {
        input.value = "replacement";
      },
      TypeError,
      "intentionally unsupported",
    );
    assertEquals(input.getAttribute("value"), null);
  }
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
