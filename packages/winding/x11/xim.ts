import type { ImeEvent } from "../types.ts";
import { utf8CString as cString } from "../text_encoding.ts";
import { libcFunctions, x11functions } from "./ffi.ts";
import { applyPreeditChange, keysymToDomKey, utf8ByteOffset } from "./keysym.ts";

type X11Library = Deno.DynamicLibrary<typeof x11functions>;
type X11Symbols = X11Library["symbols"];
type QueueImeEvent = (window: bigint, event: ImeEvent) => void;
type SelectInput = (window: bigint, extraMask: bigint) => void;
interface OwnedCallback {
  readonly pointer: Deno.PointerObject;
  close(): void;
}

const LC_CTYPE = 0;
const MAX_LOOKUP_BYTES = 1024 * 1024;
const MAX_STYLES = 64;

const X_BUFFER_OVERFLOW = -1;
const X_LOOKUP_CHARS = 2;
const X_LOOKUP_KEYSYM = 3;
const X_LOOKUP_BOTH = 4;

const XIM_PREEDIT_CALLBACKS = 0x0002n;
const XIM_PREEDIT_NOTHING = 0x0008n;
const XIM_PREEDIT_NONE = 0x0010n;
const XIM_STATUS_NOTHING = 0x0400n;
const XIM_STATUS_NONE = 0x0800n;
const CALLBACK_STYLE = XIM_PREEDIT_CALLBACKS | XIM_STATUS_NOTHING;
const NOTHING_STYLE = XIM_PREEDIT_NOTHING | XIM_STATUS_NOTHING;
const NONE_STYLE = XIM_PREEDIT_NONE | XIM_STATUS_NONE;

const XIM_ABSOLUTE_POSITION = 10;
const XIM_CARET_INVISIBLE = 0;

const XN_QUERY_INPUT_STYLE = cString("queryInputStyle");
const XN_INPUT_STYLE = cString("inputStyle");
const XN_CLIENT_WINDOW = cString("clientWindow");
const XN_FOCUS_WINDOW = cString("focusWindow");
const XN_DESTROY_CALLBACK = cString("destroyCallback");
const XN_FILTER_EVENTS = cString("filterEvents");
const XN_PREEDIT_START_CALLBACK = cString("preeditStartCallback");
const XN_PREEDIT_DONE_CALLBACK = cString("preeditDoneCallback");
const XN_PREEDIT_DRAW_CALLBACK = cString("preeditDrawCallback");
const XN_PREEDIT_CARET_CALLBACK = cString("preeditCaretCallback");
const XN_PREEDIT_ATTRIBUTES = cString("preeditAttributes");
const XN_SPOT_LOCATION = cString("spotLocation");
const XN_AREA = cString("area");

const PREEDIT_START_DEFINITION = {
  parameters: ["pointer", "pointer", "pointer"],
  result: "i32",
} as const;
const PREEDIT_CALLBACK_DEFINITION = {
  parameters: ["pointer", "pointer", "pointer"],
  result: "void",
} as const;
const XIM_LIFECYCLE_CALLBACK_DEFINITION = {
  parameters: ["pointer", "pointer", "pointer"],
  result: "void",
} as const;

function pointerFromAddress(address: bigint): Deno.PointerObject | null {
  return address === 0n ? null : Deno.UnsafePointer.create(address);
}

function pointerAddress(pointer: Deno.PointerValue): bigint {
  return pointer === null ? 0n : Deno.UnsafePointer.value(pointer);
}

function callbackRecord(callback: OwnedCallback): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array([0n, pointerAddress(callback.pointer)]) as BigUint64Array<ArrayBuffer>;
}

function pointerString(pointer: Deno.PointerValue): string | undefined {
  return pointer === null ? undefined : new Deno.UnsafePointerView(pointer).getCString();
}

function isUtf8Locale(locale: string | undefined): boolean {
  if (locale === undefined) return false;
  const normalized = locale.toLowerCase().replaceAll("_", "-");
  return normalized.includes("utf-8") || normalized.includes("utf8");
}

function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(value)));
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

