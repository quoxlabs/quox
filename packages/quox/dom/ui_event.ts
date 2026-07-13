import { QuoxEvent, type QuoxEventInit } from "./event.ts";
import type { QuoxEventTarget } from "./event_target.ts";

export interface QuoxUIEventInit extends QuoxEventInit {
  view?: QuoxEventTarget | null;
  detail?: number;
  /** Legacy UI Events field retained because browsers still expose it. */
  which?: number;
}

export interface QuoxEventModifierInit extends QuoxUIEventInit {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  modifierAltGraph?: boolean;
  modifierCapsLock?: boolean;
  modifierFn?: boolean;
  modifierFnLock?: boolean;
  modifierHyper?: boolean;
  modifierNumLock?: boolean;
  modifierScrollLock?: boolean;
  modifierSuper?: boolean;
  modifierSymbol?: boolean;
  modifierSymbolLock?: boolean;
}

export interface QuoxMouseEventInit extends QuoxEventModifierInit {
  screenX?: number;
  screenY?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  buttons?: number;
  relatedTarget?: QuoxEventTarget | null;
  movementX?: number;
  movementY?: number;
}

export interface QuoxPointerEventInit extends QuoxMouseEventInit {
  pointerId?: number;
  width?: number;
  height?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  pointerType?: string;
  isPrimary?: boolean;
  persistentDeviceId?: number;
  coalescedEvents?: readonly QuoxPointerEvent[];
  predictedEvents?: readonly QuoxPointerEvent[];
}

export interface QuoxWheelEventInit extends QuoxMouseEventInit {
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
}

export interface QuoxKeyboardEventInit extends QuoxEventModifierInit {
  key?: string;
  code?: string;
  location?: number;
  repeat?: boolean;
  isComposing?: boolean;
  charCode?: number;
  keyCode?: number;
}

export interface QuoxClipboardEventInit extends QuoxEventInit {
  clipboardData?: QuoxDataTransfer | null;
}

export interface QuoxInputEventInit extends QuoxUIEventInit {
  data?: string | null;
  isComposing?: boolean;
  inputType?: string;
  dataTransfer?: unknown | null;
  targetRanges?: readonly unknown[];
}

export interface QuoxFocusEventInit extends QuoxUIEventInit {
  relatedTarget?: QuoxEventTarget | null;
}

export interface QuoxCompositionEventInit extends QuoxUIEventInit {
  data?: string;
}

const MODIFIER_INITIALIZERS = Object.freeze(
  [
    ["Alt", "altKey"],
    ["AltGraph", "modifierAltGraph"],
    ["CapsLock", "modifierCapsLock"],
    ["Control", "ctrlKey"],
    ["Fn", "modifierFn"],
    ["FnLock", "modifierFnLock"],
    ["Hyper", "modifierHyper"],
    ["Meta", "metaKey"],
    ["NumLock", "modifierNumLock"],
    ["ScrollLock", "modifierScrollLock"],
    ["Shift", "shiftKey"],
    ["Super", "modifierSuper"],
    ["Symbol", "modifierSymbol"],
    ["SymbolLock", "modifierSymbolLock"],
  ] as const,
);

const trustedMouseCoordinates = Symbol("Quox trusted mouse coordinates");

