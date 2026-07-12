import { assertEquals, assertInstanceOf, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxInputElement, QuoxTextAreaElement } from "./node.ts";

interface ControlState {
  readonly tagName: string;
  readonly attributes: Map<string, string>;
  defaultText: string;
  value: string;
  dirty: boolean;
  checked: boolean;
  dirtyCheckedness: boolean;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: 0 | 1 | 2;
}

type InputValueMode =
  | "value"
  | "date-time-value"
  | "range-value"
  | "unsupported-value"
  | "default"
  | "default-on"
  | "filename";

function inputValueMode(control: ControlState): InputValueMode {
  const type = (control.attributes.get("type") ?? "").toLowerCase();
  switch (type) {
    case "date":
    case "datetime-local":
    case "month":
    case "week":
    case "time":
      return "date-time-value";
    case "range":
      return "range-value";
    case "color":
      return "unsupported-value";
    case "hidden":
    case "submit":
    case "image":
    case "reset":
    case "button":
      return "default";
    case "checkbox":
    case "radio":
      return "default-on";
    case "file":
      return "filename";
    default:
      return "value";
  }
}

function isValueMode(mode: InputValueMode): boolean {
  return mode === "value" || mode === "date-time-value" || mode === "range-value" ||
    mode === "unsupported-value";
}

function decimalModulo(value: string, divisor: number): number {
  let remainder = 0;
  for (const digit of value) remainder = (remainder * 10 + Number(digit)) % divisor;
  return remainder;
}

function validYear(value: string): boolean {
  return value.length >= 4 && /^[0-9]+$/.test(value) && /[1-9]/.test(value);
}

function leapYear(value: string): boolean {
  return decimalModulo(value, 400) === 0 ||
    (decimalModulo(value, 4) === 0 && decimalModulo(value, 100) !== 0);
}