function packPoint(x: number, y: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setInt16(0, clampI16(x), true);
  view.setInt16(2, clampI16(y), true);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

function packRectangle(x: number, y: number, width: number, height: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setInt16(0, clampI16(x), true);
  view.setInt16(2, clampI16(y), true);
  view.setUint16(4, clampU16(width), true);
  view.setUint16(6, clampU16(height), true);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

function decodeUtf8Scalars(pointer: Deno.PointerObject, length: number): string[] | undefined {
  if (!Number.isInteger(length) || length < 0 || length > MAX_LOOKUP_BYTES) return undefined;
  const view = new Deno.UnsafePointerView(pointer);
  const bytes: number[] = [];
  for (let scalar = 0; scalar < length; scalar++) {
    const lead = view.getUint8(bytes.length);
    if (lead === 0) return undefined;
    const width = lead < 0x80
      ? 1
      : lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
      ? 3
      : lead >= 0xf0 && lead <= 0xf4
      ? 4
      : 0;
    if (width === 0) return undefined;
    bytes.push(lead);
    for (let offset = 1; offset < width; offset++) {
      const continuation = view.getUint8(bytes.length);
      if ((continuation & 0xc0) !== 0x80) return undefined;
      bytes.push(continuation);
    }
  }
  try {
    return [...new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))];
  } catch {
    return undefined;
  }
}

function decodeWideScalars(pointer: Deno.PointerObject, length: number): string[] | undefined {
  if (!Number.isInteger(length) || length < 0 || length > MAX_LOOKUP_BYTES / 4) return undefined;
  const view = new Deno.UnsafePointerView(pointer);
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    const codePoint = view.getUint32(index * 4);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    result.push(String.fromCodePoint(codePoint));
  }
  return result;
}

/** Read an LP64 Linux XIMText. `undefined` means feedback-only/invalid. */
function readXimText(pointer: Deno.PointerObject): string[] | undefined {
  const view = new Deno.UnsafePointerView(pointer);
  const length = view.getUint16(0);
  const isWide = view.getInt32(16) !== 0;
  const stringPointer = pointerFromAddress(view.getBigUint64(24));
  if (stringPointer === null) return undefined;
  return isWide ? decodeWideScalars(stringPointer, length) : decodeUtf8Scalars(stringPointer, length);
}

export interface XimLookupResult {
  key?: string;
  text?: string;
  keysym: bigint;
}

interface InputStyles {
  preedit: bigint;
  callbacks: boolean;
  none: bigint;
}

interface CursorArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Process-wide XIM owner. All calls are deliberately made on Deno's main thread. */
export class XimManager implements Disposable {
  readonly #x11: X11Symbols;
  readonly #display: Deno.PointerObject;
  readonly #queueEvent: QueueImeEvent;
  readonly #selectInput: SelectInput;
  readonly #libc: Deno.DynamicLibrary<typeof libcFunctions>;
  readonly #contexts = new Set<XimContext>();
  readonly #destroyCallback: Deno.UnsafeCallback<typeof XIM_LIFECYCLE_CALLBACK_DEFINITION>;
  readonly #instantiateCallback: Deno.UnsafeCallback<typeof XIM_LIFECYCLE_CALLBACK_DEFINITION>;
  readonly #destroyRecord: BigUint64Array<ArrayBuffer>;
  #im: Deno.PointerObject | null = null;
  #styles: InputStyles | undefined;
  #usingFallback = false;
  #instantiateRegistered = false;
  #rebuildPending = false;
  #serverDestroyed = false;
  #closed = false;
  readonly localeIsUtf8: boolean;

  constructor(
    X11: X11Library,
    display: Deno.PointerObject,
    queueEvent: QueueImeEvent,
    selectInput: SelectInput,
  ) {
    this.#x11 = X11.symbols;
    this.#display = display;
    this.#queueEvent = queueEvent;
    this.#selectInput = selectInput;
    this.#libc = Deno.dlopen("libc.so.6", libcFunctions);

    const locale = this.#libc.symbols.setlocale(LC_CTYPE, cString(""));
    this.localeIsUtf8 = isUtf8Locale(pointerString(locale));

    this.#destroyCallback = new Deno.UnsafeCallback(XIM_LIFECYCLE_CALLBACK_DEFINITION, () => {
      // Xlib has already invalidated the XIM and all XICs. Native destruction
      // here would be a UAF (and can hang with external IM servers), so only
      // mark state and rebuild after the callback returns.
      this.#serverDestroyed = true;
      this.#rebuildPending = true;
      this.#im = null;
      this.#styles = undefined;
      for (const context of this.#contexts) context.invalidateFromServer();
    });
    this.#destroyRecord = callbackRecord(this.#destroyCallback);