interface TrustedMouseCoordinates {
  readonly pageX: number;
  readonly pageY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

type TrustedMouseEventInit = QuoxMouseEventInit & {
  readonly [trustedMouseCoordinates]?: TrustedMouseCoordinates;
};

function numberValue(value: unknown, fallback: number): number {
  const input = value === undefined ? fallback : value;
  if (typeof input === "bigint" || typeof input === "symbol") {
    throw new TypeError("a Web IDL number cannot be a bigint or symbol");
  }
  return Number(input);
}

function finiteNumber(value: unknown, fallback: number, name: string): number {
  const number = numberValue(value, fallback);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function finiteFloat(value: unknown, fallback: number, name: string): number {
  const number = Math.fround(finiteNumber(value, fallback, name));
  if (!Number.isFinite(number)) throw new TypeError(`${name} exceeds float range`);
  return number;
}

function toInt32(value: unknown, fallback = 0): number {
  return numberValue(value, fallback) | 0;
}

function toUint32(value: unknown, fallback = 0): number {
  return numberValue(value, fallback) >>> 0;
}

function toInt16(value: unknown, fallback = 0): number {
  const unsigned = (numberValue(value, fallback) >>> 0) & 0xffff;
  return unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
}

function toUint16(value: unknown, fallback = 0): number {
  return (numberValue(value, fallback) >>> 0) & 0xffff;
}

function domString(value: unknown, fallback: string): string {
  const input = value === undefined ? fallback : value;
  if (typeof input === "symbol") throw new TypeError("a Web IDL string cannot be a symbol");
  return String(input);
}

function toUSVString(value: unknown): string {
  const source = domString(value, "");
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

interface PointerOrientation {
  readonly tiltX: number;
  readonly tiltY: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;
}

function tiltToSpherical(tiltX: number, tiltY: number): Pick<PointerOrientation, "altitudeAngle" | "azimuthAngle"> {
  const tiltXRadians = tiltX * Math.PI / 180;
  const tiltYRadians = tiltY * Math.PI / 180;

  let azimuthAngle = 0;
  if (tiltX === 0) {
    if (tiltY > 0) azimuthAngle = Math.PI / 2;
    else if (tiltY < 0) azimuthAngle = 3 * Math.PI / 2;
  } else if (tiltY === 0) {
    if (tiltX < 0) azimuthAngle = Math.PI;
  } else if (Math.abs(tiltX) !== 90 && Math.abs(tiltY) !== 90) {
    azimuthAngle = Math.atan2(Math.tan(tiltYRadians), Math.tan(tiltXRadians));
    if (azimuthAngle < 0) azimuthAngle += 2 * Math.PI;
  }

  let altitudeAngle: number;
  if (Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90) {
    altitudeAngle = 0;
  } else if (tiltX === 0) {
    altitudeAngle = Math.PI / 2 - Math.abs(tiltYRadians);
  } else if (tiltY === 0) {
    altitudeAngle = Math.PI / 2 - Math.abs(tiltXRadians);
  } else {
    const tangentX = Math.tan(tiltXRadians);
    const tangentY = Math.tan(tiltYRadians);
    altitudeAngle = Math.atan(1 / Math.sqrt(tangentX ** 2 + tangentY ** 2));
  }

  return { altitudeAngle, azimuthAngle };
}

function sphericalToTilt(
  altitudeAngle: number,
  azimuthAngle: number,
): Pick<PointerOrientation, "tiltX" | "tiltY"> {
  let tiltXRadians = 0;
  let tiltYRadians = 0;
  if (altitudeAngle === 0) {
    if (azimuthAngle === 0 || azimuthAngle === 2 * Math.PI) {
      tiltXRadians = Math.PI / 2;
    } else if (azimuthAngle === Math.PI / 2) {
      tiltYRadians = Math.PI / 2;
    } else if (azimuthAngle === Math.PI) {
      tiltXRadians = -Math.PI / 2;
    } else if (azimuthAngle === 3 * Math.PI / 2) {
      tiltYRadians = -Math.PI / 2;
    } else if (azimuthAngle > 0 && azimuthAngle < Math.PI / 2) {
      tiltXRadians = Math.PI / 2;
      tiltYRadians = Math.PI / 2;
    } else if (azimuthAngle > Math.PI / 2 && azimuthAngle < Math.PI) {
      tiltXRadians = -Math.PI / 2;
      tiltYRadians = Math.PI / 2;
    } else if (azimuthAngle > Math.PI && azimuthAngle < 3 * Math.PI / 2) {
      tiltXRadians = -Math.PI / 2;
      tiltYRadians = -Math.PI / 2;
    } else if (azimuthAngle > 3 * Math.PI / 2 && azimuthAngle < 2 * Math.PI) {
      tiltXRadians = Math.PI / 2;
      tiltYRadians = -Math.PI / 2;
    }
  } else {
    const tangentAltitude = Math.tan(altitudeAngle);
    tiltXRadians = Math.atan(Math.cos(azimuthAngle) / tangentAltitude);
    tiltYRadians = Math.atan(Math.sin(azimuthAngle) / tangentAltitude);
  }

  return {
    tiltX: Math.round(tiltXRadians * 180 / Math.PI),
    tiltY: Math.round(tiltYRadians * 180 / Math.PI),
  };
}

function pointerOrientation(init: QuoxPointerEventInit): PointerOrientation {
  const hasTilt = init.tiltX !== undefined || init.tiltY !== undefined;
  const hasSpherical = init.altitudeAngle !== undefined || init.azimuthAngle !== undefined;

  if (hasTilt && !hasSpherical) {
    const tiltX = toInt32(init.tiltX);
    const tiltY = toInt32(init.tiltY);
    return { tiltX, tiltY, ...tiltToSpherical(tiltX, tiltY) };
  }

  if (hasSpherical && !hasTilt) {
    const altitudeAngle = finiteNumber(init.altitudeAngle, Math.PI / 2, "altitudeAngle");
    const azimuthAngle = finiteNumber(init.azimuthAngle, 0, "azimuthAngle");
    return {
      ...sphericalToTilt(altitudeAngle, azimuthAngle),
      altitudeAngle,
      azimuthAngle,
    };
  }

  return {
    tiltX: toInt32(init.tiltX),
    tiltY: toInt32(init.tiltY),
    altitudeAngle: finiteNumber(init.altitudeAngle, Math.PI / 2, "altitudeAngle"),
    azimuthAngle: finiteNumber(init.azimuthAngle, 0, "azimuthAngle"),
  };
}

function modifierState(init: QuoxEventModifierInit): ReadonlySet<string> {
  const active = new Set<string>();
  for (const [name, property] of MODIFIER_INITIALIZERS) {
    if (init[property]) active.add(name);
  }
  return active;
}

/** @internal Build coordinates which only the trusted renderer bridge may initialize. */
export function createTrustedMouseEventInit<Init extends QuoxMouseEventInit>(
  eventInit: Init,
  coordinates: TrustedMouseCoordinates,
): Init {
  return Object.assign({}, eventInit, { [trustedMouseCoordinates]: { ...coordinates } });
}

/**
 * The read-only plaintext subset of `DataTransfer` exposed by native clipboard events.
 *
 * Quox does not yet feed handler-authored clipboard contents back into the native default action,
 * so mutation fails explicitly instead of appearing to work and then being ignored.
 */
export class QuoxDataTransfer {
  readonly #text: string | null;
  readonly #types: readonly string[];

  constructor(text: string | null = null) {
    this.#text = text === null ? null : toUSVString(text);
    this.#types = Object.freeze(this.#text === null ? [] : ["text/plain"]);
  }

  get types(): readonly string[] {
    return this.#types;
  }

  getData(format: string): string {
    const normalized = domString(format, "").toLowerCase();
    if (normalized !== "text" && normalized !== "text/plain") return "";
    return this.#text ?? "";
  }

  clearData(_format?: string): void {
    throw new DOMException("quox: clipboard data is read-only", "NotSupportedError");
  }

  setData(_format: string, _data: string): void {
    throw new DOMException("quox: clipboard data is read-only", "NotSupportedError");
  }
}

/** Browser-shaped clipboard event backed by Quox's plaintext transfer facade. */
export class QuoxClipboardEvent extends QuoxEvent {
  readonly #clipboardData: QuoxDataTransfer | null;

  constructor(type: string, eventInit: QuoxClipboardEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#clipboardData = eventInit.clipboardData ?? null;
  }

  get clipboardData(): QuoxDataTransfer | null {
    return this.#clipboardData;
  }
}

export class QuoxUIEvent extends QuoxEvent {
  readonly #view: QuoxEventTarget | null;
  readonly #detail: number;
  readonly #which: number;

  constructor(type: string, eventInit: QuoxUIEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#view = eventInit.view ?? null;
    this.#detail = toInt32(eventInit.detail);
    this.#which = toUint32(eventInit.which);
  }

  get view(): QuoxEventTarget | null {
    return this.#view;
  }

  get detail(): number {
    return this.#detail;
  }

  get which(): number {
    return this.#which;
  }
}

export class QuoxMouseEvent extends QuoxUIEvent {
  readonly #screenX: number;
  readonly #screenY: number;
  readonly #clientX: number;
  readonly #clientY: number;
  readonly #pageX: number;
  readonly #pageY: number;
  readonly #offsetX: number;
  readonly #offsetY: number;
  readonly #movementX: number;
  readonly #movementY: number;
  readonly #button: number;
  readonly #buttons: number;
  readonly #relatedTarget: QuoxEventTarget | null;
  readonly #modifiers: ReadonlySet<string>;

  constructor(type: string, eventInit: QuoxMouseEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    const trustedCoordinates = (eventInit as TrustedMouseEventInit)[trustedMouseCoordinates];
    this.#screenX = finiteNumber(eventInit.screenX, 0, "screenX");
    this.#screenY = finiteNumber(eventInit.screenY, 0, "screenY");
    this.#clientX = finiteNumber(eventInit.clientX, 0, "clientX");
    this.#clientY = finiteNumber(eventInit.clientY, 0, "clientY");
    this.#pageX = finiteNumber(trustedCoordinates?.pageX, this.#clientX, "pageX");
    this.#pageY = finiteNumber(trustedCoordinates?.pageY, this.#clientY, "pageY");
    this.#offsetX = finiteNumber(trustedCoordinates?.offsetX, this.#clientX, "offsetX");
    this.#offsetY = finiteNumber(trustedCoordinates?.offsetY, this.#clientY, "offsetY");
    this.#movementX = finiteNumber(eventInit.movementX, 0, "movementX");
    this.#movementY = finiteNumber(eventInit.movementY, 0, "movementY");
    this.#button = toInt16(eventInit.button);
    this.#buttons = toUint16(eventInit.buttons);
    this.#relatedTarget = eventInit.relatedTarget ?? null;
    this.#modifiers = modifierState(eventInit);
  }

  get screenX(): number {
    return this.#screenX;
  }

  get screenY(): number {
    return this.#screenY;
  }

  get clientX(): number {
    return this.#clientX;
  }

  get clientY(): number {
    return this.#clientY;
  }

  get x(): number {
    return this.#clientX;
  }

  get y(): number {
    return this.#clientY;
  }

  get pageX(): number {
    return this.#pageX;
  }

  get pageY(): number {
    return this.#pageY;
  }

  get offsetX(): number {
    return this.#offsetX;
  }

  get offsetY(): number {
    return this.#offsetY;
  }

  get movementX(): number {
    return this.#movementX;
  }

  get movementY(): number {
    return this.#movementY;
  }

  get ctrlKey(): boolean {
    return this.#modifiers.has("Control");
  }

  get shiftKey(): boolean {
    return this.#modifiers.has("Shift");
  }

  get altKey(): boolean {
    return this.#modifiers.has("Alt");
  }

  get metaKey(): boolean {
    return this.#modifiers.has("Meta");
  }

  get button(): number {
    return this.#button;
  }

  get buttons(): number {
    return this.#buttons;
  }

  get relatedTarget(): QuoxEventTarget | null {
    return this.#relatedTarget;
  }

  getModifierState(keyArg: string): boolean {
    return this.#modifiers.has(domString(keyArg, ""));
  }
}

export class QuoxPointerEvent extends QuoxMouseEvent {
  readonly #pointerId: number;
  readonly #width: number;
  readonly #height: number;
  readonly #pressure: number;
  readonly #tangentialPressure: number;
  readonly #tiltX: number;
  readonly #tiltY: number;
  readonly #twist: number;
  readonly #altitudeAngle: number;
  readonly #azimuthAngle: number;
  readonly #pointerType: string;
  readonly #isPrimary: boolean;
  readonly #persistentDeviceId: number;
  readonly #coalescedEvents: readonly QuoxPointerEvent[];
  readonly #predictedEvents: readonly QuoxPointerEvent[];

  constructor(type: string, eventInit: QuoxPointerEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    const orientation = pointerOrientation(eventInit);
    this.#pointerId = toInt32(eventInit.pointerId);
    this.#width = finiteNumber(eventInit.width, 1, "width");
    this.#height = finiteNumber(eventInit.height, 1, "height");
    this.#pressure = finiteFloat(eventInit.pressure, 0, "pressure");
    this.#tangentialPressure = finiteFloat(
      eventInit.tangentialPressure,
      0,
      "tangentialPressure",
    );
    this.#tiltX = orientation.tiltX;
    this.#tiltY = orientation.tiltY;
    this.#twist = toInt32(eventInit.twist);
    this.#altitudeAngle = orientation.altitudeAngle;
    this.#azimuthAngle = orientation.azimuthAngle;
    this.#pointerType = domString(eventInit.pointerType, "");
    this.#isPrimary = Boolean(eventInit.isPrimary);
    this.#persistentDeviceId = toInt32(eventInit.persistentDeviceId);
    this.#coalescedEvents = Object.freeze(
      Array.from(eventInit.coalescedEvents === undefined ? [] : eventInit.coalescedEvents),
    );
    this.#predictedEvents = Object.freeze(
      Array.from(eventInit.predictedEvents === undefined ? [] : eventInit.predictedEvents),
    );
  }

