import type { QuoxDocument } from "./document.ts";
import type { QuoxEvent } from "./event.ts";
import { eventTargetPath, QuoxEventTarget } from "./event_target.ts";
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

type LiveTextControlRenderer = {
  form_control_value(nodeHandle: number): string;
  set_form_control_value(nodeHandle: number, value: string): boolean;
};

/** Web IDL DOMString conversion followed by the scalar-value repair required by Rust UTF-8. */
function boundaryString(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("a Web IDL string cannot be a symbol");
  const source = String(value);
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += source[index] + source[index + 1];
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += source[index];
    }
  }
  return result;
}

function controlValueString(value: unknown): string {
  return value === null ? "" : boundaryString(value);
}

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

  override [eventTargetPath](event: QuoxEvent): readonly QuoxEventTarget[] {
    const path = Array.from(
      documentInternals(this.ownerDocument).syntheticEventPath(this.nodeId, event),
    );
    const resolvedTarget = path[0];
    if (!(resolvedTarget instanceof QuoxNode) || resolvedTarget.nodeId !== this.nodeId) {
      throw new TypeError("quox: synthetic event path does not start with its target node");
    }
    path[0] = this;
    return path;
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

export class QuoxInputElement extends QuoxElement {
  get value(): string {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveTextControlRenderer).form_control_value(this.nodeId);
  }

  set value(value: string) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const changed = (renderer as unknown as LiveTextControlRenderer).set_form_control_value(
      this.nodeId,
      controlValueString(value),
    );
    if (changed) requestRender();
  }

  get defaultValue(): string {
    return this.getAttribute("value") ?? "";
  }

  set defaultValue(value: string) {
    this.setAttribute("value", boundaryString(value));
  }
}

export class QuoxTextAreaElement extends QuoxElement {
  get value(): string {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveTextControlRenderer).form_control_value(this.nodeId);
  }

  set value(value: string) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const changed = (renderer as unknown as LiveTextControlRenderer).set_form_control_value(
      this.nodeId,
      controlValueString(value),
    );
    if (changed) requestRender();
  }

  get defaultValue(): string {
    return this.textContent;
  }

  set defaultValue(value: string) {
    this.textContent = boundaryString(value);
  }
}

export class QuoxText extends QuoxNode {}
