import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { attachDocumentInternals, type RequestRender } from "./internals.ts";
import { QuoxElement, QuoxText } from "./node.ts";

export class QuoxDocument {
  readonly #renderer: WasmRenderer;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
  ) {
    this.#renderer = renderer;
    attachDocumentInternals(this, { renderer, requestRender });
  }

  get documentElement(): QuoxElement {
    return new QuoxElement(this, this.#renderer.document_element());
  }

  get head(): QuoxElement {
    return new QuoxElement(this, this.#renderer.head());
  }

  get body(): QuoxElement {
    return new QuoxElement(this, this.#renderer.body());
  }

  createElement(tagName: string): QuoxElement {
    return new QuoxElement(this, this.#renderer.create_element(tagName));
  }

  createTextNode(text: string): QuoxText {
    return new QuoxText(this, this.#renderer.create_text_node(text));
  }
}
