import { DeferredNativeError, guardNativeCallback } from "../input/mod.ts";
import {
  makeNSRange,
  NS_NOT_FOUND,
  NSPOINT,
  NSRANGE,
  NSRECT,
  OBJC_BOOL_ENCODING,
  readNSRange,
  writeNSRange,
} from "./ffi.ts";

const NS_RANGE_ENCODING = "{_NSRange=QQ}";
const NS_POINT_ENCODING = "{CGPoint=dd}";
const NS_RECT_ENCODING = "{CGRect={CGPoint=dd}{CGSize=dd}}";

type AnyCallback = { pointer: Deno.PointerObject; close(): void };

export interface NativeRange {
  location: number | bigint;
  length: number | bigint;
}

/**
 * The narrow surface exposed by a Darwin window to the Objective-C bridge.
 * Keeping this interface free of DarwinWindow makes class registration and
 * callback lifetime management independent from window/render ownership.
 */
export interface DarwinNativeResponder {
  handleNativeWindowEvent(
    kind:
      | "close"
      | "resize"
      | "mouseenter"
      | "mouseleave"
      | "focus"
      | "blur"
      | "hidden"
      | "visible",
  ): void;
  handleNativeKeyEvent(
    kind: "keydown" | "keyup" | "flagschanged",
    event: Deno.PointerValue,
  ): void;
  handleNativePointerEvent(event: Deno.PointerValue): void;
  handleNativeInsertText(
    text: Deno.PointerValue,
    replacementLocation: bigint,
    replacementLength: bigint,
  ): void;
  handleNativeSetMarkedText(
    text: Deno.PointerValue,
    selectionLocation: bigint,
    selectionLength: bigint,
    replacementLocation: bigint,
    replacementLength: bigint,
  ): void;
  handleNativeUnmarkText(): void;
  handleNativeCommand(command: Deno.PointerValue): void;
  readonly nativeHasMarkedText: boolean;
  readonly nativeMarkedRange: NativeRange;
  readonly nativeSelectedRange: NativeRange;
  nativeValidAttributes(): Deno.PointerValue;
  nativeFirstRectForCharacterRange(): Uint8Array;
}

/** Only the Objective-C registration operations needed by this module. */
export interface NativeClassRuntime {
  getClass(name: string): Deno.PointerObject;
  sel(name: string): Deno.PointerValue;
  allocateClassPair(superclass: Deno.PointerObject, name: string): Deno.PointerObject;
  getProtocol(name: string): Deno.PointerObject;
  addProtocol(cls: Deno.PointerObject, protocol: Deno.PointerObject): void;
  registerClassPair(cls: Deno.PointerObject): void;
  addMethod(
    cls: Deno.PointerObject,
    selector: Deno.PointerValue,
    implementation: Deno.PointerValue,
    typeEncoding: string,
  ): void;
}

function pointerId(pointer: Deno.PointerValue): bigint {
  if (pointer === null) throw new TypeError("winding(darwin): null Objective-C instance");
  return BigInt(Deno.UnsafePointer.value(pointer));
}

function writeRangePointer(
  pointer: Deno.PointerValue,
  location: bigint,
  length: bigint,
): void {
  if (pointer === null) return;
  const memory = new Uint8Array(new Deno.UnsafePointerView(pointer).getArrayBuffer(16));
  writeNSRange(memory, { location, length });
}

/**
 * Process-lifetime Objective-C classes and their retained IMP callbacks.
 * Objective-C owns the registered IMP pointers forever, so callbacks are
 * deliberately retained for the process lifetime and are never closed.
 */
export class DarwinNativeClasses {
  readonly delegate: Deno.PointerObject;
  readonly contentView: Deno.PointerObject;
  readonly #errors = new DeferredNativeError();
  readonly #delegates = new Map<bigint, DarwinNativeResponder>();
  readonly #views = new Map<bigint, DarwinNativeResponder>();
  readonly #callbacks: AnyCallback[] = [];