  get pointerId(): number {
    return this.#pointerId;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get pressure(): number {
    return this.#pressure;
  }

  get tangentialPressure(): number {
    return this.#tangentialPressure;
  }

  get tiltX(): number {
    return this.#tiltX;
  }

  get tiltY(): number {
    return this.#tiltY;
  }

  get twist(): number {
    return this.#twist;
  }

  get altitudeAngle(): number {
    return this.#altitudeAngle;
  }

  get azimuthAngle(): number {
    return this.#azimuthAngle;
  }

  get pointerType(): string {
    return this.#pointerType;
  }

  get isPrimary(): boolean {
    return this.#isPrimary;
  }

  get persistentDeviceId(): number {
    return this.#persistentDeviceId;
  }

  getCoalescedEvents(): QuoxPointerEvent[] {
    return Array.from(this.#coalescedEvents);
  }

  getPredictedEvents(): QuoxPointerEvent[] {
    return Array.from(this.#predictedEvents);
  }
}

export class QuoxWheelEvent extends QuoxMouseEvent {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;

  readonly DOM_DELTA_PIXEL = QuoxWheelEvent.DOM_DELTA_PIXEL;
  readonly DOM_DELTA_LINE = QuoxWheelEvent.DOM_DELTA_LINE;
  readonly DOM_DELTA_PAGE = QuoxWheelEvent.DOM_DELTA_PAGE;

  readonly #deltaX: number;
  readonly #deltaY: number;
  readonly #deltaZ: number;
  readonly #deltaMode: number;

  constructor(type: string, eventInit: QuoxWheelEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#deltaX = finiteNumber(eventInit.deltaX, 0, "deltaX");
    this.#deltaY = finiteNumber(eventInit.deltaY, 0, "deltaY");
    this.#deltaZ = finiteNumber(eventInit.deltaZ, 0, "deltaZ");
    this.#deltaMode = toUint32(eventInit.deltaMode);
  }

  get deltaX(): number {
    return this.#deltaX;
  }

  get deltaY(): number {
    return this.#deltaY;
  }

  get deltaZ(): number {
    return this.#deltaZ;
  }

  get deltaMode(): number {
    return this.#deltaMode;
  }
}

/** DOM-style keyboard event, distinct from the raw `QuoxKeyboardEvent` input record. */
export class QuoxDOMKeyboardEvent extends QuoxUIEvent {
  static readonly DOM_KEY_LOCATION_STANDARD = 0;
  static readonly DOM_KEY_LOCATION_LEFT = 1;
  static readonly DOM_KEY_LOCATION_RIGHT = 2;
  static readonly DOM_KEY_LOCATION_NUMPAD = 3;

  readonly DOM_KEY_LOCATION_STANDARD = QuoxDOMKeyboardEvent.DOM_KEY_LOCATION_STANDARD;
  readonly DOM_KEY_LOCATION_LEFT = QuoxDOMKeyboardEvent.DOM_KEY_LOCATION_LEFT;
  readonly DOM_KEY_LOCATION_RIGHT = QuoxDOMKeyboardEvent.DOM_KEY_LOCATION_RIGHT;
  readonly DOM_KEY_LOCATION_NUMPAD = QuoxDOMKeyboardEvent.DOM_KEY_LOCATION_NUMPAD;

  readonly #key: string;
  readonly #code: string;
  readonly #location: number;
  readonly #repeat: boolean;
  readonly #isComposing: boolean;
  readonly #charCode: number;
  readonly #keyCode: number;
  readonly #modifiers: ReadonlySet<string>;

  constructor(type: string, eventInit: QuoxKeyboardEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, {
      ...eventInit,
      which: eventInit.which ?? eventInit.keyCode ?? eventInit.charCode,
    });
    this.#key = domString(eventInit.key, "");
    this.#code = domString(eventInit.code, "");
    this.#location = toUint32(eventInit.location);
    this.#repeat = Boolean(eventInit.repeat);
    this.#isComposing = Boolean(eventInit.isComposing);
    this.#charCode = toUint32(eventInit.charCode);
    this.#keyCode = toUint32(eventInit.keyCode);
    this.#modifiers = modifierState(eventInit);
  }

  get key(): string {
    return this.#key;
  }

  get code(): string {
    return this.#code;
  }

  get location(): number {
    return this.#location;
  }

  get ctrlKey(): boolean {
    return this.#modifiers.has("Control");
  }

  get shiftKey(): boolean {
    return this.#modifiers.has("Shift");
  }

  get altKey(): boolean {
    return this.#modifiers.has("Alt");
  }

  get metaKey(): boolean {
    return this.#modifiers.has("Meta");
  }

  get repeat(): boolean {
    return this.#repeat;
  }

  get isComposing(): boolean {
    return this.#isComposing;
  }

  get charCode(): number {
    return this.#charCode;
  }

  get keyCode(): number {
    return this.#keyCode;
  }

  getModifierState(keyArg: string): boolean {
    return this.#modifiers.has(domString(keyArg, ""));
  }
}

/** DOM-style input event, distinct from the raw `QuoxInputEvent` observer record. */
export class QuoxDOMInputEvent extends QuoxUIEvent {
  readonly #data: string | null;
  readonly #isComposing: boolean;
  readonly #inputType: string;
  readonly #dataTransfer: unknown | null;
  readonly #targetRanges: readonly unknown[];

