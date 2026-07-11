import type { ImeEvent } from "../types.ts";
import {
  CompositionState,
  DeferredNativeError,
  discardTrailingPreeditClear,
  guardNativeCallback,
  ImeActivationState,
  type ImeCursorArea,
  normalizeImeCursorArea,
} from "../input/mod.ts";
import { logicalKeyFromKeysym, unicodeTextFromKeysym } from "../linux/mod.ts";
import { utf8CString as cString } from "../text_encoding.ts";
import { libcFunctions, x11functions } from "./ffi.ts";
import {
  callbackRecord,
  MAX_XIM_TEXT_BYTES,
  packXPoint,
  pointerFromAddress,
  readXimText,
} from "./xim_abi.ts";
import {
  applyPreeditChange,
  movePreeditCaret,
  preeditCursorByteOffset,
} from "./xim_preedit.ts";
import { fallbackLookupText } from "./input.ts";

type X11Library = Deno.DynamicLibrary<typeof x11functions>;
type X11Symbols = X11Library["symbols"];
type WithoutWindow<T> = T extends unknown ? Omit<T, "window"> : never;
export type XimEvent = WithoutWindow<ImeEvent>;
type QueueImeEvent = (window: bigint, event: XimEvent) => void;
type SelectInput = (window: bigint, extraMask: bigint) => void;
interface OwnedCallback {
  readonly pointer: Deno.PointerObject;
  close(): void;
}

const LC_CTYPE = 0;
const X_BUFFER_OVERFLOW = -1;
const X_LOOKUP_CHARS = 2;
const X_LOOKUP_KEYSYM = 3;
const X_LOOKUP_BOTH = 4;

const XIM_PREEDIT_CALLBACKS = 0x0002n;
const XIM_PREEDIT_POSITION = 0x0004n;
const XIM_PREEDIT_NOTHING = 0x0008n;
const XIM_PREEDIT_NONE = 0x0010n;
const XIM_STATUS_NOTHING = 0x0400n;
const XIM_STATUS_NONE = 0x0800n;
const XIM_PREEDIT_MASK = 0x001fn;
const XIM_STATUS_MASK = 0x0f00n;

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
type XimCallbackArguments = [
  Deno.PointerValue,
  Deno.PointerValue,
  Deno.PointerValue,
];