  constructor(runtime: NativeClassRuntime) {
    const { addMethod, addProtocol, allocateClassPair, getClass, getProtocol, registerClassPair, sel } = runtime;

    const shouldClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "bool" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => {
          this.#delegate(self)?.handleNativeWindowEvent("close");
          return false;
        },
        () => false,
      ),
    );
    const didResize = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("resize"),
        () => undefined,
      ),
    );
    const mouseEntered = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("mouseenter"),
        () => undefined,
      ),
    );
    const mouseExited = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("mouseleave"),
        () => undefined,
      ),
    );
    const didBecomeKey = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("focus"),
        () => undefined,
      ),
    );
    const didResignKey = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("blur"),
        () => undefined,
      ),
    );
    const didMiniaturize = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("hidden"),
        () => undefined,
      ),
    );
    const didDeminiaturize = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("visible"),
        () => undefined,
      ),
    );
    this.#callbacks.push(
      shouldClose,
      didResize,
      mouseEntered,
      mouseExited,
      didBecomeKey,
      didResignKey,
      didMiniaturize,
      didDeminiaturize,
    );

    const delegate = allocateClassPair(getClass("NSObject"), "WindingWindowDelegate");
    addMethod(delegate, sel("windowShouldClose:"), shouldClose.pointer, `${OBJC_BOOL_ENCODING}@:@`);
    addMethod(delegate, sel("windowDidResize:"), didResize.pointer, "v@:@");
    addMethod(delegate, sel("mouseEntered:"), mouseEntered.pointer, "v@:@");
    addMethod(delegate, sel("mouseExited:"), mouseExited.pointer, "v@:@");
    addMethod(delegate, sel("windowDidBecomeKey:"), didBecomeKey.pointer, "v@:@");
    addMethod(delegate, sel("windowDidResignKey:"), didResignKey.pointer, "v@:@");
    addMethod(delegate, sel("windowDidMiniaturize:"), didMiniaturize.pointer, "v@:@");
    addMethod(delegate, sel("windowDidDeminiaturize:"), didDeminiaturize.pointer, "v@:@");
    registerClassPair(delegate);
    this.delegate = delegate;

    const acceptsFirstResponder = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "bool" },
      guardNativeCallback(this.#errors, () => true, () => false),
    );
    const keyDown = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, event: Deno.PointerValue) =>
          this.#view(self)?.handleNativeKeyEvent("keydown", event),
        () => undefined,
      ),
    );
    const keyUp = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, event: Deno.PointerValue) =>
          this.#view(self)?.handleNativeKeyEvent("keyup", event),
        () => undefined,
      ),
    );
    const flagsChanged = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, event: Deno.PointerValue) =>
          this.#view(self)?.handleNativeKeyEvent("flagschanged", event),
        () => undefined,
      ),
    );
    const pointerEvent = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, event: Deno.PointerValue) =>
          this.#view(self)?.handleNativePointerEvent(event),
        () => undefined,
      ),
    );
    const insertText = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer", NSRANGE], result: "void" },
      guardNativeCallback(
        this.#errors,
        (
          self: Deno.PointerValue,
          _cmd: Deno.PointerValue,
          text: Deno.PointerValue,
          replacement: Uint8Array,
        ) => {
          const range = readNSRange(replacement);
          this.#view(self)?.handleNativeInsertText(text, range.location, range.length);
        },
        () => undefined,
      ),
    );
    const setMarkedText = new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "pointer", "pointer", NSRANGE, NSRANGE],
        result: "void",
      },
      guardNativeCallback(
        this.#errors,
        (
          self: Deno.PointerValue,
          _cmd: Deno.PointerValue,
          text: Deno.PointerValue,
          selection: Uint8Array,
          replacement: Uint8Array,
        ) => {
          const selectedRange = readNSRange(selection);
          const replacementRange = readNSRange(replacement);
          this.#view(self)?.handleNativeSetMarkedText(
            text,
            selectedRange.location,
            selectedRange.length,
            replacementRange.location,
            replacementRange.length,
          );
        },
        () => undefined,
      ),
    );
    const unmarkText = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#view(self)?.handleNativeUnmarkText(),
        () => undefined,
      ),
    );
    const hasMarkedText = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "bool" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#view(self)?.nativeHasMarkedText ?? false,
        () => false,
      ),
    );
    const markedRange = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: NSRANGE },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => {
          const range = this.#view(self)?.nativeMarkedRange ?? {
            location: NS_NOT_FOUND,
            length: 0n,
          };
          return makeNSRange(range.location, range.length);
        },
        () => makeNSRange(NS_NOT_FOUND, 0n),
      ),
    );
    const selectedRange = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: NSRANGE },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => {
          const range = this.#view(self)?.nativeSelectedRange ?? {
            location: NS_NOT_FOUND,
            length: 0n,
          };
          return makeNSRange(range.location, range.length);
        },
        () => makeNSRange(NS_NOT_FOUND, 0n),
      ),
    );
    const validAttributes = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "pointer" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#view(self)?.nativeValidAttributes() ?? null,
        () => null,
      ),
    );
    const attributedSubstring = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", NSRANGE, "pointer"], result: "pointer" },
      guardNativeCallback(
        this.#errors,
        (
          _self: Deno.PointerValue,
          _cmd: Deno.PointerValue,
          _range: Uint8Array,
          actualRange: Deno.PointerValue,
        ) => {
          writeRangePointer(actualRange, NS_NOT_FOUND, 0n);
          return null;
        },
        () => null,
      ),
    );
    const characterIndexForPoint = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", NSPOINT], result: "usize" },
      guardNativeCallback(this.#errors, () => NS_NOT_FOUND, () => NS_NOT_FOUND),
    );
    const firstRect = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", NSRANGE, "pointer"], result: NSRECT },
      guardNativeCallback(
        this.#errors,
        (
          self: Deno.PointerValue,
          _cmd: Deno.PointerValue,
          _range: Uint8Array,
          actualRange: Deno.PointerValue,
        ) => {
          writeRangePointer(actualRange, NS_NOT_FOUND, 0n);
          return this.#view(self)?.nativeFirstRectForCharacterRange() ?? new Uint8Array(32);
        },
        () => new Uint8Array(32),
      ),
    );
    const doCommand = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, command: Deno.PointerValue) =>
          this.#view(self)?.handleNativeCommand(command),
        () => undefined,
      ),
    );
    this.#callbacks.push(
      acceptsFirstResponder,
      keyDown,
      keyUp,
      flagsChanged,
      pointerEvent,
      insertText,
      setMarkedText,
      unmarkText,
      hasMarkedText,
      markedRange,
      selectedRange,
      validAttributes,
      attributedSubstring,
      characterIndexForPoint,
      firstRect,
      doCommand,
    );

    const contentView = allocateClassPair(getClass("NSView"), "WindingContentView");
    addProtocol(contentView, getProtocol("NSTextInputClient"));
    addMethod(
      contentView,
      sel("acceptsFirstResponder"),
      acceptsFirstResponder.pointer,
      `${OBJC_BOOL_ENCODING}@:`,
    );
    addMethod(contentView, sel("keyDown:"), keyDown.pointer, "v@:@");
    addMethod(contentView, sel("keyUp:"), keyUp.pointer, "v@:@");
    addMethod(contentView, sel("flagsChanged:"), flagsChanged.pointer, "v@:@");
    for (const selector of POINTER_INPUT_SELECTORS) {
      addMethod(contentView, sel(selector), pointerEvent.pointer, "v@:@");
    }
    addMethod(
      contentView,
      sel("insertText:replacementRange:"),
      insertText.pointer,
      `v@:@${NS_RANGE_ENCODING}`,
    );
    addMethod(
      contentView,
      sel("setMarkedText:selectedRange:replacementRange:"),
      setMarkedText.pointer,
      `v@:@${NS_RANGE_ENCODING}${NS_RANGE_ENCODING}`,
    );
    addMethod(contentView, sel("unmarkText"), unmarkText.pointer, "v@:");
    addMethod(contentView, sel("hasMarkedText"), hasMarkedText.pointer, `${OBJC_BOOL_ENCODING}@:`);
    addMethod(contentView, sel("markedRange"), markedRange.pointer, `${NS_RANGE_ENCODING}@:`);
    addMethod(contentView, sel("selectedRange"), selectedRange.pointer, `${NS_RANGE_ENCODING}@:`);
    addMethod(contentView, sel("validAttributesForMarkedText"), validAttributes.pointer, "@@:");
    addMethod(
      contentView,
      sel("attributedSubstringForProposedRange:actualRange:"),
      attributedSubstring.pointer,
      `@@:${NS_RANGE_ENCODING}^${NS_RANGE_ENCODING}`,
    );
    addMethod(
      contentView,
      sel("characterIndexForPoint:"),
      characterIndexForPoint.pointer,
      `Q@:${NS_POINT_ENCODING}`,
    );
    addMethod(
      contentView,
      sel("firstRectForCharacterRange:actualRange:"),
      firstRect.pointer,
      `${NS_RECT_ENCODING}@:${NS_RANGE_ENCODING}^${NS_RANGE_ENCODING}`,
    );
    addMethod(contentView, sel("doCommandBySelector:"), doCommand.pointer, "v@::");
    registerClassPair(contentView);
    this.contentView = contentView;
  }

  registerDelegate(pointer: Deno.PointerValue, responder: DarwinNativeResponder): void {
    this.#delegates.set(pointerId(pointer), responder);
  }

  unregisterDelegate(pointer: Deno.PointerValue): void {
    if (pointer !== null) this.#delegates.delete(pointerId(pointer));
  }

  registerView(pointer: Deno.PointerValue, responder: DarwinNativeResponder): void {
    this.#views.set(pointerId(pointer), responder);
  }

  unregisterView(pointer: Deno.PointerValue): void {
    if (pointer !== null) this.#views.delete(pointerId(pointer));
  }

  throwIfCallbackFailed(): void {
    this.#errors.throwIfPending();
  }

  #delegate(pointer: Deno.PointerValue): DarwinNativeResponder | undefined {
    return pointer === null ? undefined : this.#delegates.get(pointerId(pointer));
  }

  #view(pointer: Deno.PointerValue): DarwinNativeResponder | undefined {
    return pointer === null ? undefined : this.#views.get(pointerId(pointer));
  }
}

/** Pointer responders implemented by WindingContentView for AppKit hit-testing. */
export const POINTER_INPUT_SELECTORS = [
  "mouseDown:",
  "mouseUp:",
  "rightMouseDown:",
  "rightMouseUp:",
  "otherMouseDown:",
  "otherMouseUp:",
  "mouseMoved:",
  "mouseDragged:",
  "rightMouseDragged:",
  "otherMouseDragged:",
  "scrollWheel:",
] as const;

let nativeClasses: DarwinNativeClasses | undefined;

export function ensureNativeClasses(runtime: NativeClassRuntime): DarwinNativeClasses {
  return nativeClasses ??= new DarwinNativeClasses(runtime);
}