function validMonth(value: string): boolean {
  const match = /^([0-9]{4,})-([0-9]{2})$/.exec(value);
  if (match === null || !validYear(match[1])) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function validDate(value: string): boolean {
  const match = /^([0-9]{4,})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (match === null || !validYear(match[1])) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, leapYear(match[1]) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validWeek(value: string): boolean {
  const match = /^([0-9]{4,})-W([0-9]{2})$/.exec(value);
  if (match === null || !validYear(match[1])) return false;
  const cycleYear = decimalModulo(match[1], 400) || 400;
  const previous = cycleYear - 1;
  const januaryFirst = (cycleYear + Math.floor(previous / 4) - Math.floor(previous / 100) +
    Math.floor(previous / 400)) % 7;
  const maximum = januaryFirst === 4 || (januaryFirst === 3 && leapYear(match[1])) ? 53 : 52;
  const week = Number(match[2]);
  return week >= 1 && week <= maximum;
}

function parsedTime(value: string): RegExpExecArray | null {
  const match = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?$/.exec(value);
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  if (match[3] !== undefined && Number(match[3]) > 59) return null;
  return match;
}

function sanitizeDateTimeValue(control: ControlState, value: string): string {
  const type = (control.attributes.get("type") ?? "").toLowerCase();
  switch (type) {
    case "date":
      return validDate(value) ? value : "";
    case "month":
      return validMonth(value) ? value : "";
    case "week":
      return validWeek(value) ? value : "";
    case "time":
      return parsedTime(value) === null ? "" : value;
    case "datetime-local": {
      const match = /^(.+)[T ](.+)$/.exec(value);
      if (match === null || !validDate(match[1])) return "";
      const time = parsedTime(match[2]);
      if (time === null) return "";
      let normalizedTime = `${time[1]}:${time[2]}`;
      const fraction = (time[4] ?? "").replace(/0+$/, "");
      if (Number(time[3] ?? "0") !== 0 || fraction !== "") {
        normalizedTime += `:${time[3] ?? "00"}`;
        if (fraction !== "") normalizedTime += `.${fraction}`;
      }
      return `${match[1]}T${normalizedTime}`;
    }
    default:
      return value;
  }
}

interface ParsedHtmlFloat {
  readonly value: number;
  readonly decimalPlaces: number;
}

interface RangeConfig {
  readonly minimum: number;
  readonly maximum: number;
  readonly midpointDecimalPlaces: number | null;
  readonly step: number | null;
  readonly stepBase: number;
  readonly snappedDecimalPlaces: number | null;
}

function parseHtmlFloatingPoint(value: string): ParsedHtmlFloat | null {
  const match = /^[\t\n\f\r ]*[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?/.exec(
    value,
  );
  if (match === null) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;

  const token = match[0].trim().replace(/^[+-]/, "");
  const [significand, rawExponent] = token.toLowerCase().split("e");
  const fractionDigits = significand.includes(".") ? significand.length - significand.indexOf(".") - 1 : 0;
  const exponent = rawExponent === undefined ? 0 : Number(rawExponent);
  const decimalPlaces = Number.isSafeInteger(exponent) ? Math.max(0, Math.min(101, fractionDigits - exponent)) : 101;
  return { value: parsed === 0 ? 0 : parsed, decimalPlaces };
}

function parseValidFloatingPoint(value: string): number | null {
  if (!/^-?(?:(?:[0-9]+(?:\.[0-9]+)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed === 0 ? 0 : parsed) : null;
}

function rangeConfig(control: ControlState): RangeConfig {
  const parsedMinimum = control.attributes.has("min") ? parseHtmlFloatingPoint(control.attributes.get("min")!) : null;
  const parsedMaximum = control.attributes.has("max") ? parseHtmlFloatingPoint(control.attributes.get("max")!) : null;
  const parsedDefault = control.attributes.has("value")
    ? parseHtmlFloatingPoint(control.attributes.get("value")!)
    : null;
  const stepAttribute = control.attributes.get("step");
  const parsedStep = stepAttribute === undefined ? null : parseHtmlFloatingPoint(stepAttribute);
  const step = stepAttribute?.toLowerCase() === "any"
    ? null
    : parsedStep !== null && parsedStep.value > 0
    ? parsedStep.value
    : 1;
  const stepBase = parsedMinimum ?? parsedDefault ?? { value: 0, decimalPlaces: 0 };
  const maximumPlaces = (...places: Array<number | undefined>): number | null => {
    const present = places.filter((place): place is number => place !== undefined);
    return present.length === 0 ? null : Math.max(...present);
  };
  const midpointPlaces = maximumPlaces(parsedMinimum?.decimalPlaces, parsedMaximum?.decimalPlaces);

  return {
    minimum: parsedMinimum?.value ?? 0,
    maximum: parsedMaximum?.value ?? 100,
    midpointDecimalPlaces: midpointPlaces === null ? null : midpointPlaces + 1,
    step,
    stepBase: stepBase.value,
    snappedDecimalPlaces: step === null ? null : maximumPlaces(stepBase.decimalPlaces, parsedStep?.decimalPlaces),
  };
}

function canonicalizeDecimal(value: number, decimalPlaces: number | null): number {
  if (decimalPlaces === null || decimalPlaces < 0 || decimalPlaces > 100) return value;
  return Number(value.toFixed(decimalPlaces));
}

function nearlyEqual(left: number, right: number): boolean {
  if (left === right) return true;
  return Math.abs(left - right) <= 2 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
}

function nearestRangeValue(number: number, config: RangeConfig): number | null {
  const step = config.step;
  if (step === null) return null;
  const directSteps = (number - config.stepBase) / step;
  const steps = Number.isFinite(directSteps) ? directSteps : number / step - config.stepBase / step;
  if (!Number.isFinite(steps)) return null;
  const candidate = (index: number): number | null => {
    const direct = index * step + config.stepBase;
    const value = canonicalizeDecimal(
      Number.isFinite(direct) ? direct : (index + config.stepBase / step) * step,
      config.snappedDecimalPlaces,
    );
    return Number.isFinite(value) && value >= config.minimum &&
        (config.maximum < config.minimum || value <= config.maximum)
      ? value
      : null;
  };
  const lower = candidate(Math.floor(steps));
  const upper = candidate(Math.ceil(steps));
  if (number === lower || number === upper) return null;
  if (lower === null) return upper;
  if (upper === null) return lower;
  const lowerDistance = Math.abs(number - lower);
  const upperDistance = Math.abs(upper - number);
  return upperDistance < lowerDistance || nearlyEqual(upperDistance, lowerDistance) ? upper : lower;
}

function sanitizeRangeValue(control: ControlState, value: string): string {
  const config = rangeConfig(control);
  const parsed = parseValidFloatingPoint(value);
  let number = parsed;
  let serialize = number === null;
  if (number === null) {
    number = config.maximum < config.minimum ? config.minimum : canonicalizeDecimal(
      Number.isFinite(config.maximum - config.minimum)
        ? config.minimum + (config.maximum - config.minimum) / 2
        : config.minimum / 2 + config.maximum / 2,
      config.midpointDecimalPlaces,
    );
  }
  if (number < config.minimum) {
    number = config.minimum;
    serialize = true;
  }
  if (config.maximum >= config.minimum && number > config.maximum) {
    number = config.maximum;
    serialize = true;
  }
  const snapped = nearestRangeValue(number, config);
  if (snapped !== null) {
    number = snapped;
    serialize = true;
  }
  return serialize ? String(canonicalizeDecimal(number, config.snappedDecimalPlaces) || 0) : value;
}

function sanitizeControlValue(control: ControlState, value: string): string {
  return inputValueMode(control) === "range-value"
    ? sanitizeRangeValue(control, value)
    : sanitizeDateTimeValue(control, value);
}

function supportsSelectionRange(control: ControlState): boolean {
  if (control.tagName === "textarea") return true;
  if (control.tagName !== "input") return false;
  const type = (control.attributes.get("type") ?? "").toLowerCase();
  return ![
    "hidden",
    "email",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
    "number",
    "range",
    "color",
    "checkbox",
    "radio",
    "file",
    "submit",
    "image",
    "reset",
    "button",
  ].includes(type);
}

function hasSelectableText(control: ControlState): boolean {
  if (supportsSelectionRange(control)) return true;
  if (control.tagName !== "input") return false;
  return ["email", "number"].includes((control.attributes.get("type") ?? "").toLowerCase());
}

class FakeLiveControlRenderer {
  readonly #controls = new Map<number, ControlState>();
  readonly #pending = new Map<number, unknown>();
  #nextHandle = 1;
  #nextFrame = 1;
  nativeValue = "";

  title(): string {
    return "";
  }

  create_element(tagName: string): number {
    const handle = this.#nextHandle++;
    this.#controls.set(handle, {
      tagName: tagName.toLowerCase(),
      attributes: new Map(),
      defaultText: "",
      value: "",
      dirty: false,
      checked: false,
      dirtyCheckedness: false,
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: 0,
    });
    return handle;
  }

  element_interface(nodeHandle: number): number {
    switch (this.#control(nodeHandle).tagName) {
      case "input":
        return 1;
      case "textarea":
        return 2;
      default:
        return 0;
    }
  }

  node_kind(_nodeHandle: number): number {
    return 1;
  }

  form_control_value(nodeHandle: number): string {
    const control = this.#control(nodeHandle);
    if (control.tagName === "textarea") return control.value;
    if (control.tagName !== "input") throw new TypeError("fake node is not a form control");
    switch (inputValueMode(control)) {
      case "value":
      case "date-time-value":
      case "range-value":
        return control.value;
      case "default":
        return control.attributes.get("value") ?? "";
      case "default-on":
        return control.attributes.get("value") ?? "on";
      case "unsupported-value":
      case "filename":
        throw new TypeError("fake input value mode is intentionally unsupported");
    }
  }

  set_form_control_value(nodeHandle: number, value: string): boolean {
    const control = this.#control(nodeHandle);
    if (control.tagName === "input") {
      switch (inputValueMode(control)) {
        case "default":
        case "default-on": {
          if (control.attributes.get("value") === value && control.attributes.has("value")) {
            return false;
          }
          control.attributes.set("value", value);
          return true;
        }
        case "unsupported-value":
        case "filename":
          throw new TypeError("fake input value mode is intentionally unsupported");
        case "date-time-value":
        case "range-value":
        case "value":
          break;
      }
    }
    value = sanitizeControlValue(control, value);
    const changed = control.value !== value;
    control.value = value;
    control.dirty = true;
    if (changed) {
      control.selectionStart = value.length;
      control.selectionEnd = value.length;
      control.selectionDirection = 0;
    }
    return changed;
  }

  form_control_checked(nodeHandle: number): boolean {
    const control = this.#control(nodeHandle);
    if (control.tagName !== "input") throw new TypeError("fake node is not an input");
    return control.checked;
  }

  set_form_control_checked(nodeHandle: number, checked: boolean): boolean {
    const control = this.#control(nodeHandle);
    if (control.tagName !== "input") throw new TypeError("fake node is not an input");
    const changed = control.checked !== checked;
    control.checked = checked;
    control.dirtyCheckedness = true;
    const type = (control.attributes.get("type") ?? "").toLowerCase();
    return changed && (type === "checkbox" || type === "radio");
  }

  form_control_selection(nodeHandle: number): Uint32Array | undefined {
    const control = this.#control(nodeHandle);
    if (!supportsSelectionRange(control)) return undefined;
    return new Uint32Array([
      control.selectionStart,
      control.selectionEnd,
      control.selectionDirection,
    ]);
  }

  set_form_control_selection(
    nodeHandle: number,
    start: number,
    end: number,
    direction: number,
  ): boolean | undefined {
    const control = this.#control(nodeHandle);
    if (!supportsSelectionRange(control)) return undefined;
    const valueLength = control.value.length;
    start = Math.min(start, valueLength);
    end = Math.min(end, valueLength);
    if (end <= start) start = end;
    const changed = control.selectionStart !== start || control.selectionEnd !== end ||
      control.selectionDirection !== direction;
    control.selectionStart = start;
    control.selectionEnd = end;
    control.selectionDirection = direction as 0 | 1 | 2;
    return changed;
  }

  select_form_control_text(nodeHandle: number): boolean {
    const control = this.#control(nodeHandle);
    if (!hasSelectableText(control)) return false;
    const changed = control.selectionStart !== 0 || control.selectionEnd !== control.value.length ||
      control.selectionDirection !== 0;
    control.selectionStart = 0;
    control.selectionEnd = control.value.length;
    control.selectionDirection = 0;
    return changed;
  }

  selectionForTest(nodeHandle: number): readonly [number, number, number] {
    const control = this.#control(nodeHandle);
    return [control.selectionStart, control.selectionEnd, control.selectionDirection];
  }

  get_attribute(nodeHandle: number, name: string): string | undefined {
    return this.#control(nodeHandle).attributes.get(name.toLowerCase());
  }

  set_attribute(nodeHandle: number, name: string, value: string): void {
    const control = this.#control(nodeHandle);
    name = name.toLowerCase();
    const previousMode = control.tagName === "input" && name === "type" ? inputValueMode(control) : undefined;
    const previouslySelectable = supportsSelectionRange(control);
    const hadChecked = control.attributes.has("checked");
    control.attributes.set(name, value);
    if (previousMode !== undefined) {
      this.#applyTypeTransition(control, previousMode);
    } else if (
      control.tagName === "input" && name === "value" &&
      isValueMode(inputValueMode(control)) && !control.dirty
    ) {
      control.value = sanitizeControlValue(control, value);
    } else if (
      inputValueMode(control) === "range-value" && ["min", "max", "step"].includes(name)
    ) {
      control.value = sanitizeRangeValue(control, control.value);
    }
    if (
      control.tagName === "input" && name === "checked" && !hadChecked &&
      !control.dirtyCheckedness
    ) {
      control.checked = true;
    }
    if (!previouslySelectable && supportsSelectionRange(control)) {
      control.selectionStart = 0;
      control.selectionEnd = 0;
      control.selectionDirection = 0;
    }
  }

  remove_attribute(nodeHandle: number, name: string): void {
    const control = this.#control(nodeHandle);
    name = name.toLowerCase();
    const previousMode = control.tagName === "input" && name === "type" ? inputValueMode(control) : undefined;
    const previouslySelectable = supportsSelectionRange(control);
    const hadAttribute = control.attributes.has(name);
    const hadChecked = control.attributes.has("checked");
    control.attributes.delete(name);
    if (previousMode !== undefined) {
      this.#applyTypeTransition(control, previousMode);
    } else if (
      control.tagName === "input" && name === "value" &&
      isValueMode(inputValueMode(control)) && !control.dirty
    ) {
      control.value = sanitizeControlValue(control, "");
    } else if (
      hadAttribute &&
      inputValueMode(control) === "range-value" && ["min", "max", "step"].includes(name)
    ) {
      control.value = sanitizeRangeValue(control, control.value);
    }
    if (
      control.tagName === "input" && name === "checked" && hadChecked &&
      !control.dirtyCheckedness
    ) {
      control.checked = false;
    }
    if (!previouslySelectable && supportsSelectionRange(control)) {
      control.selectionStart = 0;
      control.selectionEnd = 0;
      control.selectionDirection = 0;
    }
  }

  text_content(nodeHandle: number): string {
    return this.#control(nodeHandle).defaultText;
  }

  set_text_content(nodeHandle: number, value: string): Uint32Array {
    const control = this.#control(nodeHandle);
    control.defaultText = value;
    if (control.tagName === "textarea" && !control.dirty) control.value = value;
    return new Uint32Array();
  }

  begin_key_event(): unknown {
    const input = [...this.#controls.entries()].find(([, control]) => control.tagName === "input");
    if (input === undefined) throw new Error("fake native edit needs an input");
    input[1].value = this.nativeValue;
    input[1].dirty = true;
    const frameId = this.#nextFrame++;
    this.#pending.set(frameId, {
      kind: "complete",
      frameId,
      redrawRequested: true,
    });
    return {
      kind: "event",
      frameId,
      eventId: 1,
      type: "input",
      target: input[0],
      path: [input[0]],
      bubbles: true,
      cancelable: false,
      composed: true,
      timeStamp: 1,
      payload: { data: "x", inputType: "insertText", isComposing: false },
    };
  }

  begin_focus(): unknown {
    return {
      kind: "complete",
      frameId: this.#nextFrame++,
      redrawRequested: false,
    };
  }

  begin_blur(): unknown {
    return {
      kind: "complete",
      frameId: this.#nextFrame++,
      redrawRequested: false,
    };
  }

  resume_dom_dispatch(frameId: number): unknown {
    const step = this.#pending.get(frameId);
    if (step === undefined) throw new Error("fake dispatch frame is not pending");
    this.#pending.delete(frameId);
    return step;
  }

  abort_dom_dispatch(frameId: number): boolean {
    this.#pending.delete(frameId);
    return false;
  }

  #applyTypeTransition(control: ControlState, previousMode: InputValueMode): void {
    const nextMode = inputValueMode(control);
    if (
      isValueMode(previousMode) && !isValueMode(nextMode) && nextMode !== "filename" &&
      control.value !== ""
    ) {
      control.attributes.set("value", control.value);
    } else if (!isValueMode(previousMode) && isValueMode(nextMode)) {
      control.value = control.attributes.get("value") ?? "";
      control.dirty = false;
    } else if (previousMode !== "filename" && nextMode === "filename") {
      control.value = "";
    }
    if (isValueMode(nextMode)) control.value = sanitizeControlValue(control, control.value);
  }

  #control(nodeHandle: number): ControlState {
    const control = this.#controls.get(nodeHandle);
    if (control === undefined) throw new RangeError(`unknown fake control ${nodeHandle}`);
    return control;
  }
}

