import type { QuoxDocument } from "./document.ts";
import { getEventHandler, setEventHandler } from "./event_handlers.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string;

export type QuoxEventType = "click" | "dblclick" | "contextmenu" | "input" | "focus" | "blur" | "scroll";

export interface QuoxEvent {
  readonly type: QuoxEventType;
  readonly target: QuoxElement;
  readonly currentTarget: QuoxElement | null;
  readonly bubbles: boolean;
  stopPropagation(): void;
}

export type QuoxEventHandler = (this: QuoxElement, event: QuoxEvent) => unknown;

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
  get onclick(): QuoxEventHandler | null {
    return getEventHandler(this, "click");
  }

  set onclick(handler: QuoxEventHandler | null) {
    setEventHandler(this, "click", handler);
  }

  get ondblclick(): QuoxEventHandler | null {
    return getEventHandler(this, "dblclick");
  }

  set ondblclick(handler: QuoxEventHandler | null) {
    setEventHandler(this, "dblclick", handler);
  }

  get oncontextmenu(): QuoxEventHandler | null {
    return getEventHandler(this, "contextmenu");
  }

  set oncontextmenu(handler: QuoxEventHandler | null) {
    setEventHandler(this, "contextmenu", handler);
  }

  get oninput(): QuoxEventHandler | null {
    return getEventHandler(this, "input");
  }

  set oninput(handler: QuoxEventHandler | null) {
    setEventHandler(this, "input", handler);
  }

  get onfocus(): QuoxEventHandler | null {
    return getEventHandler(this, "focus");
  }

  set onfocus(handler: QuoxEventHandler | null) {
    setEventHandler(this, "focus", handler);
  }

  get onblur(): QuoxEventHandler | null {
    return getEventHandler(this, "blur");
  }

  set onblur(handler: QuoxEventHandler | null) {
    setEventHandler(this, "blur", handler);
  }

  get onscroll(): QuoxEventHandler | null {
    return getEventHandler(this, "scroll");
  }

  set onscroll(handler: QuoxEventHandler | null) {
    setEventHandler(this, "scroll", handler);
  }

  set innerHTML(value: QuoxInnerHTML) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const html = value;
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
