import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { type AssertActive, attachDocumentInternals, type RequestRender } from "./internals.ts";
import { QuoxElement, QuoxText } from "./node.ts";

type SetNativeTitle = (title: string) => void;

export class QuoxDocument {
  readonly #renderer: WasmRenderer;
  readonly #requestRender: RequestRender;
  readonly #assertActive: AssertActive;
  readonly #setNativeTitle: SetNativeTitle;
  #currentTitle: string;

  constructor(
    renderer: WasmRenderer,
    requestRender: RequestRender,
    assertActive: AssertActive,
    setNativeTitle: SetNativeTitle = () => undefined,
  ) {
    this.#renderer = renderer;
    this.#requestRender = requestRender;
    this.#assertActive = assertActive;
    this.#setNativeTitle = setNativeTitle;
    this.#currentTitle = renderer.title();
    attachDocumentInternals(this, {
      renderer,
      requestRender,
      assertActive,
      syncTitle: () => {
        this.#syncTitle();
      },
    });
  }

  get title(): string {
    return this.#syncTitle();
  }

  set title(value: string) {
    this.#assertActive();
    const title = String(value);
    this.#renderer.set_title(title);
    this.#currentTitle = title;
    this.#setNativeTitle(title);
    this.#requestRender();
  }

  #syncTitle(): string {
    this.#assertActive();
    const title = this.#renderer.title();
    if (title !== this.#currentTitle) {
      this.#currentTitle = title;
      this.#setNativeTitle(title);
    }

    return title;
  }

  get documentElement(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.document_element());
  }

  get head(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.head());
  }

  get body(): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.body());
  }

  createElement(tagName: string): QuoxElement {
    this.#assertActive();
    return new QuoxElement(this, this.#renderer.create_element(tagName));
  }

  createTextNode(text: string): QuoxText {
    this.#assertActive();
    return new QuoxText(this, this.#renderer.create_text_node(text));
  }
}