function createDocument(): {
  readonly document: QuoxDocument;
  readonly renderer: FakeLiveControlRenderer;
  readonly renders: { count: number };
} {
  const renderer = new FakeLiveControlRenderer();
  const renders = { count: 0 };
  return {
    document: new QuoxDocument(
      renderer as unknown as WasmRenderer,
      () => renders.count++,
      () => undefined,
    ),
    renderer,
    renders,
  };
}

Deno.test("document creates tag-specific input and textarea wrappers", () => {
  const { document } = createDocument();
  const input: QuoxInputElement = document.createElement("input");
  const textarea: QuoxTextAreaElement = document.createElement("textarea");

  assertInstanceOf(input, QuoxInputElement);
  assertInstanceOf(textarea, QuoxTextAreaElement);
  assertStrictEquals(document.createElement("INPUT").constructor, QuoxInputElement);
});

Deno.test("defaultValue follows the live value only until it becomes dirty", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");

  input.defaultValue = "input default";
  textarea.defaultValue = "textarea default";
  assertEquals(input.value, "input default");
  assertEquals(textarea.value, "textarea default");

  input.value = "input live";
  textarea.value = "textarea live";
  input.defaultValue = "new input default";
  textarea.defaultValue = "new textarea default";

  assertEquals(input.defaultValue, "new input default");
  assertEquals(textarea.defaultValue, "new textarea default");
  assertEquals(input.value, "input live");
  assertEquals(textarea.value, "textarea live");
});

