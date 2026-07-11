import type { QuoxDocument } from "./document.ts";
import { QuoxEventTarget } from "./event_target.ts";
import { assertUint32 } from "./ffi_numbers.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string;

type InvalidatingNodeRenderer = {
  set_text_content(nodeHandle: number, value: string): Uint32Array;
  set_inner_html(nodeHandle: number, html: string): Uint32Array;
};

type AttributeRenderer = {
  get_attribute(nodeHandle: number, name: string): string | undefined;
};

export class QuoxNode extends QuoxEventTarget {
  readonly ownerDocument: QuoxDocument;
  readonly #nodeId: number;

  /** Opaque document-local handle. Its numeric value has no relationship to Blitz's slab id. */
  constructor(ownerDocument: QuoxDocument, nodeId: number) {
    super();
    this.ownerDocument = ownerDocument;
    this.#nodeId = assertUint32(nodeId, "nodeHandle");
  }

  get nodeId(): number {
    return this.#nodeId;
  }

  get textContent(): string {
    return documentInternals(this.ownerDocument).renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    const { invalidateNodeHandles, renderer, requestRender } = documentInternals(this.ownerDocument);
    const invalidated = (renderer as unknown as InvalidatingNodeRenderer).set_text_content(this.nodeId, value ?? "");
    invalidateNodeHandles(invalidated);
    requestRender();
  }

  appendChild<T extends QuoxNode>(child: T): T {
    if (child.ownerDocument !== this.ownerDocument) {
      throw new TypeError("node belongs to a different document");
    }

    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.append_child(this.nodeId, child.nodeId);
    requestRender();
    return child;
  }

  remove(): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_node(this.nodeId);
    requestRender();
  }
}

export class QuoxElement extends QuoxNode {
  set innerHTML(value: QuoxInnerHTML) {
    const { invalidateNodeHandles, renderer, requestRender } = documentInternals(this.ownerDocument);
    const html = value;
    const invalidated = (renderer as unknown as InvalidatingNodeRenderer).set_inner_html(this.nodeId, html);
    invalidateNodeHandles(invalidated);
    requestRender();
  }

  setAttribute(name: string, value: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_attribute(this.nodeId, name, value);
    requestRender();
  }

  getAttribute(name: string): string | null {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as AttributeRenderer).get_attribute(this.nodeId, name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_attribute(this.nodeId, name);
    requestRender();
  }
}

export class QuoxText extends QuoxNode {}
