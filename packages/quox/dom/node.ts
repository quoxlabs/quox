import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";

export type RequestRender = () => void;
export type QuoxInnerHTML = string | VNode;

export class QuoxNode {
  protected constructor(
    protected readonly renderer: WasmRenderer,
    readonly nodeId: number,
    protected readonly requestRender: RequestRender,
  ) {}

  get textContent(): string {
    return this.renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    this.renderer.set_text_content(this.nodeId, value ?? "");
    this.requestRender();
  }

  appendChild<T extends QuoxNode>(child: T): T {
    this.renderer.append_child(this.nodeId, child.nodeId);
    this.requestRender();
    return child;
  }

  remove(): void {
    this.renderer.remove_node(this.nodeId);
    this.requestRender();
  }
}

export class QuoxElement extends QuoxNode {
  constructor(renderer: WasmRenderer, nodeId: number, requestRender: RequestRender) {
    super(renderer, nodeId, requestRender);
  }

  set innerHTML(value: QuoxInnerHTML) {
    const stringValue = typeof value === "string" ? value : renderToString(value);
    this.renderer.set_inner_html(this.nodeId, stringValue);
    this.requestRender();
  }

  setAttribute(name: string, value: string): void {
    this.renderer.set_attribute(this.nodeId, name, value);
    this.requestRender();
  }

  removeAttribute(name: string): void {
    this.renderer.remove_attribute(this.nodeId, name);
    this.requestRender();
  }
}

export class QuoxText extends QuoxNode {
  constructor(renderer: WasmRenderer, nodeId: number, requestRender: RequestRender) {
    super(renderer, nodeId, requestRender);
  }
}
