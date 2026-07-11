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

type LiveScrollRenderer = {
  element_scroll_left(nodeHandle: number): number;
  element_scroll_top(nodeHandle: number): number;
  set_element_scroll_left(nodeHandle: number, value: number): boolean;
  set_element_scroll_top(nodeHandle: number, value: number): boolean;
};

type LiveTextControlRenderer = {
  form_control_value(nodeHandle: number): string;
  set_form_control_value(nodeHandle: number, value: string): boolean;
};

type LiveCheckedControlRenderer = {
  form_control_checked(nodeHandle: number): boolean;
  set_form_control_checked(nodeHandle: number, checked: boolean): boolean;
};

type TextControlSelectionRenderer = {
  form_control_selection(nodeHandle: number): Uint32Array | undefined;
  set_form_control_selection(
    nodeHandle: number,
    start: number,
    end: number,
    direction: number,
  ): boolean | undefined;
  select_form_control_text(nodeHandle: number): boolean;
};

export type QuoxSelectionDirection = "none" | "forward" | "backward";

type TextControlSelection = {
  readonly start: number;
  readonly end: number;
  readonly direction: QuoxSelectionDirection;
};

const UINT32_MODULUS = 0x1_0000_0000;

/** Web IDL `unsigned long` conversion (ordinary modulo semantics, without Clamp/EnforceRange). */
function unsignedLong(value: unknown): number {
  // Unary plus performs ECMAScript ToNumber, including the required TypeError for Symbol/BigInt.
  const number = +(value as number);
  if (!Number.isFinite(number) || number === 0) return 0;
  const remainder = Math.trunc(number) % UINT32_MODULUS;
  return remainder < 0 ? remainder + UINT32_MODULUS : remainder;
}

function selectionDirection(value: unknown): QuoxSelectionDirection {
  if (value === undefined) return "none";
  if (typeof value === "symbol") throw new TypeError("a Web IDL string cannot be a symbol");
  const direction = String(value);
  return direction === "forward" || direction === "backward" ? direction : "none";
}

function selectionDirectionCode(direction: QuoxSelectionDirection): number {
  switch (direction) {
    case "none":
      return 0;
    case "forward":
      return 1;
    case "backward":
      return 2;
  }
}

function readTextControlSelection(element: QuoxElement): TextControlSelection | null {
  const { renderer } = documentInternals(element.ownerDocument);
  const values = (renderer as unknown as TextControlSelectionRenderer).form_control_selection(element.nodeId);
  if (values === undefined) return null;
  if (values.length !== 3) throw new RangeError("quox: invalid text-control selection payload");
  const start = assertUint32(values[0], "selectionStart");
  const end = assertUint32(values[1], "selectionEnd");
  const directionCode = assertUint32(values[2], "selectionDirection");
  const direction = directionCode === 0
    ? "none"
    : directionCode === 1
    ? "forward"
    : directionCode === 2
    ? "backward"
    : undefined;
  if (direction === undefined || end < start) {
    throw new RangeError("quox: invalid text-control selection payload");
  }
  return { start, end, direction };
}

function requireTextControlSelection(element: QuoxElement): TextControlSelection {
  const selection = readTextControlSelection(element);
  if (selection === null) {
    throw new DOMException("The input element's type does not support selection.", "InvalidStateError");
  }
  return selection;
}

function setTextControlSelection(
  element: QuoxElement,
  start: number,
  end: number,
  direction: QuoxSelectionDirection,
): void {
  const { renderer, requestRender } = documentInternals(element.ownerDocument);
  const changed = (renderer as unknown as TextControlSelectionRenderer).set_form_control_selection(
    element.nodeId,
    start,
    end,
    selectionDirectionCode(direction),
  );
  if (changed === undefined) {
    throw new DOMException("The input element's type does not support selection.", "InvalidStateError");
  }
  if (changed) requestRender();
}

function selectTextControl(element: QuoxElement): void {
  const { renderer, requestRender } = documentInternals(element.ownerDocument);
  if ((renderer as unknown as TextControlSelectionRenderer).select_form_control_text(element.nodeId)) {
    requestRender();
  }
}

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