Deno.test("value setters use Web IDL string conversion, repair surrogates, and emit no event", () => {
  const { document, renders } = createDocument();
  const input = document.createElement("input");
  let inputEvents = 0;
  input.addEventListener("input", () => inputEvents++);
  let conversions = 0;

  (input as unknown as { value: unknown }).value = {
    toString() {
      conversions += 1;
      return "a\ud800b";
    },
  };

  assertEquals(input.value, "a\ufffdb");
  assertEquals(conversions, 1);
  assertEquals(inputEvents, 0);
  assertEquals(renders.count, 1);

  input.value = "a\ufffdb";
  assertEquals(renders.count, 1, "assigning the same value should not request paint");
  assertThrows(
    () => ((input as unknown as { value: unknown }).value = Symbol("value")),
    TypeError,
    "Web IDL string",
  );

  (input as unknown as { value: unknown }).value = null;
  assertEquals(input.value, "", "value uses LegacyNullToEmptyString");
  (input as unknown as { defaultValue: unknown }).defaultValue = null;
  assertEquals(input.defaultValue, "null", "defaultValue remains an ordinary DOMString");

  const textarea = document.createElement("textarea");
  (textarea as unknown as { value: unknown }).value = null;
  assertEquals(textarea.value, "");
  (textarea as unknown as { defaultValue: unknown }).defaultValue = null;
  assertEquals(textarea.defaultValue, "null");
});