    this.#instantiateCallback = new Deno.UnsafeCallback(XIM_LIFECYCLE_CALLBACK_DEFINITION, () => {
      this.#rebuildPending = true;
    });

    if (this.#x11.XSupportsLocale() !== 0) this.#openInputMethod();
  }

  createContext(window: bigint): XimContext {
    const context = new XimContext(this, window);
    this.#contexts.add(context);
    context.recreate();
    return context;
  }

  removeContext(context: XimContext): void {
    if (!this.#contexts.delete(context)) return;
    context.destroy(false);
  }

  queue(window: bigint, event: ImeEvent): void {
    this.#queueEvent(window, event);
  }

  processDeferred(): void {
    if (!this.#rebuildPending || this.#closed) return;
    this.#rebuildPending = false;

    const invalidatedByServer = this.#serverDestroyed;
    this.#serverDestroyed = false;
    for (const context of this.#contexts) context.destroy(invalidatedByServer);

    if (!invalidatedByServer && this.#im !== null) this.#x11.XCloseIM(this.#im);
    this.#im = null;
    this.#styles = undefined;
    this.#openInputMethod();
    for (const context of this.#contexts) context.recreate(true);
  }

  filterEvent(event: Deno.PointerObject, context: XimContext): boolean {
    return context.shouldFilter && this.#x11.XFilterEvent(event, context.window) !== 0;
  }

  lookup(context: XimContext, event: Deno.PointerObject): XimLookupResult {
    const ic = context.ic;
    if (ic === null) {
      const keysym = BigInt(this.#x11.XLookupKeysym(event, 0));
      return { keysym, key: keysymToDomKey(this.#keysymName(keysym), "") };
    }

    let buffer = new Uint8Array(64) as Uint8Array<ArrayBuffer>;
    const keysym = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    const status = new Int32Array(1) as Int32Array<ArrayBuffer>;
    let written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    if (status[0] === X_BUFFER_OVERFLOW) {
      if (written <= 0 || written > MAX_LOOKUP_BYTES) {
        const fallback = BigInt(this.#x11.XLookupKeysym(event, 0));
        return { keysym: fallback, key: keysymToDomKey(this.#keysymName(fallback), "") };
      }
      buffer = new Uint8Array(written) as Uint8Array<ArrayBuffer>;
      written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    }

    const hasChars = status[0] === X_LOOKUP_CHARS || status[0] === X_LOOKUP_BOTH;
    const hasKeysym = status[0] === X_LOOKUP_KEYSYM || status[0] === X_LOOKUP_BOTH;
    const text = hasChars && written > 0
      ? new TextDecoder("utf-8").decode(buffer.subarray(0, Math.min(written, buffer.length)))
      : "";
    const resolvedKeysym = hasKeysym ? keysym[0] : BigInt(this.#x11.XLookupKeysym(event, 0));
    return {
      keysym: resolvedKeysym,
      key: keysymToDomKey(this.#keysymName(resolvedKeysym), text),
      text: text.length > 0 ? text : undefined,
    };
  }

  createIc(context: XimContext): Deno.PointerObject | null {
    if (this.#im === null || this.#styles === undefined) return null;
    const style = context.enabled ? this.#styles.preedit : this.#styles.none;
    let ic: Deno.PointerObject | null;

    if (context.enabled && this.#styles.callbacks) {
      const callbackAttributes = context.createCallbackAttributes();
      if (callbackAttributes === null) return null;
      try {
        ic = this.#x11.XCreateICPreeditCallbacks(
          this.#im,
          XN_INPUT_STYLE,
          style,
          XN_CLIENT_WINDOW,
          context.window,
          XN_FOCUS_WINDOW,
          context.window,
          XN_PREEDIT_ATTRIBUTES,
          callbackAttributes,
          null,
        );
      } finally {
        this.#x11.XFree(callbackAttributes);
      }
    } else {
      ic = this.#x11.XCreateICSimple(
        this.#im,
        XN_INPUT_STYLE,
        style,
        XN_CLIENT_WINDOW,
        context.window,
        XN_FOCUS_WINDOW,
        context.window,
        null,
      );
    }

    if (ic !== null) {
      const filterMask = new BigInt64Array(1) as BigInt64Array<ArrayBuffer>;
      if (this.#x11.XGetICValuesFilterEvents(ic, XN_FILTER_EVENTS, filterMask, null) === null) {
        this.#selectInput(context.window, filterMask[0]);
      }
    }
    return ic;
  }

  createPreeditAttributes(
    records: readonly BigUint64Array<ArrayBuffer>[],
  ): Deno.PointerObject | null {
    return this.#x11.XVaCreateNestedListPreeditCallbacks(
      0,
      XN_PREEDIT_START_CALLBACK,
      records[0],
      XN_PREEDIT_DONE_CALLBACK,
      records[1],
      XN_PREEDIT_DRAW_CALLBACK,
      records[2],
      XN_PREEDIT_CARET_CALLBACK,
      records[3],
      null,
    );
  }

  destroyIc(ic: Deno.PointerObject): void {
    this.#x11.XDestroyIC(ic);
  }

  focusIc(ic: Deno.PointerObject): void {
    this.#x11.XSetICFocus(ic);
  }

  unfocusIc(ic: Deno.PointerObject): void {
    this.#x11.XUnsetICFocus(ic);
  }

  setArea(ic: Deno.PointerObject, area: CursorArea): void {
    const rectangle = packRectangle(area.x, area.y, area.width, area.height);
    const spot = packPoint(area.x + area.width, area.y + area.height);
    const attributes = this.#x11.XVaCreateNestedListGeometry(0, XN_SPOT_LOCATION, spot, XN_AREA, rectangle, null);
    if (attributes === null) return;
    try {
      this.#x11.XSetICValuesPreeditAttributes(ic, XN_PREEDIT_ATTRIBUTES, attributes, null);
    } finally {
      this.#x11.XFree(attributes);
    }
  }

  writeCaretPosition(pointer: Deno.PointerObject, position: number): void {
    const value = new Int32Array([position]) as Int32Array<ArrayBuffer>;
    this.#libc.symbols.memcpy(pointer, value, 4n);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const context of this.#contexts) context.destroy(this.#serverDestroyed);
    this.#contexts.clear();
    if (this.#im !== null && !this.#serverDestroyed) this.#x11.XCloseIM(this.#im);
    this.#im = null;
    if (this.#instantiateRegistered) {
      this.#x11.XUnregisterIMInstantiateCallback(
        this.#display,
        null,
        null,
        null,
        this.#instantiateCallback.pointer,
        null,
      );
      this.#instantiateRegistered = false;
    }
    this.#destroyCallback.close();
    this.#instantiateCallback.close();
    this.#libc.close();
  }

  #openInputMethod(): void {
    if (this.#closed) return;
    const candidates = ["", "@im=local", "@im="] as const;
    for (let index = 0; index < candidates.length; index++) {
      this.#x11.XSetLocaleModifiers(cString(candidates[index]));
      const im = this.#x11.XOpenIM(this.#display, null, null, null);
      if (im === null) {
        if (index === 0) this.#registerInstantiateCallback();
        continue;
      }
      const styles = this.#queryStyles(im);
      if (styles === undefined) {
        this.#x11.XCloseIM(im);
        continue;
      }

      this.#im = im;
      this.#styles = styles;
      this.#usingFallback = index !== 0;
      this.#x11.XSetIMValuesDestroyCallback(im, XN_DESTROY_CALLBACK, this.#destroyRecord, null);
      if (!this.#usingFallback && this.#instantiateRegistered) {
        this.#x11.XUnregisterIMInstantiateCallback(
          this.#display,
          null,
          null,
          null,
          this.#instantiateCallback.pointer,
          null,
        );
        this.#instantiateRegistered = false;
      }
      return;
    }
    this.#registerInstantiateCallback();
  }

  #queryStyles(im: Deno.PointerObject): InputStyles | undefined {
    const output = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    if (this.#x11.XGetIMValuesQueryInputStyle(im, XN_QUERY_INPUT_STYLE, output, null) !== null) {
      return undefined;
    }
    const stylesPointer = pointerFromAddress(output[0]);
    if (stylesPointer === null) return undefined;
    try {
      const stylesView = new Deno.UnsafePointerView(stylesPointer);
      const count = Math.min(stylesView.getUint16(0), MAX_STYLES);
      const valuesPointer = pointerFromAddress(stylesView.getBigUint64(8));
      if (valuesPointer === null) return undefined;
      const valuesView = new Deno.UnsafePointerView(valuesPointer);
      const values = new Set<bigint>();
      for (let index = 0; index < count; index++) values.add(valuesView.getBigUint64(index * 8));

      const canUseCallbacks = this.localeIsUtf8 && values.has(CALLBACK_STYLE);
      const preedit = canUseCallbacks
        ? CALLBACK_STYLE
        : values.has(NOTHING_STYLE)
        ? NOTHING_STYLE
        : values.has(NONE_STYLE)
        ? NONE_STYLE
        : undefined;
      const none = values.has(NONE_STYLE) ? NONE_STYLE : values.has(NOTHING_STYLE) ? NOTHING_STYLE : preedit;
      return preedit === undefined || none === undefined ? undefined : { preedit, callbacks: canUseCallbacks, none };
    } finally {
      this.#x11.XFree(stylesPointer);
    }
  }

  #keysymName(keysym: bigint): string | undefined {
    if (keysym === 0n) return undefined;
    return pointerString(this.#x11.XKeysymToString(keysym));
  }

  #registerInstantiateCallback(): void {
    if (this.#instantiateRegistered || this.#closed) return;
    this.#instantiateRegistered = this.#x11.XRegisterIMInstantiateCallback(
      this.#display,
      null,
      null,
      null,
      this.#instantiateCallback.pointer,
      null,
    ) !== 0;
  }
}

/** Per-window XIC and preedit state. */
export class XimContext implements Disposable {
  readonly manager: XimManager;
  readonly window: bigint;
  #ic: Deno.PointerObject | null = null;
  #callbacks: OwnedCallback[] = [];
  #callbackRecords: BigUint64Array<ArrayBuffer>[] = [];
  #nativeFocused = false;
  #enabled = false;
  #serverInvalidated = false;
  #composing = false;
  #preedit: string[] = [];
  #cursor = 0;
  #cursorVisible = true;
  #cursorArea: CursorArea | undefined;
  #lastPreeditSignature: string | undefined;
  #closed = false;

  constructor(manager: XimManager, window: bigint) {
    this.manager = manager;
    this.window = window;
  }

  get ic(): Deno.PointerObject | null {
    return this.#ic;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get composing(): boolean {
    return this.#composing;
  }

  get shouldFilter(): boolean {
    return this.#enabled && this.#nativeFocused && this.#ic !== null;
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled || this.#closed) return;
    this.#enabled = enabled;
    this.#clearPreedit(true);
    this.destroy(false);
    this.recreate();
    this.manager.queue(this.window, { type: "ime", kind: this.#ic !== null && enabled ? "enabled" : "disabled" });
  }

  setNativeFocused(focused: boolean): void {
    if (this.#nativeFocused === focused || this.#closed) return;
    if (!focused && this.#ic !== null && this.#enabled) this.manager.unfocusIc(this.#ic);
    this.#nativeFocused = focused;
    if (focused && this.#ic !== null && this.#enabled) this.manager.focusIc(this.#ic);
    if (!focused) this.#clearPreedit(true);
  }

  setCursorArea(x: number, y: number, width: number, height: number): void {
    const area = { x, y, width, height };
    this.#cursorArea = area;
    if (this.#ic !== null && this.#enabled) this.manager.setArea(this.#ic, area);
  }

  recreate(announce = false): void {
    if (this.#closed || this.#ic !== null) return;
    this.#serverInvalidated = false;
    this.#ic = this.manager.createIc(this);
    if (this.#ic === null) return;
    if (this.#cursorArea !== undefined && this.#enabled) this.manager.setArea(this.#ic, this.#cursorArea);
    if (this.#nativeFocused && this.#enabled) this.manager.focusIc(this.#ic);
    if (announce && this.#enabled) this.manager.queue(this.window, { type: "ime", kind: "enabled" });
  }

  createCallbackAttributes(): Deno.PointerObject | null {
    this.#closeCallbacks();
    const start = new Deno.UnsafeCallback(PREEDIT_START_DEFINITION, () => {
      try {
        this.#composing = true;
        this.#preedit = [];
        this.#cursor = 0;
        this.#cursorVisible = true;
        this.#emitPreedit();
        return -1;
      } catch {
        this.#clearPreedit(true);
        return -1;
      }
    });
    const done = new Deno.UnsafeCallback(PREEDIT_CALLBACK_DEFINITION, () => {
      try {
        this.#clearPreedit(true);
      } catch {
        // Never unwind through Xlib.
      }
    });
    const draw = new Deno.UnsafeCallback(PREEDIT_CALLBACK_DEFINITION, (_ic, _clientData, callData) => {
      try {
        if (callData === null) return;
        const view = new Deno.UnsafePointerView(callData);
        const caret = view.getInt32(0);
        const first = view.getInt32(4);
        const length = view.getInt32(8);
        const textPointer = pointerFromAddress(view.getBigUint64(16));
        const replacement = textPointer === null ? [] : readXimText(textPointer);
        if (replacement !== undefined && !applyPreeditChange(this.#preedit, first, length, replacement)) return;
        if (Number.isInteger(caret) && caret >= 0 && caret <= this.#preedit.length) this.#cursor = caret;
        this.#composing = true;
        this.#emitPreedit();
      } catch {
        this.#clearPreedit(true);
      }
    });
    const caret = new Deno.UnsafeCallback(PREEDIT_CALLBACK_DEFINITION, (_ic, _clientData, callData) => {
      try {
        if (callData === null) return;
        const view = new Deno.UnsafePointerView(callData);
        const direction = view.getInt32(4);
        this.#cursorVisible = view.getInt32(8) !== XIM_CARET_INVISIBLE;
        if (direction === XIM_ABSOLUTE_POSITION) {
          this.#cursor = Math.max(0, Math.min(this.#preedit.length, view.getInt32(0)));
          this.manager.writeCaretPosition(callData, this.#cursor);
        }
        this.#emitPreedit();
      } catch {
        this.#clearPreedit(true);
      }
    });
    this.#callbacks = [start, done, draw, caret];
    this.#callbackRecords = this.#callbacks.map(callbackRecord);

    return this.manager.createPreeditAttributes(this.#callbackRecords);
  }

  commit(text: string): void {
    this.#clearPreedit(true);
    this.#lastPreeditSignature = undefined;
    if (text.length > 0) this.manager.queue(this.window, { type: "ime", kind: "commit", text });
  }

  invalidateFromServer(): void {
    this.#serverInvalidated = true;
    this.#ic = null;
    this.#clearPreedit(true);
  }

  destroy(serverAlreadyDestroyed: boolean): void {
    const ic = this.#ic;
    this.#ic = null;
    if (ic !== null && !serverAlreadyDestroyed && !this.#serverInvalidated) {
      if (this.#nativeFocused && this.#enabled) this.manager.unfocusIc(ic);
      this.manager.destroyIc(ic);
    }
    this.#serverInvalidated = false;
    this.#closeCallbacks();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.manager.removeContext(this);
  }

  #emitPreedit(): void {
    const text = this.#preedit.join("");
    const cursorRange = this.#cursorVisible
      ? [utf8ByteOffset(this.#preedit, this.#cursor), utf8ByteOffset(this.#preedit, this.#cursor)] as const
      : undefined;
    const signature = `${text}\0${cursorRange?.[0] ?? -1}\0${cursorRange?.[1] ?? -1}`;
    if (signature === this.#lastPreeditSignature) return;
    this.#lastPreeditSignature = signature;
    const event: ImeEvent = { type: "ime", kind: "preedit", text };
    if (cursorRange !== undefined) event.cursorRange = cursorRange;
    this.manager.queue(this.window, event);
  }

  #clearPreedit(emit: boolean): void {
    const hadComposition = this.#composing || this.#preedit.length > 0;
    this.#composing = false;
    this.#preedit = [];
    this.#cursor = 0;
    this.#cursorVisible = true;
    if (emit && hadComposition) this.#emitPreedit();
  }

  #closeCallbacks(): void {
    for (const callback of this.#callbacks) callback.close();
    this.#callbacks = [];
    this.#callbackRecords = [];
  }
}
