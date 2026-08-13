import { DeferredNativeError, guardNativeCallback } from "../input/mod.ts";
import { logicalKeyFromKeysym, unicodeTextFromKeysym } from "../linux/mod.ts";
import { utf8CString as cString } from "../text_encoding.ts";
import { libcFunctions, x11functions } from "./ffi.ts";
import { fallbackLookupText } from "./input.ts";

type X11Library = Deno.DynamicLibrary<typeof x11functions>;
type X11Symbols = X11Library["symbols"];
type SelectInput = (window: bigint, extraMask: bigint) => void;

const LC_CTYPE = 0;
const MAX_STYLES = 64;
const MAX_XIM_TEXT_BYTES = 1024 * 1024;
const X_BUFFER_OVERFLOW = -1;
const X_LOOKUP_CHARS = 2;
const X_LOOKUP_KEYSYM = 3;
const X_LOOKUP_BOTH = 4;
const XIM_PREEDIT_NOTHING = 0x0008n;
const XIM_PREEDIT_NONE = 0x0010n;
const XIM_STATUS_NOTHING = 0x0400n;
const XIM_STATUS_NONE = 0x0800n;
const NOTHING_STYLE = XIM_PREEDIT_NOTHING | XIM_STATUS_NOTHING;
const NONE_STYLE = XIM_PREEDIT_NONE | XIM_STATUS_NONE;
const XN_QUERY_INPUT_STYLE = cString("queryInputStyle");
const XN_INPUT_STYLE = cString("inputStyle");
const XN_CLIENT_WINDOW = cString("clientWindow");
const XN_FOCUS_WINDOW = cString("focusWindow");
const XN_DESTROY_CALLBACK = cString("destroyCallback");
const XN_FILTER_EVENTS = cString("filterEvents");
const DESTROY_CALLBACK_DEFINITION = {
  parameters: ["pointer", "pointer", "pointer"],
  result: "void",
} as const;

function pointerString(pointer: Deno.PointerValue): string | undefined {
  return pointer === null ? undefined : new Deno.UnsafePointerView(pointer).getCString();
}

function pointerFromAddress(address: bigint): Deno.PointerObject | null {
  return address === 0n ? null : Deno.UnsafePointer.create(address);
}

function isUtf8Locale(locale: string | undefined): boolean {
  if (locale === undefined) return false;
  const normalized = locale.toLowerCase().replaceAll("_", "-");
  return normalized.includes("utf-8") || normalized.includes("utf8");
}

export interface XimLookupResult {
  key?: string;
  text?: string;
  keysym: bigint;
}

/** A commit-only XIM owner. Server loss permanently switches this instance to XLookupString. */
export class XimManager implements Disposable {
  readonly #x11: X11Symbols;
  readonly #display: Deno.PointerObject;
  readonly #selectInput: SelectInput;
  readonly #contexts = new Set<XimContext>();
  readonly #callbackErrors = new DeferredNativeError();
  readonly #destroyCallback: Deno.UnsafeCallback<typeof DESTROY_CALLBACK_DEFINITION>;
  readonly #destroyRecord: BigUint64Array<ArrayBuffer>;
  #im: Deno.PointerObject | null = null;
  #style: bigint | undefined;
  #serverDestroyed = false;
  #closed = false;
  readonly localeIsUtf8: boolean;

  constructor(
    X11: X11Library,
    display: Deno.PointerObject,
    libc: Deno.DynamicLibrary<typeof libcFunctions>,
    selectInput: SelectInput,
  ) {
    this.#x11 = X11.symbols;
    this.#display = display;
    this.#selectInput = selectInput;
    const locale = libc.symbols.setlocale(LC_CTYPE, cString(""));
    this.localeIsUtf8 = isUtf8Locale(pointerString(locale));
    this.#destroyCallback = new Deno.UnsafeCallback(
      DESTROY_CALLBACK_DEFINITION,
      guardNativeCallback(
        this.#callbackErrors,
        () => {
          this.#serverDestroyed = true;
          this.#im = null;
          this.#style = undefined;
          for (const context of this.#contexts) context.invalidateFromServer();
        },
        () => undefined,
      ),
    );
    this.#destroyRecord = new BigUint64Array([
      0n,
      BigInt(Deno.UnsafePointer.value(this.#destroyCallback.pointer)),
    ]) as BigUint64Array<ArrayBuffer>;
    if (locale !== null && this.localeIsUtf8 && this.#x11.XSupportsLocale() !== 0) {
      this.#openInputMethod();
    }
  }

  createContext(window: bigint): XimContext {
    const context = new XimContext(this, window);
    this.#contexts.add(context);
    context.recreate();
    return context;
  }