Deno.test("default input value modes reflect the value content attribute", () => {
  for (const type of ["hidden", "submit", "image", "reset", "button"]) {
    const { document, renders } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    let inputEvents = 0;
    let changeEvents = 0;
    input.addEventListener("input", () => inputEvents++);
    input.addEventListener("change", () => changeEvents++);
    const setupRenders = renders.count;

    assertEquals(input.value, "", `${type} has an empty missing-attribute fallback`);
    assertEquals(input.getAttribute("value"), null);

    input.value = "";
    assertEquals(input.value, "");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(renders.count, setupRenders + 1, "creating an empty attribute must repaint");

    input.value = "";
    assertEquals(renders.count, setupRenders + 1, "an identical present attribute is unchanged");

    input.value = "button label";
    assertEquals(input.value, "button label");
    assertEquals(input.defaultValue, "button label");
    assertEquals(renders.count, setupRenders + 2);

    input.removeAttribute("value");
    assertEquals(input.value, "");
    assertEquals(input.getAttribute("value"), null);
    assertEquals(inputEvents, 0);
    assertEquals(changeEvents, 0);
  }
});

Deno.test("checkbox and radio value modes use on only for a missing attribute", () => {
  for (const type of ["checkbox", "radio"]) {
    const { document, renders } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    let inputEvents = 0;
    let changeEvents = 0;
    input.addEventListener("input", () => inputEvents++);
    input.addEventListener("change", () => changeEvents++);
    const setupRenders = renders.count;

    assertEquals(input.value, "on");
    assertEquals(input.defaultValue, "");
    assertEquals(input.getAttribute("value"), null);

    input.value = "on";
    assertEquals(input.value, "on");
    assertEquals(input.getAttribute("value"), "on");
    assertEquals(renders.count, setupRenders + 1, "creating the fallback text as an attribute repaints");

    input.value = "on";
    assertEquals(renders.count, setupRenders + 1);

    input.value = "";
    assertEquals(input.value, "", "a present empty attribute does not use the on fallback");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(renders.count, setupRenders + 2);

    input.removeAttribute("value");
    assertEquals(input.value, "on");
    (input as unknown as { value: unknown }).value = null;
    assertEquals(input.value, "", "LegacyNullToEmptyString creates an empty attribute");
    assertEquals(input.getAttribute("value"), "");
    assertEquals(inputEvents, 0);
    assertEquals(changeEvents, 0);
  }
});

Deno.test("checked and defaultChecked keep browser dirty-checkedness semantics", () => {
  const { document, renders } = createDocument();
  const input = document.createElement("input");
  input.setAttribute("type", "checkbox");
  const setupRenders = renders.count;
  let inputs = 0;
  let changes = 0;
  input.addEventListener("input", () => inputs++);
  input.addEventListener("change", () => changes++);

  assertEquals(input.checked, false);
  assertEquals(input.defaultChecked, false);
  input.defaultChecked = true;
  assertEquals(input.getAttribute("checked"), "");
  assertEquals(input.defaultChecked, true);
  assertEquals(input.checked, true, "a clean current value follows attribute presence");
  assertEquals(renders.count, setupRenders + 1);

  input.defaultChecked = true;
  assertEquals(renders.count, setupRenders + 1, "an identical boolean reflection is inert");
  input.checked = false;
  assertEquals(input.checked, false);
  assertEquals(input.defaultChecked, true);
  assertEquals(renders.count, setupRenders + 2);

  input.checked = false;
  assertEquals(renders.count, setupRenders + 2, "identical checked assignment does not repaint");
  input.defaultChecked = false;
  input.defaultChecked = true;
  assertEquals(input.checked, false, "attribute changes stop following after any script assignment");
  assertEquals(input.defaultChecked, true);
  assertEquals(inputs, 0);
  assertEquals(changes, 0);
});

Deno.test("checked uses Web IDL boolean conversion and survives non-checkable input types", () => {
  const { document, renders } = createDocument();
  const input = document.createElement("input");

  (input as unknown as { checked: unknown }).checked = { valueOf: () => 0 };
  assertEquals(input.checked, true, "Boolean conversion does not invoke object coercion hooks");
  assertEquals(renders.count, 0, "checkedness on the Text state has no rendered effect");

  input.setAttribute("type", "radio");
  assertEquals(input.checked, true, "type changes retain the current checkedness");
  const afterType = renders.count;
  (input as unknown as { checked: unknown }).checked = 0;
  assertEquals(input.checked, false);
  assertEquals(renders.count, afterType + 1);
  (input as unknown as { checked: unknown }).checked = Symbol("truthy");
  assertEquals(input.checked, true);
  assertEquals(renders.count, afterType + 2);

  const clean = document.createElement("input");
  (clean as unknown as { defaultChecked: unknown }).defaultChecked = "false";
  assertEquals(clean.defaultChecked, true, "nonempty strings convert to true");
  assertEquals(clean.checked, true);
  (clean as unknown as { defaultChecked: unknown }).defaultChecked = 0n;
  assertEquals(clean.defaultChecked, false);
  assertEquals(clean.checked, false);
});

