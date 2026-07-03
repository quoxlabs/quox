import type { QuoxDocument } from "./document.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string;

export class QuoxNode {
  constructor(
    readonly ownerDocument: QuoxDocument,
    readonly nodeId: number,
  ) {}

  get textContent(): string {
    return documentInternals(this.ownerDocument).renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    const { renderer, requestRender, syncTitle } = documentInternals(this.ownerDocument);
    renderer.set_text_content(this.nodeId, value ?? "");
    syncTitle();
    requestRender();
  }

  appendChild<T extends QuoxNode>(child: T): T {
    if (child.ownerDocument !== this.ownerDocument) {
      throw new TypeError("node belongs to a different document");
    }

    const { renderer, requestRender, syncTitle } = documentInternals(this.ownerDocument);
    renderer.append_child(this.nodeId, child.nodeId);
    syncTitle();
    requestRender();
    return child;
  }

  remove(): void {
    const { renderer, requestRender, syncTitle } = documentInternals(this.ownerDocument);
    renderer.remove_node(this.nodeId);
    syncTitle();
    requestRender();
  }
}

export class QuoxElement extends QuoxNode {
  set innerHTML(value: QuoxInnerHTML) {
    const { renderer, requestRender, syncTitle } = documentInternals(this.ownerDocument);
    const html = value;
    renderer.set_inner_html(this.nodeId, html);
    syncTitle();
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