function pointerString(pointer: Deno.PointerValue): string | undefined {
  return pointer === null ? undefined : new Deno.UnsafePointerView(pointer).getCString();
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

export interface InputStyles {
  preedit: bigint;
  callbacks: boolean;
  positioned: boolean;
  none?: bigint;
}

/** Select styles by independently supported preedit and status capabilities. */
export function selectXimStyles(values: readonly bigint[], localeIsUtf8: boolean): InputStyles | undefined {
  const find = (preedit: bigint): bigint | undefined =>
    values.find((style) => {
      const status = style & XIM_STATUS_MASK;
      return (style & XIM_PREEDIT_MASK) === preedit &&
        (status === XIM_STATUS_NOTHING || status === XIM_STATUS_NONE);
    });

  const callback = localeIsUtf8 ? find(XIM_PREEDIT_CALLBACKS) : undefined;
  const position = find(XIM_PREEDIT_POSITION);
  const preedit = callback ?? position ?? find(XIM_PREEDIT_NOTHING) ?? find(XIM_PREEDIT_NONE);
  if (preedit === undefined) return undefined;
  return {
    preedit,
    callbacks: callback !== undefined && preedit === callback,
    positioned: position !== undefined && preedit === position,
    none: find(XIM_PREEDIT_NONE) ?? find(XIM_PREEDIT_NOTHING),
  };
}

/** Process-wide XIM owner. All calls are deliberately made on Deno's main thread. */
export class XimManager implements Disposable {
  readonly #x11: X11Symbols;
  readonly #display: Deno.PointerObject;
  readonly #queueEvent: QueueImeEvent;
  readonly #selectInput: SelectInput;
  readonly #libc: Deno.DynamicLibrary<typeof libcFunctions>;
  readonly #contexts = new Set<XimContext>();
  readonly #callbackErrors = new DeferredNativeError();
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
  readonly #previousLocale: string | undefined;
  readonly localeIsUtf8: boolean;

  constructor(
    X11: X11Library,
    display: Deno.PointerObject,
    libc: Deno.DynamicLibrary<typeof libcFunctions>,
    queueEvent: QueueImeEvent,
    selectInput: SelectInput,
  ) {
    this.#x11 = X11.symbols;
    this.#display = display;
    this.#queueEvent = queueEvent;
    this.#selectInput = selectInput;
    this.#libc = libc;

    this.#previousLocale = pointerString(this.#libc.symbols.setlocale(LC_CTYPE, null));
    const locale = this.#libc.symbols.setlocale(LC_CTYPE, cString(""));
    this.localeIsUtf8 = isUtf8Locale(pointerString(locale));

    this.#destroyCallback = new Deno.UnsafeCallback(
      XIM_LIFECYCLE_CALLBACK_DEFINITION,
      guardNativeCallback(
        this.#callbackErrors,
        () => {
          // Xlib has already invalidated the XIM and all XICs. Native
          // destruction here would be a UAF, so rebuild after callback return.
          this.#serverDestroyed = true;
          this.#rebuildPending = true;
          this.#im = null;
          this.#styles = undefined;
          for (const context of this.#contexts) context.invalidateFromServer();
        },
        () => undefined,
      ),
    );
    this.#destroyRecord = callbackRecord(this.#destroyCallback);

    this.#instantiateCallback = new Deno.UnsafeCallback(
      XIM_LIFECYCLE_CALLBACK_DEFINITION,
      guardNativeCallback(
        this.#callbackErrors,
        () => {
          this.#rebuildPending = true;
        },
        () => undefined,
      ),
    );

    if (locale !== null && this.#x11.XSupportsLocale() !== 0) this.#openInputMethod();
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

  queue(window: bigint, event: XimEvent): void {
    this.#queueEvent(window, event);
  }

  guardCallback<Arguments extends unknown[], Result>(
    callback: (...args: Arguments) => Result,
    fallback: (...args: Arguments) => Result,
  ): (...args: Arguments) => Result {
    return guardNativeCallback(this.#callbackErrors, callback, fallback);
  }

  throwIfCallbackFailed(): void {
    this.#callbackErrors.throwIfPending();
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

  filterEvent(event: Deno.PointerObject): boolean {
    // XIM filtering belongs to the display event stream, not to one active
    // XIC.  In particular, protocol traffic and IM-owned window events often
    // cannot be associated with a Winding window at all.
    return this.#x11.XFilterEvent(event, 0n) !== 0;
  }

  lookup(context: XimContext, event: Deno.PointerObject): XimLookupResult {
    const ic = context.ic;
    if (ic === null) {
      const buffer = new Uint8Array(64) as Uint8Array<ArrayBuffer>;
      const keysymBuffer = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
      const written = this.#x11.XLookupString(event, buffer, buffer.length, keysymBuffer, null);
      const keysym = keysymBuffer[0] === 0n ? BigInt(this.#x11.XLookupKeysym(event, 0)) : keysymBuffer[0];
      const bytes = written > 0 && written <= buffer.length ? buffer.subarray(0, written) : buffer.subarray(0, 0);
      const text = fallbackLookupText(bytes, unicodeTextFromKeysym(keysym));
      return {
        keysym,
        key: logicalKeyFromKeysym(keysym, text ?? ""),
        text,
      };
    }

    let buffer = new Uint8Array(64) as Uint8Array<ArrayBuffer>;
    const keysym = new BigUint64Array(1) as BigUint64Array<ArrayBuffer>;
    const status = new Int32Array(1) as Int32Array<ArrayBuffer>;
    let written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    if (status[0] === X_BUFFER_OVERFLOW) {
      if (written <= 0 || written > MAX_XIM_TEXT_BYTES) {
        const fallback = BigInt(this.#x11.XLookupKeysym(event, 0));
        return { keysym: fallback, key: logicalKeyFromKeysym(fallback) };
      }
      buffer = new Uint8Array(written) as Uint8Array<ArrayBuffer>;
      written = this.#x11.Xutf8LookupString(ic, event, buffer, buffer.length, keysym, status);
    }

    const hasChars = status[0] === X_LOOKUP_CHARS || status[0] === X_LOOKUP_BOTH;
    const hasKeysym = status[0] === X_LOOKUP_KEYSYM || status[0] === X_LOOKUP_BOTH;
    let text = "";
    if (hasChars && written > 0 && written <= buffer.length) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, written));
      } catch {
        text = "";
      }
    }
    const resolvedKeysym = hasKeysym ? keysym[0] : BigInt(this.#x11.XLookupKeysym(event, 0));
    return {
      keysym: resolvedKeysym,
      key: logicalKeyFromKeysym(resolvedKeysym, text),
      text: text.length > 0 ? text : undefined,
    };
  }

  createIc(context: XimContext): Deno.PointerObject | null {
    if (this.#im === null || this.#styles === undefined) return null;
    const style = context.enabled ? this.#styles.preedit : this.#styles.none;
    if (style === undefined) return null;
    let ic: Deno.PointerObject | null;

    if (context.enabled && this.#styles.callbacks) {
      const callbackAttributes = context.createCallbackAttributes();
      if (callbackAttributes === null) return null;
      try {
        ic = this.#x11.XCreateICWithPreeditAttributes(
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
    } else if (context.enabled && this.#styles.positioned) {
      const positionAttributes = this.#createPositionAttributes(context.cursorArea);
      if (positionAttributes === null) return null;
      try {
        ic = this.#x11.XCreateICWithPreeditAttributes(
          this.#im,
          XN_INPUT_STYLE,
          style,
          XN_CLIENT_WINDOW,
          context.window,
          XN_FOCUS_WINDOW,
          context.window,
          XN_PREEDIT_ATTRIBUTES,
          positionAttributes,
          null,
        );
      } finally {
        this.#x11.XFree(positionAttributes);
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

  resetIc(ic: Deno.PointerObject): void {
    const pendingText = this.#x11.Xutf8ResetIC(ic);
    // Reset text represents the composition being abandoned. The public blur
    // contract is cancellation, so discard it after releasing Xlib's storage.
    if (pendingText !== null) this.#x11.XFree(pendingText);
  }

  setArea(ic: Deno.PointerObject, area: ImeCursorArea): void {
    if (!this.#styles?.positioned) return;
    const attributes = this.#createPositionAttributes(area);
    if (attributes === null) return;
    try {
      const failedAttribute = this.#x11.XSetICValuesPreeditAttributes(
        ic,
        XN_PREEDIT_ATTRIBUTES,
        attributes,
        null,
      );
      if (failedAttribute !== null) {
        throw new Error(`winding(x11): failed to set XIM ${pointerString(failedAttribute) ?? "preedit geometry"}`);
      }
    } finally {
      this.#x11.XFree(attributes);
    }
  }

  #createPositionAttributes(area: ImeCursorArea | undefined): Deno.PointerObject | null {
    // XNSpotLocation is an insertion point whose y coordinate is the text
    // baseline. The public rectangle's lower edge is the closest portable
    // baseline available without font metrics.
    const spot = packXPoint(area?.x ?? 0, (area?.y ?? 0) + (area?.height ?? 0));
    return this.#x11.XVaCreateNestedListSpot(0, XN_SPOT_LOCATION, spot, null);
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
    const errors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const context of this.#contexts) {
      cleanup(() => context.destroy(this.#serverDestroyed));
    }
    this.#contexts.clear();
    const im = this.#im;
    if (im !== null && !this.#serverDestroyed) {
      cleanup(() => {
        this.#x11.XCloseIM(im);
      });
    }
    this.#im = null;
    if (this.#instantiateRegistered) {
      cleanup(() => {
        this.#x11.XUnregisterIMInstantiateCallback(
          this.#display,
          null,
          null,
          null,
          this.#instantiateCallback.pointer,
          null,
        );
      });
      this.#instantiateRegistered = false;
    }
    cleanup(() => this.#destroyCallback.close());
    cleanup(() => this.#instantiateCallback.close());
    const previousLocale = this.#previousLocale;
    if (previousLocale !== undefined) {
      cleanup(() => {
        this.#libc.symbols.setlocale(LC_CTYPE, cString(previousLocale));
      });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(x11): errors while closing XIM");
    }
  }

  #openInputMethod(): void {
    if (this.#closed) return;
    const candidates = ["", "@im=local", "@im="] as const;
    for (let index = 0; index < candidates.length; index++) {
      if (this.#x11.XSetLocaleModifiers(cString(candidates[index])) === null) continue;
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

      if (this.#x11.XSetIMValuesDestroyCallback(im, XN_DESTROY_CALLBACK, this.#destroyRecord, null) !== null) {
        this.#x11.XCloseIM(im);
        continue;
      }
      this.#im = im;
      this.#styles = styles;
      this.#usingFallback = index !== 0;
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
      const count = stylesView.getUint16(0);
      const valuesPointer = pointerFromAddress(stylesView.getBigUint64(8));
      if (valuesPointer === null) return undefined;
      const valuesView = new Deno.UnsafePointerView(valuesPointer);
      const values: bigint[] = [];
      for (let index = 0; index < count; index++) values.push(valuesView.getBigUint64(index * 8));
      return selectXimStyles(values, this.localeIsUtf8);
    } finally {
      this.#x11.XFree(stylesPointer);
    }
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
  readonly #activation = new ImeActivationState();
  readonly #composition = new CompositionState();
  #serverInvalidated = false;
  #preedit: string[] = [];
  #cursor = 0;
  #cursorVisible = true;
  #cursorArea: ImeCursorArea | undefined;
  #stagedEvents: XimEvent[] | null = null;
  #closed = false;

  constructor(manager: XimManager, window: bigint) {
    this.manager = manager;
    this.window = window;
  }

  get ic(): Deno.PointerObject | null {
    return this.#ic;
  }

  get enabled(): boolean {
    return this.#activation.desired;
  }

  get active(): boolean {
    return this.#activation.active;
  }

  get composing(): boolean {
    return this.#composition.active;
  }

  get cursorArea(): ImeCursorArea | undefined {
    return this.#cursorArea;
  }

  get hasStagedEvents(): boolean {
    return (this.#stagedEvents?.length ?? 0) > 0;
  }

  setEnabled(enabled: boolean): void {
    if (this.#activation.desired === enabled || this.#closed) return;
    if (!enabled) {
      if (this.#ic !== null && !this.#serverInvalidated) this.manager.resetIc(this.#ic);
      this.#clearPreedit(true);
    }
    if (this.#activation.active) {
      this.#activation.setDesired(false);
      this.#reconcileActivation();
    }
    this.#activation.setDesired(enabled);
    this.destroy(false);
    this.recreate();
  }

  setNativeFocused(focused: boolean): boolean {
    if (this.#activation.focused === focused || this.#closed) return false;
    if (!focused) {
      if (this.#ic !== null && !this.#serverInvalidated) this.manager.resetIc(this.#ic);
      this.#clearPreedit(true);
    }
    this.#activation.setFocused(focused);
    this.#reconcileActivation();
    return true;
  }

  setCursorArea(x: number, y: number, width: number, height: number): void {
    const area = normalizeImeCursorArea(x, y, width, height);
    if (area === undefined) return;
    this.#cursorArea = area;
    if (this.#ic !== null && this.#activation.active) this.manager.setArea(this.#ic, area);
  }

  recreate(_announce = false): void {
    if (this.#closed || this.#ic !== null) return;
    this.#serverInvalidated = false;
    this.#ic = this.manager.createIc(this);
    this.#activation.setAvailable(this.#ic !== null);
    this.#reconcileActivation();
  }

  createCallbackAttributes(): Deno.PointerObject | null {
    this.#closeCallbacks();
    const start = new Deno.UnsafeCallback(
      PREEDIT_START_DEFINITION,
      this.manager.guardCallback<XimCallbackArguments, number>(
        (_ic, _clientData, _callData) => {
          this.#composition.start();
          this.#preedit = [];
          this.#cursor = 0;
          this.#cursorVisible = true;
          this.#emitPreedit();
          return -1;
        },
        (_ic, _clientData, _callData) => {
          this.#resetAfterCallbackFailure();
          return -1;
        },
      ),
    );
    const done = new Deno.UnsafeCallback(
      PREEDIT_CALLBACK_DEFINITION,
      this.manager.guardCallback<XimCallbackArguments, void>(
        (_ic, _clientData, _callData) => this.#clearPreedit(true),
        (_ic, _clientData, _callData) => this.#resetAfterCallbackFailure(),
      ),
    );
    const draw = new Deno.UnsafeCallback(
      PREEDIT_CALLBACK_DEFINITION,
      this.manager.guardCallback<XimCallbackArguments, void>(
        (_ic, _clientData, callData) => {
          if (callData === null) return;
          const view = new Deno.UnsafePointerView(callData);
          const caret = view.getInt32(0);
          const first = view.getInt32(4);
          const length = view.getInt32(8);
          const textPointer = pointerFromAddress(view.getBigUint64(16));
          const replacement = textPointer === null ? [] : readXimText(textPointer);
          if (
            replacement !== undefined &&
            !applyPreeditChange(this.#preedit, first, length, replacement)
          ) return;
          if (Number.isInteger(caret) && caret >= 0 && caret <= this.#preedit.length) {
            this.#cursor = caret;
          }
          this.#composition.start();
          this.#emitPreedit();
        },
        (_ic, _clientData, _callData) => this.#resetAfterCallbackFailure(),
      ),
    );
    const caret = new Deno.UnsafeCallback(
      PREEDIT_CALLBACK_DEFINITION,
      this.manager.guardCallback<XimCallbackArguments, void>(
        (_ic, _clientData, callData) => {
          if (callData === null) return;
          const view = new Deno.UnsafePointerView(callData);
          const direction = view.getInt32(4);
          this.#cursorVisible = view.getInt32(8) !== XIM_CARET_INVISIBLE;
          this.#cursor = movePreeditCaret(this.#preedit, this.#cursor, direction, view.getInt32(0));
          this.manager.writeCaretPosition(callData, this.#cursor);
          this.#emitPreedit();
        },
        (_ic, _clientData, _callData) => this.#resetAfterCallbackFailure(),
      ),
    );
    this.#callbacks = [start, done, draw, caret];
    this.#callbackRecords = this.#callbacks.map(callbackRecord);

    return this.manager.createPreeditAttributes(this.#callbackRecords);
  }

  /** Stage callbacks fired synchronously by one Xutf8LookupString call. */
  beginLookup(): void {
    if (this.#closed) return;
    if (this.#stagedEvents !== null) throw new Error("winding(x11): nested XIM lookup");
    this.#stagedEvents = [];
  }

  /** Publish the completed lookup batch after its causative keydown has been queued. */
  finishLookup(): void {
    const events = this.#stagedEvents;
    this.#stagedEvents = null;
    if (events === null) return;
    for (const event of events) this.manager.queue(this.window, event);
  }

  commit(text: string): void {
    this.#clearPreedit(false);
    if (text.length === 0) return;
    if (this.#stagedEvents !== null) discardTrailingPreeditClear(this.#stagedEvents);
    this.#queue({ type: "ime", kind: "commit", text });
  }

  invalidateFromServer(): void {
    this.#serverInvalidated = true;
    this.#ic = null;
    this.#clearPreedit(true);
    this.#activation.setAvailable(false);
    const transition = this.#activation.forceInactive();
    if (transition !== undefined) this.#queue({ type: "ime", kind: transition });
  }

  destroy(serverAlreadyDestroyed: boolean): void {
    const ic = this.#ic;
    if (serverAlreadyDestroyed || this.#serverInvalidated) {
      this.#activation.setAvailable(false);
      this.#activation.forceInactive();
    } else {
      this.#activation.setAvailable(false);
      this.#reconcileActivation();
    }
    this.#ic = null;
    if (ic !== null && !serverAlreadyDestroyed && !this.#serverInvalidated) {
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
    this.#stagedEvents = null;
    this.manager.removeContext(this);
  }

  #emitPreedit(): void {
    const text = this.#preedit.join("");
    const cursor = preeditCursorByteOffset(this.#preedit, this.#cursor);
    const cursorRange = this.#cursorVisible && cursor !== undefined ? [cursor, cursor] as const : null;
    const update = this.#composition.update(text, cursorRange);
    if (update !== undefined) {
      this.#queue({ type: "ime", kind: "preedit", ...update });
    }
  }

  #clearPreedit(emit: boolean): void {
    const update = emit ? this.#composition.cancel() : undefined;
    if (!emit) this.#composition.commit();
    this.#preedit = [];
    this.#cursor = 0;
    this.#cursorVisible = true;
    if (update !== undefined) {
      this.#queue({ type: "ime", kind: "preedit", ...update });
    }
  }

  #reconcileActivation(): void {
    const transition = this.#activation.reconcile({
      activate: () => {
        if (this.#ic === null || this.#closed) return false;
        if (this.#cursorArea !== undefined) this.manager.setArea(this.#ic, this.#cursorArea);
        this.manager.focusIc(this.#ic);
        return true;
      },
      deactivate: () => {
        if (this.#ic !== null && !this.#serverInvalidated) this.manager.unfocusIc(this.#ic);
      },
    });
    if (transition !== undefined) this.#queue({ type: "ime", kind: transition });
  }

  #queue(event: XimEvent): void {
    if (this.#closed) return;
    if (this.#stagedEvents !== null) this.#stagedEvents.push(event);
    else this.manager.queue(this.window, event);
  }

  #closeCallbacks(): void {
    for (const callback of this.#callbacks) callback.close();
    this.#callbacks = [];
    this.#callbackRecords = [];
  }

  #resetAfterCallbackFailure(): void {
    this.#composition.reset();
    this.#preedit = [];
    this.#cursor = 0;
    this.#cursorVisible = false;
  }
}