Deno.test("input type changes transfer values between value and attribute modes", () => {
  const { document } = createDocument();

  for (const type of ["checkbox", "hidden"]) {
    const dirty = document.createElement("input");
    dirty.defaultValue = "old default";
    dirty.value = "live value";
    dirty.setAttribute("type", type);
    assertEquals(dirty.value, "live value");
    assertEquals(dirty.getAttribute("value"), "live value");

    dirty.setAttribute("type", "text");
    assertEquals(dirty.value, "live value");
    dirty.defaultValue = "new default";
    assertEquals(dirty.value, "new default", "returning to value mode resets the dirty flag");

    const empty = document.createElement("input");
    empty.defaultValue = "old default";
    empty.value = "";
    empty.setAttribute("type", type);
    assertEquals(empty.value, "old default", "an empty live value does not overwrite the old attribute");
  }

  const checkbox = document.createElement("input");
  checkbox.setAttribute("type", "checkbox");
  assertEquals(checkbox.value, "on");
  checkbox.setAttribute("type", "text");
  assertEquals(checkbox.value, "", "the default-on fallback is not copied into value mode");

  const assignedCheckbox = document.createElement("input");
  assignedCheckbox.setAttribute("type", "checkbox");
  assignedCheckbox.value = "choice";
  assignedCheckbox.setAttribute("type", "text");
  assertEquals(assignedCheckbox.value, "choice");
  assignedCheckbox.defaultValue = "replacement default";
  assertEquals(assignedCheckbox.value, "replacement default");

  const fallback = document.createElement("input");
  fallback.setAttribute("type", "hidden");
  assertEquals(fallback.value, "");
  fallback.setAttribute("type", "radio");
  assertEquals(fallback.value, "on");
  fallback.setAttribute("type", "hidden");
  assertEquals(fallback.value, "");
  assertEquals(fallback.getAttribute("value"), null);
});

Deno.test("date and time input values apply browser sanitizers", () => {
  const cases = [
    ["date", "2024-02-29", "2024-02-29"],
    ["date", "2023-02-29", ""],
    ["month", "2024-12", "2024-12"],
    ["month", "2024-13", ""],
    ["week", "2020-W53", "2020-W53"],
    ["week", "2021-W53", ""],
    ["time", "23:59", "23:59"],
    ["time", "12:34:00.000", "12:34:00.000"],
    ["time", "24:00", ""],
    ["datetime-local", "2024-02-29 12:34:00.000", "2024-02-29T12:34"],
    ["datetime-local", "2024-02-29T12:34:56.120", "2024-02-29T12:34:56.12"],
    ["datetime-local", "2024-02-29T12:34Z", ""],
  ] as const;

  for (const [type, value, expected] of cases) {
    const { document } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    input.value = value;
    assertEquals(input.value, expected, `type=${type} value=${value}`);
    assertEquals(input.getAttribute("value"), null, "the live setter does not rewrite the default");
  }
});

Deno.test("date defaults stop following after an identical live assignment", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  input.setAttribute("type", "date");
  let inputs = 0;
  let changes = 0;
  input.addEventListener("input", () => inputs++);
  input.addEventListener("change", () => changes++);

  input.defaultValue = "not-a-date";
  assertEquals(input.defaultValue, "not-a-date");
  assertEquals(input.value, "");
  input.defaultValue = "2024-02-29";
  assertEquals(input.value, "2024-02-29");
  input.value = "2024-02-29";
  input.defaultValue = "2025-03-01";
  assertEquals(input.defaultValue, "2025-03-01");
  assertEquals(input.value, "2024-02-29");
  assertEquals(inputs, 0);
  assertEquals(changes, 0);
});

Deno.test("date values use Web IDL string conversion", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  input.setAttribute("type", "date");
  input.value = "2024-02-29";

  (input as unknown as { value: unknown }).value = null;
  assertEquals(input.value, "");
  assertThrows(
    () => {
      (input as unknown as { value: unknown }).value = Symbol("date");
    },
    TypeError,
  );
  assertEquals(input.value, "", "failed conversion does not reach the renderer");
});

Deno.test("range values apply browser defaults, bounds, steps, and number serialization", () => {
  const cases = [
    [{}, "50"],
    [{ min: "0.1", max: "0.2", step: "any" }, "0.15"],
    [{ min: "10", max: "20", value: "bad" }, "15"],
    [{ min: "20", max: "10", value: "bad" }, "20"],
    [{ min: "0", max: "100", step: "20", value: "50" }, "60"],
    [{ min: "-100", max: "100", step: "20", value: "-50" }, "-40"],
    [{ min: "0", max: ".3", step: ".1", value: ".29" }, "0.3"],
    [{ min: "0", max: "1", step: "1e-20", value: "5e-21" }, "1e-20"],
    [{ min: "0", max: "1", step: "1e-20", value: "1e-24" }, "0"],
    [{ min: "0", max: "1", step: "1e-7", value: "1.5e-7" }, "2e-7"],
    [{ min: "0", max: "1e22", step: "1e21", value: "5e20" }, "1e+21"],
    [{ min: "-1e308", max: "1e308", step: "1e308", value: "9e307" }, "1e+308"],
    [{ min: "-1", max: "0", step: "1", value: "-1e-24" }, "0"],
    [{ min: "  +10junk", max: "20junk", step: "2junk", value: "+12" }, "16"],
  ] as const;

  for (const [attributes, expected] of cases) {
    const { document } = createDocument();
    const input = document.createElement("input");
    for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value);
    input.setAttribute("type", "range");
    assertEquals(input.value, expected, JSON.stringify(attributes));
    assertEquals(
      input.defaultValue,
      (attributes as Readonly<Record<string, string>>).value ?? "",
      "sanitization does not rewrite the raw default",
    );
  }

  const { document } = createDocument();
  const input = document.createElement("input");
  input.setAttribute("min", "10");
  input.setAttribute("max", "20");
  input.setAttribute("step", "any");
  input.setAttribute("type", "range");
  let inputs = 0;
  let changes = 0;
  input.addEventListener("input", () => inputs++);
  input.addEventListener("change", () => changes++);

  input.value = ".5";
  assertEquals(input.value, "10", "underflow clamps to the minimum");
  (input as unknown as { value: unknown }).value = null;
  assertEquals(input.value, "15", "LegacyNullToEmptyString selects the range midpoint");
  assertThrows(
    () => {
      (input as unknown as { value: unknown }).value = Symbol("range");
    },
    TypeError,
  );
  assertEquals(input.value, "15", "failed conversion does not reach the renderer");
  assertEquals(inputs, 0);
  assertEquals(changes, 0);
});

