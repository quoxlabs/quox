import { assertEquals, assertInstanceOf, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxElement, QuoxInputElement, QuoxTextAreaElement } from "./node.ts";

class FakeActiveElementRenderer {
  active: number | undefined = 2;
  readonly #values = new Map<number, string>([
    [3, ""],
    [4, ""],
  ]);
  readonly #interfaces = new Map<number, number>([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 2],
  ]);

  title(): string {
    return "";
  }

  document_element(): number {
    return 1;
  }

  body(): number {
    return 2;
  }

  active_element(): number | undefined {
    return this.active;
  }

  create_element(tagName: string): number {
    switch (tagName) {
      case "input":
        return 3;
      case "textarea":
        return 4;
      default:
        throw new TypeError(`unsupported fake element: ${tagName}`);
    }
  }

  element_interface(nodeHandle: number): number {
    const elementInterface = this.#interfaces.get(nodeHandle);
    if (elementInterface === undefined) throw new TypeError(`unknown fake handle: ${nodeHandle}`);
    return elementInterface;
  }

  remove_node(nodeHandle: number): void {
    if (this.active === nodeHandle) this.active = 2;
  }

  append_child(_parentHandle: number, _childHandle: number): void {
    // Reattaching an old wrapper must not restore the focus cleared by removal.
  }

  form_control_value(nodeHandle: number): string {
    const value = this.#values.get(nodeHandle);
    if (value === undefined) throw new TypeError(`unknown fake form control: ${nodeHandle}`);
    return value;
  }

  set_form_control_value(nodeHandle: number, value: string): number {
    const previous = this.form_control_value(nodeHandle);
    this.#values.set(nodeHandle, value);
    return Number(previous !== value);
  }
}

function createDocument(
  renderer: FakeActiveElementRenderer,
  assertActive: () => void = () => undefined,
): QuoxDocument {
  return new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    assertActive,
  );
}

Deno.test("activeElement preserves fallback wrapper identity and null", () => {
  const renderer = new FakeActiveElementRenderer();
  const document = createDocument(renderer);

  assertStrictEquals(document.activeElement, document.body);

  renderer.active = 1;
  assertStrictEquals(document.activeElement, document.documentElement);

  renderer.active = undefined;
  assertEquals(document.activeElement, null);
});

Deno.test("activeElement returns the cached specialized element wrapper", () => {
  const renderer = new FakeActiveElementRenderer();
  const document = createDocument(renderer);
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");

  renderer.active = 3;
  assertInstanceOf(document.activeElement, QuoxInputElement);
  assertStrictEquals(document.activeElement, input);

  renderer.active = 4;
  assertInstanceOf(document.activeElement, QuoxTextAreaElement);
  assertStrictEquals(document.activeElement, textarea);
  assertInstanceOf(document.body, QuoxElement);
});

Deno.test("activeElement observes document liveness before crossing the boundary", () => {
  const renderer = new FakeActiveElementRenderer();
  let active = true;
  const document = createDocument(renderer, () => {
    if (!active) throw new Error("stopped");
  });

  active = false;
  assertThrows(() => document.activeElement, Error, "stopped");
});

Deno.test("detaching the active control is silent and reattachment does not restore focus", () => {
  const renderer = new FakeActiveElementRenderer();
  const document = createDocument(renderer);
  const input = document.createElement("input");
  let focusEvents = 0;
  input.addEventListener("blur", () => focusEvents += 1);
  input.addEventListener("focusout", () => focusEvents += 1);
  input.value = "edited";
  renderer.active = input.nodeId;

  input.remove();
  assertStrictEquals(document.activeElement, document.body);
  assertEquals(input.value, "edited");
  assertEquals(focusEvents, 0);

  document.body.appendChild(input);
  assertStrictEquals(document.activeElement, document.body);
  assertEquals(input.value, "edited");
  assertEquals(focusEvents, 0);
});
