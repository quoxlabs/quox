import { assertEquals } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";
import { attachDocumentInternals } from "./internals.ts";
import { QuoxElement } from "./node.ts";

class FakeAttributeRenderer {
  readonly #attributes = new Map<string, string>();

  constructor(attributes: Record<string, string>) {
    for (const [name, value] of Object.entries(attributes)) {
      this.#attributes.set(name.toLowerCase(), value);
    }
  }

  get_attribute(_nodeHandle: number, name: string): string | undefined {
    return this.#attributes.get(name.toLowerCase());
  }
}

function createElement(attributes: Record<string, string>): QuoxElement {
  const document = {} as QuoxDocument;
  const renderer = new FakeAttributeRenderer(attributes);
  const element = new QuoxElement(document, 1);
  attachDocumentInternals(document, {
    renderer: renderer as unknown as WasmRenderer,
    requestRender: () => undefined,
    assertActive: () => undefined,
    invalidateNodeHandles: () => undefined,
    isDispatching: () => false,
    focusElement: () => undefined,
    blurElement: () => undefined,
    syntheticEventPath: () => [element],
  });
  return element;
}

Deno.test("element attribute reads distinguish absent and empty values", () => {
  const element = createElement({ "data-empty": "", "data-label": "present" });

  assertEquals(element.getAttribute("DATA-EMPTY"), "");
  assertEquals(element.hasAttribute("DaTa-EmPtY"), true);
  assertEquals(element.getAttribute("DATA-LABEL"), "present");
  assertEquals(element.getAttribute("data-missing"), null);
  assertEquals(element.hasAttribute("DATA-MISSING"), false);
});