Deno.test("range defaults, constraints, and type transitions retain browser value bookkeeping", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  input.defaultValue = "25";
  input.setAttribute("min", "0");
  input.setAttribute("max", "100");
  input.setAttribute("step", "1");
  input.setAttribute("type", "range");

  input.defaultValue = "40";
  assertEquals(input.value, "40");
  input.value = "40";
  input.defaultValue = "60";
  assertEquals(input.value, "40", "an identical assignment still makes the live value dirty");
  input.setAttribute("min", "45");
  assertEquals(input.value, "45");
  input.setAttribute("step", "10");
  input.value = "59";
  assertEquals(input.value, "55");
  input.setAttribute("max", "52");
  assertEquals(input.value, "45");
  assertEquals(input.defaultValue, "60");

  const rawBase = document.createElement("input");
  rawBase.defaultValue = "3";
  rawBase.setAttribute("max", "100");
  rawBase.setAttribute("step", "10");
  rawBase.setAttribute("type", "range");
  rawBase.value = "14";
  assertEquals(rawBase.value, "13");
  rawBase.defaultValue = "7";
  assertEquals(rawBase.value, "13", "a dirty raw default does not immediately re-sanitize");
  rawBase.removeAttribute("min");
  assertEquals(rawBase.value, "13", "removing an absent constraint is a no-op");
  rawBase.setAttribute("step", "10");
  assertEquals(rawBase.value, "17", "repeating a constraint uses the new raw-value step base");
  rawBase.setAttribute("step", "8");
  assertEquals(rawBase.value, "15", "a constraint change uses the current raw-value step base");

  const removedMin = document.createElement("input");
  removedMin.defaultValue = "15";
  removedMin.setAttribute("min", "10");
  removedMin.setAttribute("max", "20");
  removedMin.setAttribute("step", "4");
  removedMin.setAttribute("type", "range");
  assertEquals(removedMin.value, "14");
  removedMin.removeAttribute("min");
  assertEquals(removedMin.value, "15");

  const editor = document.createElement("input");
  editor.value = "61";
  editor.setAttribute("min", "0");
  editor.setAttribute("max", "100");
  editor.setAttribute("step", "20");
  editor.setAttribute("type", "range");
  assertEquals(editor.value, "60");
  assertEquals(editor.selectionStart, null);
  editor.setAttribute("type", "text");
  assertEquals(editor.value, "60");
  assertEquals(editor.selectionStart, 0);

  const fromDefault = document.createElement("input");
  fromDefault.setAttribute("type", "checkbox");
  fromDefault.value = "30";
  fromDefault.setAttribute("min", "0");
  fromDefault.setAttribute("step", "20");
  fromDefault.setAttribute("type", "range");
  assertEquals(fromDefault.value, "40");

  input.value = "50";
  input.setAttribute("type", "checkbox");
  assertEquals(input.value, "45", "the constrained live value is copied into default-on mode");
  assertEquals(input.defaultValue, "45");
});

Deno.test("color and filename input values remain explicitly unsupported", () => {
  for (const type of ["color", "file"]) {
    const { document } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);

    assertThrows(() => input.value, TypeError, "intentionally unsupported");
    assertThrows(
      () => {
        input.value = "replacement";
      },
      TypeError,
      "intentionally unsupported",
    );
    assertEquals(input.getAttribute("value"), null);
  }
});

Deno.test("a native edit is visible before its first input listener", () => {
  const { document, renderer } = createDocument();
  const input = document.createElement("input");
  const seen: string[] = [];
  input.addEventListener("input", () => seen.push(input.value));
  renderer.nativeValue = "native edit";

  document.dispatchKey({
    type: "keydown",
    code: "KeyX",
    key: "x",
    keycode: 88,
    location: 0,
    repeat: false,
    isComposing: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });

  assertEquals(seen, ["native edit"]);
});

Deno.test("text-control range properties preserve direction and follow setter adjustment rules", () => {
  const { document, renders } = createDocument();
  const input = document.createElement("input");
  input.defaultValue = "abcdef";
  const events: string[] = [];
  for (const type of ["focus", "blur", "input", "change"]) {
    input.addEventListener(type, () => events.push(type));
  }
  const setupRenders = renders.count;

  assertEquals([input.selectionStart, input.selectionEnd, input.selectionDirection], [0, 0, "none"]);
  input.setSelectionRange(1, 4, "backward");
  assertEquals([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 4, "backward"]);
  assertEquals(renders.count, setupRenders + 1);

  input.setSelectionRange(1, 4, "backward");
  assertEquals(renders.count, setupRenders + 1, "an identical range does not repaint");

  input.selectionDirection = "none";
  assertEquals([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 4, "none"]);
  input.selectionStart = 5;
  assertEquals([input.selectionStart, input.selectionEnd], [5, 5], "raising start also raises end");
  input.selectionEnd = 2;
  assertEquals([input.selectionStart, input.selectionEnd], [2, 2], "end before start collapses at end");
  assertEquals(events, []);
});

