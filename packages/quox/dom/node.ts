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
  set_form_control_value(nodeHandle: number, value: string): number;
};

type LiveFileSelectionRenderer = {
  form_control_file_names(nodeHandle: number): unknown;
};

type LiveCheckedControlRenderer = {
  form_control_checked(nodeHandle: number): boolean;
  set_form_control_checked(nodeHandle: number, checked: boolean): boolean;
  form_control_indeterminate(nodeHandle: number): boolean;
  set_form_control_indeterminate(nodeHandle: number, indeterminate: boolean): boolean;
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
export type QuoxColorSpace = "limited-srgb" | "display-p3";

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

function setLiveControlValue(element: QuoxElement, value: string): void {
  const { renderer, requestRender } = documentInternals(element.ownerDocument);
  const result = (renderer as unknown as LiveTextControlRenderer).set_form_control_value(
    element.nodeId,
    value,
  );
  switch (result) {
    case 0:
      return;
    case 1:
      requestRender();
      return;
    case 2:
      throw new DOMException(
        "A file input's value may only be set to the empty string.",
        "InvalidStateError",
      );
    default:
      throw new RangeError("quox: invalid form-control value result");
  }
}

/** A deliberately narrow selected-file facade. File bytes and host metadata are unavailable. */
export class QuoxSelectedFile {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
    Object.freeze(this);
  }

  get name(): string {
    return this.#name;
  }

  get [Symbol.toStringTag](): string {
    return "QuoxSelectedFile";
  }
}

/** Live, read-only view of a file input's selected basenames. */
export interface QuoxFileList extends Iterable<QuoxSelectedFile> {
  readonly length: number;
  readonly [index: number]: QuoxSelectedFile;
  item(index: number): QuoxSelectedFile | null;
}

type FileSelectionSnapshot = {
  readonly available: boolean;
  readonly entries: readonly QuoxSelectedFile[];
};

type FileListState = {
  readonly read: () => readonly string[] | null;
  names: readonly string[];
  entries: readonly QuoxSelectedFile[];
};

const EMPTY_FILE_NAMES: readonly string[] = Object.freeze([]);
const EMPTY_FILE_ENTRIES: readonly QuoxSelectedFile[] = Object.freeze([]);
const FILE_LIST_STATES = new WeakMap<LiveQuoxFileList, FileListState>();

function fileListIndex(property: PropertyKey): number | undefined {
  if (typeof property !== "string" || !/^(?:0|[1-9]\d*)$/.test(property)) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) && index < UINT32_MODULUS - 1 ? index : undefined;
}

function selectedFileNames(element: QuoxInputElement): readonly string[] | null {
  const { renderer } = documentInternals(element.ownerDocument);
  const payload = (renderer as unknown as LiveFileSelectionRenderer).form_control_file_names(
    element.nodeId,
  );
  if (payload === undefined) return null;
  if (!Array.isArray(payload)) {
    throw new TypeError("quox: invalid file-selection payload");
  }
  const names = payload.map((name, index) => {
    if (typeof name !== "string" || name.includes("/") || name.includes("\\")) {
      throw new TypeError(`quox: invalid selected-file basename at index ${index}`);
    }
    return name;
  });
  return Object.freeze(names);
}

function fileListState(list: LiveQuoxFileList): FileListState {
  const state = FILE_LIST_STATES.get(list);
  if (state === undefined) throw new TypeError("quox: invalid FileList receiver");
  return state;
}

function syncFileList(list: LiveQuoxFileList): FileSelectionSnapshot {
  const state = fileListState(list);
  const selection = state.read();
  const names = selection ?? EMPTY_FILE_NAMES;
  if (
    names.length !== state.names.length ||
    names.some((name, index) => name !== state.names[index])
  ) {
    state.names = names;
    state.entries = Object.freeze(names.map((name) => new QuoxSelectedFile(name)));
  }
  return { available: selection !== null, entries: state.entries };
}

function fileListAvailable(list: LiveQuoxFileList): boolean {
  return syncFileList(list).available;
}

class LiveQuoxFileList implements QuoxFileList {
  readonly [index: number]: QuoxSelectedFile;

