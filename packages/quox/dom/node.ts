import type { VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";
import type { QuoxDocument } from "./document.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string | VNode;

export class QuoxNode {
  constructor(
    readonly ownerDocument: QuoxDocument,
    readonly nodeId: number,
  ) {}

  get textContent(): string {
    return documentInternals(this.ownerDocument).renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_text_content(this.nodeId, value ?? "");
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
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const html = typeof value === "string" ? value : renderToString(value);
    renderer.set_inner_html(this.nodeId, html);
    requestRender();
  }

  setAttribute(name: string, value: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_attribute(this.nodeId, name, value);
    requestRender();
  }

  removeAttribute(name: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_attribute(this.nodeId, name);
    requestRender();
  }
}

export class QuoxText extends QuoxNode {}
