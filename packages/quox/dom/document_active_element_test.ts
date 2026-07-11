import { assertEquals, assertInstanceOf, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxElement, QuoxInputElement, QuoxTextAreaElement } from "./node.ts";

class FakeActiveElementRenderer {
  active: number | undefined = 2;
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