  constructor(read: () => readonly string[] | null) {
    const proxy = new Proxy(this, {
      get(target, property, receiver) {
        const index = fileListIndex(property);
        return index === undefined ? Reflect.get(target, property, receiver) : syncFileList(target).entries[index];
      },
      has(target, property) {
        const index = fileListIndex(property);
        return index === undefined ? Reflect.has(target, property) : index < syncFileList(target).entries.length;
      },
      ownKeys(target) {
        const indexed = syncFileList(target).entries.map((_entry, index) => String(index));
        return [...indexed, ...Reflect.ownKeys(target)];
      },
      getOwnPropertyDescriptor(target, property) {
        const index = fileListIndex(property);
        if (index === undefined) return Reflect.getOwnPropertyDescriptor(target, property);
        const entry = syncFileList(target).entries[index];
        return entry === undefined
          ? undefined
          : { configurable: true, enumerable: true, value: entry, writable: false };
      },
      set(target, property, value, receiver) {
        return fileListIndex(property) === undefined && property !== "length"
          ? Reflect.set(target, property, value, receiver)
          : false;
      },
      defineProperty(target, property, attributes) {
        return fileListIndex(property) === undefined && property !== "length"
          ? Reflect.defineProperty(target, property, attributes)
          : false;
      },
      deleteProperty(target, property) {
        return fileListIndex(property) === undefined ? Reflect.deleteProperty(target, property) : false;
      },
      // Dynamic indexed own keys are incompatible with a non-extensible proxy target. Rejecting
      // the transition keeps later native selections observable instead of poisoning reflection.
      preventExtensions() {
        return false;
      },
    });
    const state = { read, names: EMPTY_FILE_NAMES, entries: EMPTY_FILE_ENTRIES };
    FILE_LIST_STATES.set(this, state);
    FILE_LIST_STATES.set(proxy, state);
    return proxy;
  }

  get length(): number {
    return syncFileList(this).entries.length;
  }

  item(index: number): QuoxSelectedFile | null {
    return syncFileList(this).entries[unsignedLong(index)] ?? null;
  }

  [Symbol.iterator](): Iterator<QuoxSelectedFile> {
    return syncFileList(this).entries[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "FileList";
  }
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
    const { queueScrollEvent, renderer } = documentInternals(this.ownerDocument);
    if ((renderer as unknown as LiveScrollRenderer).set_element_scroll_left(this.nodeId, converted)) {
      queueScrollEvent(this.nodeId);
    }
  }

  get scrollTop(): number {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveScrollRenderer).element_scroll_top(this.nodeId);
  }

  set scrollTop(value: number) {
    const converted = scrollOffsetNumber(value);
    const { queueScrollEvent, renderer } = documentInternals(this.ownerDocument);
    if ((renderer as unknown as LiveScrollRenderer).set_element_scroll_top(this.nodeId, converted)) {
      queueScrollEvent(this.nodeId);
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
  readonly #files = new LiveQuoxFileList(() => selectedFileNames(this));

  get value(): string {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveTextControlRenderer).form_control_value(this.nodeId);
  }

  set value(value: string) {
    setLiveControlValue(this, controlValueString(value));
  }

  get files(): QuoxFileList | null {
    return fileListAvailable(this.#files) ? this.#files : null;
  }

  get defaultValue(): string {
    return this.getAttribute("value") ?? "";
  }

  set defaultValue(value: string) {
    this.setAttribute("value", boundaryString(value));
  }

  get alpha(): boolean {
    return this.hasAttribute("alpha");
  }

  set alpha(value: boolean) {
    const alpha = Boolean(value);
    if (alpha === this.hasAttribute("alpha")) return;
    if (alpha) this.setAttribute("alpha", "");
    else this.removeAttribute("alpha");
  }

  get colorSpace(): QuoxColorSpace {
    return this.getAttribute("colorspace")?.toLowerCase() === "display-p3" ? "display-p3" : "limited-srgb";
  }

  set colorSpace(value: QuoxColorSpace) {
    this.setAttribute("colorspace", boundaryString(value));
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

  get indeterminate(): boolean {
    const { renderer } = documentInternals(this.ownerDocument);
    return (renderer as unknown as LiveCheckedControlRenderer).form_control_indeterminate(
      this.nodeId,
    );
  }

  set indeterminate(value: boolean) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const changed = (renderer as unknown as LiveCheckedControlRenderer).set_form_control_indeterminate(
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
    setLiveControlValue(this, controlValueString(value));
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
