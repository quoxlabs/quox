import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxElement, QuoxText, type RequestRender } from "./node.ts";

export class QuoxDocument {
  constructor(
    private readonly renderer: WasmRenderer,
    private readonly requestRender: RequestRender,
  ) {}

  get documentElement(): QuoxElement {
    return new QuoxElement(this.renderer, this.renderer.document_element(), this.requestRender);
  }

  get head(): QuoxElement {
    return new QuoxElement(this.renderer, this.renderer.head(), this.requestRender);
  }

  get body(): QuoxElement {
    return new QuoxElement(this.renderer, this.renderer.body(), this.requestRender);
  }

  createElement(tagName: string): QuoxElement {
    return new QuoxElement(this.renderer, this.renderer.create_element(tagName), this.requestRender);
  }

  createTextNode(text: string): QuoxText {
    return new QuoxText(this.renderer, this.renderer.create_text_node(text), this.requestRender);
  }
}
