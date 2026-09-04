import { DeferredNativeError, guardNativeCallback } from "../input/mod.ts";
import { NSRANGE, OBJC_BOOL_ENCODING } from "./ffi.ts";

const NS_RANGE_ENCODING = "{_NSRange=QQ}";

type AnyCallback = { pointer: Deno.PointerObject; close(): void };

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
      | "visible"
      | "fullscreen-entered"
      | "fullscreen-exited"
      | "fullscreen-enter-failed"
      | "fullscreen-exit-failed",
  ): void;
  handleNativeKeyEvent(
    kind: "keydown" | "keyup" | "flagschanged",
    event: Deno.PointerValue,
  ): void;
  handleNativeInsertText(text: Deno.PointerValue): void;
  handleNativeCommand(command: Deno.PointerValue): void;
}

/** Only the Objective-C registration operations needed by this module. */
export interface NativeClassRuntime {
  getClass(name: string): Deno.PointerObject;
  sel(name: string): Deno.PointerValue;
  allocateClassPair(superclass: Deno.PointerObject, name: string): Deno.PointerObject;
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
    const { addMethod, allocateClassPair, getClass, registerClassPair, sel } = runtime;

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
    const didEnterFullscreen = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("fullscreen-entered"),
        () => undefined,
      ),
    );
    const didExitFullscreen = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("fullscreen-exited"),
        () => undefined,
      ),
    );
    const didFailToEnterFullscreen = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("fullscreen-enter-failed"),
        () => undefined,
      ),
    );
    const didFailToExitFullscreen = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue) => this.#delegate(self)?.handleNativeWindowEvent("fullscreen-exit-failed"),
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
      didEnterFullscreen,
      didExitFullscreen,
      didFailToEnterFullscreen,
      didFailToExitFullscreen,
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
    addMethod(delegate, sel("windowDidEnterFullScreen:"), didEnterFullscreen.pointer, "v@:@");
    addMethod(delegate, sel("windowDidExitFullScreen:"), didExitFullscreen.pointer, "v@:@");
    addMethod(delegate, sel("windowDidFailToEnterFullScreen:"), didFailToEnterFullscreen.pointer, "v@:@");
    addMethod(delegate, sel("windowDidFailToExitFullScreen:"), didFailToExitFullscreen.pointer, "v@:@");
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
    const insertText = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer", NSRANGE], result: "void" },
      guardNativeCallback(
        this.#errors,
        (self: Deno.PointerValue, _cmd: Deno.PointerValue, text: Deno.PointerValue) =>
          this.#view(self)?.handleNativeInsertText(text),
        () => undefined,
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
      insertText,
      doCommand,
    );

    const contentView = allocateClassPair(getClass("NSView"), "WindingContentView");
    addMethod(
      contentView,
      sel("acceptsFirstResponder"),
      acceptsFirstResponder.pointer,
      `${OBJC_BOOL_ENCODING}@:`,
    );
    addMethod(contentView, sel("keyDown:"), keyDown.pointer, "v@:@");
    addMethod(contentView, sel("keyUp:"), keyUp.pointer, "v@:@");
    addMethod(contentView, sel("flagsChanged:"), flagsChanged.pointer, "v@:@");
    addMethod(
      contentView,
      sel("insertText:replacementRange:"),
      insertText.pointer,
      `v@:@${NS_RANGE_ENCODING}`,
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

let nativeClasses: DarwinNativeClasses | undefined;

export function ensureNativeClasses(runtime: NativeClassRuntime): DarwinNativeClasses {
  return nativeClasses ??= new DarwinNativeClasses(runtime);
}