Deno.test("selection applicability follows input state while select uses rendered editor text", () => {
  for (const type of ["", "text", "search", "tel", "url", "password", "wat"]) {
    const { document } = createDocument();
    const input = document.createElement("input");
    if (type !== "") input.setAttribute("type", type);
    assertEquals(input.selectionStart, 0, `${type || "missing"} supports ranges`);
    input.setSelectionRange(0, 0, "forward");
    assertEquals(input.selectionDirection, "forward");
  }

  for (
    const type of [
      "email",
      "number",
      "date",
      "datetime-local",
      "month",
      "week",
      "time",
      "range",
      "color",
      "checkbox",
      "radio",
      "file",
      "hidden",
      "submit",
      "image",
      "reset",
      "button",
    ]
  ) {
    const { document } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    assertEquals(input.selectionStart, null, `${type} does not expose range properties`);
    const propertyError = assertThrows(() => {
      input.selectionStart = 0;
    }, DOMException);
    assertEquals(propertyError.name, "InvalidStateError");
    const methodError = assertThrows(() => input.setSelectionRange(0, 0), DOMException);
    assertEquals(methodError.name, "InvalidStateError");
  }

  for (const type of ["email", "number"]) {
    const { document, renderer, renders } = createDocument();
    const input = document.createElement("input");
    input.setAttribute("type", type);
    input.value = "1234";
    const setupRenders = renders.count;
    input.select();
    assertEquals(renderer.selectionForTest(input.nodeId), [0, 4, 0]);
    assertEquals(renders.count, setupRenders + 1, `${type} renders selectable editor text`);
  }

  const { document, renders } = createDocument();
  const date = document.createElement("input");
  date.setAttribute("type", "date");
  const setupRenders = renders.count;
  date.select();
  assertEquals(renders.count, setupRenders, "a picker-backed unsupported mode ignores select");
});

Deno.test("selection arguments use Web IDL unsigned-long and DOMString conversions", () => {
  const { document } = createDocument();
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  input.defaultValue = "A🙂B";

  assertEquals(input.setSelectionRange.length, 2);
  assertEquals(textarea.setSelectionRange.length, 2);
  assertThrows(() => Reflect.apply(input.setSelectionRange, input, []), TypeError, "at least 2");
  assertThrows(() => Reflect.apply(input.setSelectionRange, input, [1]), TypeError, "at least 2");
  assertThrows(() => Reflect.apply(textarea.setSelectionRange, textarea, []), TypeError, "at least 2");

  const unsupported = document.createElement("input");
  unsupported.setAttribute("type", "email");
  assertThrows(
    () => Reflect.apply(unsupported.setSelectionRange, unsupported, []),
    TypeError,
    "at least 2",
  );

  input.setSelectionRange(1, 3, "forward");
  assertEquals([input.selectionStart, input.selectionEnd], [1, 3], "offsets count UTF-16 code units");
  input.setSelectionRange(-1, -1);
  assertEquals([input.selectionStart, input.selectionEnd], [4, 4], "negative values wrap then clamp");
  input.setSelectionRange(Number.NaN, Number.POSITIVE_INFINITY);
  assertEquals([input.selectionStart, input.selectionEnd], [0, 0]);
  input.setSelectionRange(1.9, 3.9, "backward");
  assertEquals([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 3, "backward"]);

  (input as unknown as { selectionStart: unknown }).selectionStart = null;
  assertEquals(input.selectionStart, 0);
  (input as unknown as { selectionDirection: unknown }).selectionDirection = "sideways";
  assertEquals(input.selectionDirection, "none");
  (input as unknown as { selectionDirection: unknown }).selectionDirection = null;
  assertEquals(input.selectionDirection, "none");
  assertThrows(
    () => ((input as unknown as { selectionStart: unknown }).selectionStart = 1n),
    TypeError,
  );
  assertThrows(
    () => input.setSelectionRange(0, 0, Symbol("direction") as unknown as "forward"),
    TypeError,
    "Web IDL string",
  );

  let conversions = 0;
  (input as unknown as { selectionDirection: unknown }).selectionDirection = {
    toString() {
      conversions += 1;
      return "forward";
    },
  };
  assertEquals(conversions, 1);
  assertEquals(input.selectionDirection, "forward");

  const conversionError = assertThrows(
    () => {
      (input as unknown as { selectionStart: unknown }).selectionStart = {
        valueOf() {
          input.setAttribute("type", "email");
          return 1;
        },
      };
    },
    DOMException,
  );
  assertEquals(conversionError.name, "InvalidStateError", "applicability is checked after conversion");
});

Deno.test("textarea selection and select work without focusing or dispatching editing events", () => {
  const { document, renders } = createDocument();
  const textarea = document.createElement("textarea");
  textarea.defaultValue = "A🙂B";
  const events: string[] = [];
  for (const type of ["focus", "blur", "input", "change"]) {
    textarea.addEventListener(type, () => events.push(type));
  }
  const setupRenders = renders.count;

  textarea.setSelectionRange(1, 3, "backward");
  assertEquals([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [1, 3, "backward"]);
  textarea.select();
  assertEquals([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [0, 4, "none"]);
  const rendered = renders.count;
  textarea.select();
  assertEquals(renders.count, rendered, "reselecting the same range does not repaint");
  assertEquals(renders.count, setupRenders + 2);
  assertEquals(events, []);
});
