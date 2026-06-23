// @ts-types="./lib/quox.d.ts"
import type { QuoxRenderer as WasmRenderer } from "./lib/quox.js";

type MutationCallback = () => void;
type ActiveCallback = () => void;

export class QuoxNode {
  readonly ownerDocument: QuoxDocument;
  readonly id: number;

  constructor(ownerDocument: QuoxDocument, id: number) {
    this.ownerDocument = ownerDocument;
    this.id = id;
  }

  appendChild<T extends QuoxNode>(child: T): T {
    this.ownerDocument.appendChild(this, child);
    return child;
  }

  remove(): void {
    this.ownerDocument.removeNode(this);
  }

  get textContent(): string {
    return this.ownerDocument.textContent(this);
  }

  set textContent(value: string) {
    this.ownerDocument.setTextContent(this, value);
  }
}

export class QuoxElement extends QuoxNode {
  setAttribute(name: string, value: string): void {
    this.ownerDocument.setAttribute(this, name, value);
  }

  removeAttribute(name: string): void {
    this.ownerDocument.removeAttribute(this, name);
  }

  set innerHTML(value: string) {
    this.ownerDocument.setInnerHTML(this, value);
  }
}

export class QuoxText extends QuoxNode {}

export class QuoxDocument {
  readonly #renderer: WasmRenderer;
  readonly #onMutation: MutationCallback;
  readonly #assertActive: ActiveCallback;

  constructor(
    renderer: WasmRenderer,
    onMutation: MutationCallback = () => {},
    assertActive: ActiveCallback = () => {},
  ) {
    this.#renderer = renderer;
    this.#onMutation = onMutation;
    this.#assertActive = assertActive;
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
    const element = new QuoxElement(this, this.#renderer.create_element(tagName));
    this.#onMutation();
    return element;
  }

  createTextNode(text: string): QuoxText {
    this.#assertActive();
    const node = new QuoxText(this, this.#renderer.create_text_node(text));
    this.#onMutation();
    return node;
  }

  appendChild<T extends QuoxNode>(parent: QuoxNode, child: T): T {
    this.#assertActive();
    this.#assertOwner(parent);
    this.#assertOwner(child);
    this.#renderer.append_child(parent.id, child.id);
    this.#onMutation();
    return child;
  }

  removeNode(node: QuoxNode): void {
    this.#assertActive();
    this.#assertOwner(node);
    this.#renderer.remove_node(node.id);
    this.#onMutation();
  }

  setAttribute(node: QuoxNode, name: string, value: string): void {
    this.#assertActive();
    this.#assertOwner(node);
    this.#renderer.set_attribute(node.id, name, value);
    this.#onMutation();
  }

  removeAttribute(node: QuoxNode, name: string): void {
    this.#assertActive();
    this.#assertOwner(node);
    this.#renderer.remove_attribute(node.id, name);
    this.#onMutation();
  }

  textContent(node: QuoxNode): string {
    this.#assertActive();
    this.#assertOwner(node);
    return this.#renderer.text_content(node.id);
  }

  setTextContent(node: QuoxNode, value: string): void {
    this.#assertActive();
    this.#assertOwner(node);
    this.#renderer.set_text_content(node.id, value);
    this.#onMutation();
  }

  setInnerHTML(node: QuoxNode, html: string): void {
    this.#assertActive();
    this.#assertOwner(node);
    this.#renderer.set_inner_html(node.id, html);
    this.#onMutation();
  }

  #assertOwner(node: QuoxNode): void {
    if (node.ownerDocument !== this) {
      throw new TypeError("node belongs to a different document");
    }
  }
}