/** Web IDL `unrestricted double` conversion plus CSSOM View's non-finite normalization. */
function scrollOffsetNumber(value: unknown): number {
  // Unary plus performs ToNumber exactly once and throws for Symbol and BigInt.
  const number = +(value as number);
  return Number.isFinite(number) ? number : 0;
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
  focus(): void {
    documentInternals(this.ownerDocument).focusElement(this.nodeId);
  }

  blur(): void {
    documentInternals(this.ownerDocument).blurElement(this.nodeId);
  }

  get scrollLeft(): number {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveScrollRenderer).element_scroll_left(this.nodeId);
  }

  set scrollLeft(value: number) {
    const converted = scrollOffsetNumber(value);
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    if ((renderer as unknown as LiveScrollRenderer).set_element_scroll_left(this.nodeId, converted)) {
      requestRender();
    }
  }

  get scrollTop(): number {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveScrollRenderer).element_scroll_top(this.nodeId);
  }

  set scrollTop(value: number) {
    const converted = scrollOffsetNumber(value);
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    if ((renderer as unknown as LiveScrollRenderer).set_element_scroll_top(this.nodeId, converted)) {
      requestRender();
    }
  }

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

  get checked(): boolean {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveCheckedControlRenderer).form_control_checked(this.nodeId);
  }

  set checked(value: boolean) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const changed = (renderer as unknown as LiveCheckedControlRenderer).set_form_control_checked(
      this.nodeId,
      Boolean(value),
    );
    if (changed) requestRender();
  }

  get defaultChecked(): boolean {
    return this.hasAttribute("checked");
  }

  set defaultChecked(value: boolean) {
    const checked = Boolean(value);
    if (checked === this.hasAttribute("checked")) return;
    if (checked) this.setAttribute("checked", "");
    else this.removeAttribute("checked");
  }

  get selectionStart(): number | null {
    return readTextControlSelection(this)?.start ?? null;
  }

  set selectionStart(value: number | null) {
    const start = unsignedLong(value);
    const selection = requireTextControlSelection(this);
    const end = selection.end < start ? start : selection.end;
    setTextControlSelection(this, start, end, selection.direction);
  }

  get selectionEnd(): number | null {
    return readTextControlSelection(this)?.end ?? null;
  }

  set selectionEnd(value: number | null) {
    const end = unsignedLong(value);
    const selection = requireTextControlSelection(this);
    setTextControlSelection(this, selection.start, end, selection.direction);
  }

  get selectionDirection(): QuoxSelectionDirection | null {
    return readTextControlSelection(this)?.direction ?? null;
  }

  set selectionDirection(value: QuoxSelectionDirection | null) {
    const direction = selectionDirection(value);
    const selection = requireTextControlSelection(this);
    setTextControlSelection(this, selection.start, selection.end, direction);
  }

  setSelectionRange(start: number, end: number, direction: QuoxSelectionDirection = "none"): void {
    if (arguments.length < 2) {
      throw new TypeError("setSelectionRange requires at least 2 arguments");
    }
    const convertedStart = unsignedLong(start);
    const convertedEnd = unsignedLong(end);
    const convertedDirection = selectionDirection(direction);
    setTextControlSelection(this, convertedStart, convertedEnd, convertedDirection);
  }

  select(): void {
    selectTextControl(this);
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

  get selectionStart(): number {
    return requireTextControlSelection(this).start;
  }

  set selectionStart(value: number) {
    const start = unsignedLong(value);
    const selection = requireTextControlSelection(this);
    const end = selection.end < start ? start : selection.end;
    setTextControlSelection(this, start, end, selection.direction);
  }

  get selectionEnd(): number {
    return requireTextControlSelection(this).end;
  }

  set selectionEnd(value: number) {
    const end = unsignedLong(value);
    const selection = requireTextControlSelection(this);
    setTextControlSelection(this, selection.start, end, selection.direction);
  }

  get selectionDirection(): QuoxSelectionDirection {
    return requireTextControlSelection(this).direction;
  }

  set selectionDirection(value: QuoxSelectionDirection) {
    const direction = selectionDirection(value);
    const selection = requireTextControlSelection(this);
    setTextControlSelection(this, selection.start, selection.end, direction);
  }

  setSelectionRange(start: number, end: number, direction: QuoxSelectionDirection = "none"): void {
    if (arguments.length < 2) {
      throw new TypeError("setSelectionRange requires at least 2 arguments");
    }
    const convertedStart = unsignedLong(start);
    const convertedEnd = unsignedLong(end);
    const convertedDirection = selectionDirection(direction);
    setTextControlSelection(this, convertedStart, convertedEnd, convertedDirection);
  }

  select(): void {
    selectTextControl(this);
  }
}

export class QuoxText extends QuoxNode {}