  removeContext(context: XimContext): void {
    if (!this.#contexts.delete(context)) return;
    context.destroy(this.#serverDestroyed);
  }

  filterEvent(event: Deno.PointerObject, context: XimContext): boolean {
    return context.ic !== null && this.#x11.XFilterEvent(event, context.window) !== 0;
  }

  lookup(context: XimContext, event: Deno.PointerObject): XimLookupResult {
    const ic = context.ic;
    if (ic === null) return this.#fallbackLookup(event);

    let buffer = new Uint8Array(64) as Uint8Array<ArrayBuffer>;
    const keysym = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    const status = new Int32Array(1) as Int32Array<ArrayBuffer>;
    let written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    if (status[0] === X_BUFFER_OVERFLOW) {
      if (written <= 0 || written > MAX_XIM_TEXT_BYTES) return this.#fallbackLookup(event);
      buffer = new Uint8Array(written) as Uint8Array<ArrayBuffer>;
      written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    }
    const hasChars = status[0] === X_LOOKUP_CHARS || status[0] === X_LOOKUP_BOTH;
    const hasKeysym = status[0] === X_LOOKUP_KEYSYM || status[0] === X_LOOKUP_BOTH;
    let text: string | undefined;
    if (hasChars && written > 0 && written <= buffer.length) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, written));
      } catch {
        text = undefined;
      }
    }
    const resolvedKeysym = hasKeysym ? keysym[0] : BigInt(this.#x11.XLookupKeysym(event, 0));
    return { keysym: resolvedKeysym, key: logicalKeyFromKeysym(resolvedKeysym, text ?? ""), text };
  }

  createIc(context: XimContext): Deno.PointerObject | null {
    if (this.#im === null || this.#style === undefined || this.#serverDestroyed) return null;
    const ic = this.#x11.XCreateICSimple(
      this.#im,
      XN_INPUT_STYLE,
      this.#style,
      XN_CLIENT_WINDOW,
      context.window,
      XN_FOCUS_WINDOW,
      context.window,
      null,
    );
    if (ic !== null) {
      const filterMask = new BigInt64Array(1) as BigInt64Array<ArrayBuffer>;
      if (this.#x11.XGetICValuesFilterEvents(ic, XN_FILTER_EVENTS, filterMask, null) === null) {
        this.#selectInput(context.window, filterMask[0]);
      }
    }
    return ic;
  }

  focusIc(ic: Deno.PointerObject): void {
    this.#x11.XSetICFocus(ic);
  }

  unfocusIc(ic: Deno.PointerObject): void {
    this.#x11.XUnsetICFocus(ic);
  }

  destroyIc(ic: Deno.PointerObject): void {
    this.#x11.XDestroyIC(ic);
  }

  throwIfCallbackFailed(): void {
    this.#callbackErrors.throwIfPending();
  }

  processDeferred(): void {}

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    for (const context of this.#contexts) {
      try {
        context.destroy(this.#serverDestroyed);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#contexts.clear();
    const im = this.#im;
    this.#im = null;
    if (im !== null && !this.#serverDestroyed) {
      try {
        this.#x11.XCloseIM(im);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#destroyCallback.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "winding(x11): errors while closing XIM");
  }

  #fallbackLookup(event: Deno.PointerObject): XimLookupResult {
    const buffer = new Uint8Array(64) as Uint8Array<ArrayBuffer>;
    const keysymBuffer = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    const written = this.#x11.XLookupString(event, buffer, buffer.length, keysymBuffer, null);
    const keysym = keysymBuffer[0] === 0n ? BigInt(this.#x11.XLookupKeysym(event, 0)) : keysymBuffer[0];
    const bytes = written > 0 && written <= buffer.length ? buffer.subarray(0, written) : buffer.subarray(0, 0);
    const text = fallbackLookupText(bytes, unicodeTextFromKeysym(keysym));
    return { keysym, key: logicalKeyFromKeysym(keysym, text ?? ""), text };
  }

  #openInputMethod(): void {
    for (const candidate of ["", "@im=local", "@im="]) {
      if (this.#x11.XSetLocaleModifiers(cString(candidate)) === null) continue;
      const im = this.#x11.XOpenIM(this.#display, null, null, null);
      if (im === null) continue;
      const style = this.#queryStyle(im);
      if (
        style === undefined ||
        this.#x11.XSetIMValuesDestroyCallback(im, XN_DESTROY_CALLBACK, this.#destroyRecord, null) !== null
      ) {
        this.#x11.XCloseIM(im);
        continue;
      }
      this.#im = im;
      this.#style = style;
      return;
    }
  }

  #queryStyle(im: Deno.PointerObject): bigint | undefined {
    const output = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    if (this.#x11.XGetIMValuesQueryInputStyle(im, XN_QUERY_INPUT_STYLE, output, null) !== null) return undefined;
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
      return values.has(NOTHING_STYLE) ? NOTHING_STYLE : values.has(NONE_STYLE) ? NONE_STYLE : undefined;
    } finally {
      this.#x11.XFree(stylesPointer);
    }
  }
}

export class XimContext implements Disposable {
  #ic: Deno.PointerObject | null = null;
  #focused = false;
  #serverInvalidated = false;
  #closed = false;

  constructor(readonly manager: XimManager, readonly window: bigint) {}

  get ic(): Deno.PointerObject | null {
    return this.#ic;
  }

  recreate(): void {
    if (this.#closed || this.#ic !== null || this.#serverInvalidated) return;
    this.#ic = this.manager.createIc(this);
    if (this.#ic !== null && this.#focused) this.manager.focusIc(this.#ic);
  }

  setNativeFocused(focused: boolean): void {
    if (this.#focused === focused || this.#closed) return;
    this.#focused = focused;
    if (this.#ic === null) return;
    if (focused) this.manager.focusIc(this.#ic);
    else this.manager.unfocusIc(this.#ic);
  }

  invalidateFromServer(): void {
    this.#serverInvalidated = true;
    this.#ic = null;
  }

  destroy(serverAlreadyDestroyed: boolean): void {
    const ic = this.#ic;
    this.#ic = null;
    if (ic !== null && !serverAlreadyDestroyed && !this.#serverInvalidated) this.manager.destroyIc(ic);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.manager.removeContext(this);
  }
}