  constructor(type: string, eventInit: QuoxInputEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#data = eventInit.data == null ? null : toUSVString(eventInit.data);
    this.#isComposing = Boolean(eventInit.isComposing);
    this.#inputType = domString(eventInit.inputType, "");
    this.#dataTransfer = eventInit.dataTransfer ?? null;
    this.#targetRanges = Object.freeze(
      Array.from(eventInit.targetRanges === undefined ? [] : eventInit.targetRanges),
    );
  }

  get data(): string | null {
    return this.#data;
  }

  get isComposing(): boolean {
    return this.#isComposing;
  }

  get inputType(): string {
    return this.#inputType;
  }

  get dataTransfer(): unknown | null {
    return this.#dataTransfer;
  }

  getTargetRanges(): unknown[] {
    return Array.from(this.#targetRanges);
  }
}

export class QuoxFocusEvent extends QuoxUIEvent {
  readonly #relatedTarget: QuoxEventTarget | null;

  constructor(type: string, eventInit: QuoxFocusEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#relatedTarget = eventInit.relatedTarget ?? null;
  }

  get relatedTarget(): QuoxEventTarget | null {
    return this.#relatedTarget;
  }
}

export class QuoxCompositionEvent extends QuoxUIEvent {
  readonly #data: string;

  constructor(type: string, eventInit: QuoxCompositionEventInit = {}) {
    eventInit = eventInit ?? {};
    super(type, eventInit);
    this.#data = toUSVString(eventInit.data === undefined ? "" : eventInit.data);
  }

  get data(): string {
    return this.#data;
  }
}
