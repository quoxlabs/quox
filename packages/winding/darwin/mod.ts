import type { KeyEvent, KeyModifiers, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { getDomCode } from "./dom_code.ts";
import { DarwinInputState } from "./input_state.ts";
import {
  addMethod as runtimeAddMethod,
  addProtocol as runtimeAddProtocol,
  allocateClassPair as runtimeAllocateClassPair,
  APPKIT,
  cfSymbols,
  cgSymbols,
  CORE_FOUNDATION,
  CORE_GRAPHICS,
  cStr,
  getClass as runtimeGetClass,
  getProtocol as runtimeGetProtocol,
  LIBOBJC,
  makeNSRange,
  NS_NOT_FOUND,
  NSPOINT,
  NSRANGE,
  NSRECT,
  OBJC_BOOL_ENCODING,
  type ObjcRuntime,
  openNSRectMsgSend,
  readCFString,
  readNSRange,
  readStructF64,
  RGBA_BITMAP_INFO,
  runtimeSymbols,
  sel as runtimeSel,
  selectorName as runtimeSelectorName,
  writeNSRange,
} from "./ffi.ts";
import { cocoaRectFromClient, keyLocationForCode, logicalKeyForEvent, printableText } from "./text_input.ts";

// NSWindowStyleMask: Titled | Closable | Resizable | Miniaturizable
const NS_WINDOW_STYLE_MASK = 1 | 2 | 8 | 4;
const NS_BACKING_STORE_BUFFERED = 2n;
const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0n;
const NS_EVENT_MASK_ANY = 0xFFFFFFFFFFFFFFFFn;
const NS_EVENT_MODIFIER_FLAG_CAPS_LOCK = 1n << 16n;
const NS_EVENT_MODIFIER_FLAG_SHIFT = 1n << 17n;
const NS_EVENT_MODIFIER_FLAG_CONTROL = 1n << 18n;
const NS_EVENT_MODIFIER_FLAG_OPTION = 1n << 19n;
const NS_EVENT_MODIFIER_FLAG_COMMAND = 1n << 20n;
const NS_RANGE_ENCODING = "{_NSRange=QQ}";
const NS_POINT_ENCODING = "{CGPoint=dd}";
const NS_RECT_ENCODING = "{CGRect={CGPoint=dd}{CGSize=dd}}";
// NSTrackingAreaOptions: MouseEnteredAndExited | ActiveInKeyWindow | InVisibleRect. The rect
// passed to `initWithRect:` is ignored when InVisibleRect is set — AppKit tracks the owning
// view's visible rect automatically, so the area stays correct across resizes for free.
const NS_TRACKING_AREA_OPTIONS = 0x01 | 0x20 | 0x200;

function modifierFlagForCode(code: string): bigint | undefined {
  switch (code) {
    case "CapsLock":
      return NS_EVENT_MODIFIER_FLAG_CAPS_LOCK;
    case "ShiftLeft":
    case "ShiftRight":
      return NS_EVENT_MODIFIER_FLAG_SHIFT;
    case "ControlLeft":
    case "ControlRight":
      return NS_EVENT_MODIFIER_FLAG_CONTROL;
    case "AltLeft":
    case "AltRight":
      return NS_EVENT_MODIFIER_FLAG_OPTION;
    case "MetaLeft":
    case "MetaRight":
      return NS_EVENT_MODIFIER_FLAG_COMMAND;
    default:
      return undefined;
  }
}

type Closeable = { close(): void };

function openMsgSend<
  const P extends readonly Deno.NativeType[],
  const R extends Deno.NativeResultType,
>(libraries: Closeable[], parameters: P, result: R) {
  const lib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: { parameters, result },
    } as const,
  );
  libraries.push(lib);
  return lib.symbols.objc_msgSend;
}

function openMsgSendSymbols(libraries: Closeable[]) {
  // One `objc_msgSend` handle per distinct call shape we need. All calls take
  // (receiver, selector, ...args); extra unused argument slots are never passed.
  return {
    id: openMsgSend(libraries, ["pointer", "pointer"], "pointer"),
    id_cstr: openMsgSend(libraries, ["pointer", "pointer", "buffer"], "pointer"),
    id_id: openMsgSend(libraries, ["pointer", "pointer", "pointer"], "pointer"),
    id_rect: openMsgSend(libraries, ["pointer", "pointer", NSRECT], "pointer"),
    id_rectU64U64Bool: openMsgSend(
      libraries,
      ["pointer", "pointer", NSRECT, "u64", "u64", "bool"],
      "pointer",
    ),
    id_rectU64PtrPtr: openMsgSend(
      libraries,
      ["pointer", "pointer", NSRECT, "u64", "pointer", "pointer"],
      "pointer",
    ),
    id_u64PtrPtrBool: openMsgSend(
      libraries,
      ["pointer", "pointer", "u64", "pointer", "pointer", "bool"],
      "pointer",
    ),
    void: openMsgSend(libraries, ["pointer", "pointer"], "void"),
    void_id: openMsgSend(libraries, ["pointer", "pointer", "pointer"], "void"),
    bool: openMsgSend(libraries, ["pointer", "pointer"], "bool"),
    bool_id: openMsgSend(libraries, ["pointer", "pointer", "pointer"], "bool"),
    void_bool: openMsgSend(libraries, ["pointer", "pointer", "bool"], "void"),
    void_i64: openMsgSend(libraries, ["pointer", "pointer", "i64"], "void"),
    point: openMsgSend(libraries, ["pointer", "pointer"], NSPOINT),
    f64: openMsgSend(libraries, ["pointer", "pointer"], "f64"),
    u16: openMsgSend(libraries, ["pointer", "pointer"], "u16"),
    i64: openMsgSend(libraries, ["pointer", "pointer"], "i64"),
    u64: openMsgSend(libraries, ["pointer", "pointer"], "u64"),
  } as const;
}

function openDarwinFfi() {
  const opened: Closeable[] = [];
  try {
    // Load AppKit into the process so its Objective-C classes become resolvable;
    // we never call anything through this handle directly.
    const appKit = Deno.dlopen(APPKIT, {});
    opened.push(appKit);

    const runtime: ObjcRuntime = Deno.dlopen(LIBOBJC, runtimeSymbols);
    opened.push(runtime);

    const send = openMsgSendSymbols(opened);
    const nsrect = openNSRectMsgSend(opened);

    const cg = Deno.dlopen(CORE_GRAPHICS, cgSymbols);
    opened.push(cg);

    const cf = Deno.dlopen(CORE_FOUNDATION, cfSymbols);
    opened.push(cf);

    return {
      appKit,
      runtime,
      send,
      nsrect,
      cg,
      cf,
      getClass: (name: string) => runtimeGetClass(runtime, name),
      sel: (name: string) => runtimeSel(runtime, name),
      allocateClassPair: (superclass: Deno.PointerObject, name: string) =>
        runtimeAllocateClassPair(runtime, superclass, name),
      getProtocol: (name: string) => runtimeGetProtocol(runtime, name),
      addProtocol: (cls: Deno.PointerObject, protocol: Deno.PointerObject) =>
        runtimeAddProtocol(runtime, cls, protocol),
      selectorName: (selector: Deno.PointerValue) => runtimeSelectorName(runtime, selector),
      registerClassPair: runtime.symbols.objc_registerClassPair,
      addMethod: (
        cls: Deno.PointerObject,
        selector: Deno.PointerValue,
        imp: Deno.PointerValue,
        typeEncoding: string,
      ) => runtimeAddMethod(runtime, cls, selector, imp, typeEncoding),
      close: () => {
        for (let i = opened.length - 1; i >= 0; i--) opened[i].close();
      },
    };
  } catch (err) {
    for (let i = opened.length - 1; i >= 0; i--) opened[i].close();
    throw err;
  }
}

type DarwinFfi = ReturnType<typeof openDarwinFfi>;

// NSEventType values (AppKit/NSEvent.h)
const NSEventType = {
  LeftMouseDown: 1n,
  LeftMouseUp: 2n,
  RightMouseDown: 3n,
  RightMouseUp: 4n,
  MouseMoved: 5n,
  LeftMouseDragged: 6n,
  RightMouseDragged: 7n,
  KeyDown: 10n,
  KeyUp: 11n,
  FlagsChanged: 12n,
  ScrollWheel: 22n,
  OtherMouseDown: 25n,
  OtherMouseUp: 26n,
  OtherMouseDragged: 27n,
} as const;

function makeNSString(ffi: DarwinFfi, s: string): Deno.PointerValue {
  const { getClass, sel, send } = ffi;
  const alloc = send.id(getClass("NSString"), sel("alloc"));
  return send.id_cstr(alloc, sel("initWithUTF8String:"), cStr(s));
}

function pointerId(p: Deno.PointerValue): bigint {
  return BigInt(Deno.UnsafePointer.value(p));
}

function getModifiers(event: Deno.PointerValue, ffi: DarwinFfi): KeyModifiers {
  const { sel, send } = ffi;
  const flags = send.u64(event, sel("modifierFlags"));
  const metaKey = (flags & NS_EVENT_MODIFIER_FLAG_COMMAND) !== 0n;
  return {
    shiftKey: (flags & NS_EVENT_MODIFIER_FLAG_SHIFT) !== 0n,
    ctrlKey: (flags & NS_EVENT_MODIFIER_FLAG_CONTROL) !== 0n,
    altKey: (flags & NS_EVENT_MODIFIER_FLAG_OPTION) !== 0n,
    metaKey,
    accelKey: metaKey,
    capsLock: (flags & NS_EVENT_MODIFIER_FLAG_CAPS_LOCK) !== 0n,
  };
}

function readInputString(value: Deno.PointerValue, ffi: DarwinFfi): string {
  if (value === null) return "";
  const { cf, getClass, sel, send } = ffi;
  const string = send.bool_id(value, sel("isKindOfClass:"), getClass("NSAttributedString"))
    ? send.id(value, sel("string"))
    : value;
  return string === null ? "" : readCFString(cf, string);
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

type AnyCallback = { pointer: Deno.PointerObject; close(): void };

interface NativeClasses {
  delegate: Deno.PointerObject;
  contentView: Deno.PointerObject;
  /** Objective-C keeps these IMP pointers forever; never close the callbacks. */
  callbacks: AnyCallback[];
}

let nativeClasses: NativeClasses | undefined;
const WINDOWS_BY_DELEGATE = new Map<bigint, DarwinWindow>();
const WINDOWS_BY_VIEW = new Map<bigint, DarwinWindow>();

function windowForDelegate(self: Deno.PointerValue): DarwinWindow | undefined {
  return self === null ? undefined : WINDOWS_BY_DELEGATE.get(pointerId(self));
}

function windowForView(self: Deno.PointerValue): DarwinWindow | undefined {
  return self === null ? undefined : WINDOWS_BY_VIEW.get(pointerId(self));
}

function ensureNativeClasses(ffi: DarwinFfi): NativeClasses {
  if (nativeClasses !== undefined) return nativeClasses;

  const { addMethod, addProtocol, allocateClassPair, getClass, getProtocol, registerClassPair, sel } = ffi;
  const callbacks: AnyCallback[] = [];

  const shouldClose = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "bool" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) window.lib.pushEvent({ type: "close", window });
      return false;
    },
  );
  const didResize = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => windowForDelegate(self)?.handleResize(),
  );
  const mouseEntered = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) window.lib.pushEvent({ type: "mouseenter", window });
    },
  );
  const mouseExited = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) window.lib.pushEvent({ type: "mouseleave", window });
    },
  );
  const didBecomeKey = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) window.lib.pushEvent({ type: "focus", window });
    },
  );
  const didResignKey = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window === undefined) return;
      window.cancelComposition();
      window.resetModifierState();
      window.lib.pushEvent({ type: "blur", window });
    },
  );
  const didMiniaturize = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) {
        window.lib.pushEvent({ type: "visibilitychange", visible: false, window });
      }
    },
  );
  const didDeminiaturize = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self) => {
      const window = windowForDelegate(self);
      if (window !== undefined) {
        window.lib.pushEvent({ type: "visibilitychange", visible: true, window });
      }
    },
  );
  callbacks.push(
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

  const acceptsFirstResponder = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "bool" },
    () => true,
  );
  const keyDown = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self, _cmd, event) => windowForView(self)?.handleKeyDown(event),
  );
  const keyUp = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self, _cmd, event) => windowForView(self)?.handleKeyUp(event),
  );
  const flagsChanged = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self, _cmd, event) => windowForView(self)?.handleFlagsChanged(event),
  );
  const insertText = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", NSRANGE], result: "void" },
    (self, _cmd, text) => windowForView(self)?.handleInsertText(text),
  );
  const setMarkedText = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "pointer", "pointer", NSRANGE, NSRANGE],
      result: "void",
    },
    (self, _cmd, text, selection) => {
      const range = readNSRange(selection);
      windowForView(self)?.handleSetMarkedText(text, range.location, range.length);
    },
  );
  const unmarkText = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "void" },
    (self) => windowForView(self)?.handleUnmarkText(),
  );
  const hasMarkedText = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "bool" },
    (self) => windowForView(self)?.inputState.hasMarkedText ?? false,
  );
  const markedRange = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: NSRANGE },
    (self) => {
      const range = windowForView(self)?.inputState.markedRange ?? {
        location: NS_NOT_FOUND,
        length: 0n,
      };
      return makeNSRange(range.location, range.length);
    },
  );
  const selectedRange = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: NSRANGE },
    (self) => {
      const range = windowForView(self)?.inputState.selectedRange ?? {
        location: NS_NOT_FOUND,
        length: 0n,
      };
      return makeNSRange(range.location, range.length);
    },
  );
  const validAttributes = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "pointer" },
    (self) => windowForView(self)?.emptyArray() ?? null,
  );
  const attributedSubstring = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", NSRANGE, "pointer"], result: "pointer" },
    (_self, _cmd, _range, actualRange) => {
      writeRangePointer(actualRange, NS_NOT_FOUND, 0n);
      return null;
    },
  );
  const characterIndexForPoint = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", NSPOINT], result: "usize" },
    () => NS_NOT_FOUND,
  );
  const firstRect = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", NSRANGE, "pointer"], result: NSRECT },
    (self, _cmd, _range, actualRange) => {
      writeRangePointer(actualRange, NS_NOT_FOUND, 0n);
      return windowForView(self)?.firstRectForCharacterRange() ?? new Float64Array(4);
    },
  );
  const doCommand = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (self, _cmd, command) => windowForView(self)?.handleCommand(command),
  );
  callbacks.push(
    acceptsFirstResponder,
    keyDown,
    keyUp,
    flagsChanged,
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

  nativeClasses = { delegate, contentView, callbacks };
  return nativeClasses;
}

class DarwinWindow implements Window {
  readonly id: bigint;
  readonly nsWindow: Deno.PointerValue;
  readonly contentView: Deno.PointerValue;
  readonly #layer: Deno.PointerValue;
  readonly #delegate: Deno.PointerValue;
  readonly inputState: DarwinInputState;
  #width: number;
  #height: number;
  #discardingMarkedText = false;
  #keyDispatchActive = false;
  #producedText: string | undefined;
  #producedPreedit = false;
  #closed = false;
  // Kept alive for one extra frame: CGImage/CGDataProvider wrap this memory
  // without copying it, and CALayer's `contents` assignment is composited
  // asynchronously, so the previous frame's buffer must outlive the call that
  // replaces it.
  #imageBuf: Uint8Array | undefined;
  #prevImageBuf: Uint8Array | undefined;

  constructor(readonly lib: DarwinLibrary, x = 0, y = 0, w = 800, h = 600) {
    const { getClass, sel, send } = lib.ffi;
    const alloc = send.id(getClass("NSWindow"), sel("alloc"));
    const rect = new Float64Array([x, y, w, h]);
    const win = send.id_rectU64U64Bool(
      alloc,
      sel("initWithContentRect:styleMask:backing:defer:"),
      rect,
      BigInt(NS_WINDOW_STYLE_MASK),
      NS_BACKING_STORE_BUFFERED,
      false,
    );
    if (win === null) throw new Error("winding(darwin): failed to create NSWindow");
    this.nsWindow = win;
    this.id = pointerId(win);
    this.#width = w;
    this.#height = h;
    this.inputState = new DarwinInputState(this);

    const delegateAlloc = send.id(lib.nativeClasses.delegate, sel("alloc"));
    this.#delegate = send.id(delegateAlloc, sel("init"));
    if (this.#delegate === null) throw new Error("winding(darwin): failed to create window delegate");
    WINDOWS_BY_DELEGATE.set(pointerId(this.#delegate), this);
    send.void_id(win, sel("setDelegate:"), this.#delegate);

    const viewAlloc = send.id(lib.nativeClasses.contentView, sel("alloc"));
    this.contentView = send.id_rect(
      viewAlloc,
      sel("initWithFrame:"),
      new Float64Array([0, 0, w, h]),
    );
    if (this.contentView === null) throw new Error("winding(darwin): failed to create content view");
    WINDOWS_BY_VIEW.set(pointerId(this.contentView), this);
    send.void_id(win, sel("setContentView:"), this.contentView);
    send.void_bool(this.contentView, sel("setWantsLayer:"), true);
    this.#layer = send.id(this.contentView, sel("layer"));

    // Tracking area to receive mouseEntered:/mouseExited: on our delegate (registered as its
    // owner below), which AppKit invokes directly rather than delivering as queued NSEvents.
    const trackingAreaAlloc = send.id(getClass("NSTrackingArea"), sel("alloc"));
    const zeroRect = new Float64Array(4);
    const trackingArea = send.id_rectU64PtrPtr(
      trackingAreaAlloc,
      sel("initWithRect:options:owner:userInfo:"),
      zeroRect,
      BigInt(NS_TRACKING_AREA_OPTIONS),
      this.#delegate,
      null,
    );
    send.void_id(this.contentView, sel("addTrackingArea:"), trackingArea);
    send.void(trackingArea, sel("release"));

    send.void_bool(win, sel("makeKeyAndOrderFront:"), false);
    if (!send.bool_id(win, sel("makeFirstResponder:"), this.contentView)) {
      throw new Error("winding(darwin): failed to make content view first responder");
    }
    send.void_bool(lib.nsApp, sel("activateIgnoringOtherApps:"), true);

    lib.registerWindow(this);
  }

  setSize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  get height(): number {
    return this.#height;
  }

  handleResize(): void {
    if (this.#closed) return;
    const { nsrect, sel } = this.lib.ffi;
    const frame = nsrect.noArgs(this.contentView, sel("frame"));
    const width = Math.round(readStructF64(frame, 16));
    const height = Math.round(readStructF64(frame, 24));
    this.setSize(width, height);
    this.lib.pushEvent({ type: "resize", width, height, window: this });
  }

  handleKeyDown(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    this.lib.markNativeEventHandled(event);
    const native = this.#keyEvent(event, "keydown");
    this.inputState.beginKey(native.event);
    this.#keyDispatchActive = true;
    this.#producedText = undefined;
    this.#producedPreedit = false;
    try {
      if (this.inputState.imeEnabled) {
        const { getClass, sel, send } = this.lib.ffi;
        const events = send.id_id(getClass("NSArray"), sel("arrayWithObject:"), event);
        send.void_id(this.contentView, sel("interpretKeyEvents:"), events);
      }
    } finally {
      const batch = this.inputState.finishKey();
      const key = batch[0];
      if (key?.type === "keydown") {
        if (this.#producedText !== undefined) key.text = this.#producedText;
        key.key = logicalKeyForEvent({
          code: key.code,
          characters: native.characters,
          charactersIgnoringModifiers: native.charactersIgnoringModifiers,
          producedText: this.#producedText,
          producedPreedit: this.#producedPreedit || key.isComposing,
        });
      }
      this.#keyDispatchActive = false;
      this.#producedText = undefined;
      this.#producedPreedit = false;
      this.lib.pushEvents(batch);
    }
  }

  handleKeyUp(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    this.lib.markNativeEventHandled(event);
    this.lib.pushEvent(this.#keyEvent(event, "keyup").event);
  }

  handleFlagsChanged(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    this.lib.markNativeEventHandled(event);
    const native = this.#keyEvent(event, "keydown");
    const code = native.event.code;
    const flags = this.lib.ffi.send.u64(event, this.lib.ffi.sel("modifierFlags"));
    const flag = modifierFlagForCode(code);
    native.event.type = this.inputState.modifierTransition(code, flags, flag);
    native.event.repeat = false;
    this.lib.pushEvent(native.event);
  }

  resetModifierState(): void {
    this.inputState.resetModifiers();
  }

  handleInsertText(value: Deno.PointerValue): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.imeEnabled) return;
    const text = readInputString(value, this.lib.ffi);
    if (this.#keyDispatchActive) this.#producedText = text;
    this.inputState.insertText(text);
    this.#flushInputState();
  }

  handleSetMarkedText(
    value: Deno.PointerValue,
    selectionLocation: bigint,
    selectionLength: bigint,
  ): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.imeEnabled) return;
    if (this.#keyDispatchActive) this.#producedPreedit = true;
    this.inputState.setMarkedText(
      readInputString(value, this.lib.ffi),
      selectionLocation,
      selectionLength,
    );
    this.#flushInputState();
  }

  handleUnmarkText(): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.imeEnabled) return;
    if (this.#keyDispatchActive && this.inputState.hasMarkedText) {
      this.#producedText = this.inputState.markedText;
    }
    this.inputState.unmarkText();
    this.#flushInputState();
  }

  handleCommand(command: Deno.PointerValue): void {
    if (this.#closed || command === null || !this.inputState.imeEnabled) return;
    this.inputState.performCommand(this.lib.ffi.selectorName(command));
    this.#flushInputState();
  }

  emptyArray(): Deno.PointerValue {
    const { getClass, sel, send } = this.lib.ffi;
    return send.id(getClass("NSArray"), sel("array"));
  }

  firstRectForCharacterRange(): Uint8Array {
    const { nsrect, sel } = this.lib.ffi;
    const bounds = nsrect.noArgs(this.contentView, sel("bounds"));
    const viewHeight = readStructF64(bounds, 24);
    const local = cocoaRectFromClient(this.inputState.cursorArea, viewHeight);
    return nsrect.rectArg(
      this.nsWindow,
      sel("convertRectToScreen:"),
      new Float64Array([local.x, local.y, local.width, local.height]),
    );
  }

  setImeEnabled(enabled: boolean): void {
    if (this.#closed || enabled === this.inputState.imeEnabled) return;
    this.inputState.setImeEnabled(enabled);
    this.#flushInputState();
    if (!enabled) this.#discardNativeMarkedText();
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    if (this.#closed) return;
    this.inputState.setCursorArea(x, y, width, height);
    const { sel, send } = this.lib.ffi;
    const inputContext = send.id(this.contentView, sel("inputContext"));
    if (inputContext !== null) send.void(inputContext, sel("invalidateCharacterCoordinates"));
  }

  cancelComposition(): void {
    if (this.#closed) return;
    this.inputState.cancelComposition();
    this.#flushInputState();
    this.#discardNativeMarkedText();
  }

  #discardNativeMarkedText(): void {
    const { sel, send } = this.lib.ffi;
    const inputContext = send.id(this.contentView, sel("inputContext"));
    if (inputContext === null) return;
    this.#discardingMarkedText = true;
    try {
      send.void(inputContext, sel("discardMarkedText"));
    } finally {
      this.#discardingMarkedText = false;
    }
  }

  #flushInputState(): void {
    this.lib.pushEvents(this.inputState.drainEvents());
  }

  #keyEvent(
    event: Deno.PointerValue,
    type: "keydown" | "keyup",
  ): { event: KeyEvent; characters: string; charactersIgnoringModifiers: string } {
    const { sel, send } = this.lib.ffi;
    const keycode = send.u16(event, sel("keyCode"));
    const code = getDomCode(keycode);
    const charactersPointer = send.id(event, sel("characters"));
    const charactersIgnoringModifiersPointer = send.id(event, sel("charactersIgnoringModifiers"));
    const characters = charactersPointer === null ? "" : readCFString(this.lib.ffi.cf, charactersPointer);
    const charactersIgnoringModifiers = charactersIgnoringModifiersPointer === null
      ? ""
      : readCFString(this.lib.ffi.cf, charactersIgnoringModifiersPointer);
    const key: KeyEvent = {
      type,
      keycode,
      code,
      key: logicalKeyForEvent({ code, characters, charactersIgnoringModifiers }),
      location: keyLocationForCode(code),
      repeat: type === "keydown" && send.bool(event, sel("isARepeat")),
      isComposing: this.inputState.hasMarkedText,
      text: type === "keydown" ? printableText(characters) ?? "" : "",
      textInputHandled: false,
      ...getModifiers(event, this.lib.ffi),
      window: this,
    };
    return { event: key, characters, charactersIgnoringModifiers };
  }

  setTitle(title: string): void {
    const { sel, send } = this.lib.ffi;
    const titleString = makeNSString(this.lib.ffi, title);
    send.void_id(this.nsWindow, sel("setTitle:"), titleString);
    send.void(titleString, sel("release"));
  }

  blit(rgba: Uint8Array, width: number, height: number): void {
    const { cf, cg, sel, send } = this.lib.ffi;
    this.#prevImageBuf = this.#imageBuf;
    // Own a stable copy: the caller's buffer isn't guaranteed to outlive this call.
    const buf = new Uint8Array(rgba);
    this.#imageBuf = buf;

    const provider = cg.symbols.CGDataProviderCreateWithData(null, buf, BigInt(buf.byteLength), null);
    if (provider === null) throw new Error("winding(darwin): CGDataProviderCreateWithData failed");
    const image = cg.symbols.CGImageCreate(
      BigInt(width),
      BigInt(height),
      8n,
      32n,
      BigInt(width * 4),
      this.lib.colorSpace,
      RGBA_BITMAP_INFO,
      provider,
      null,
      false,
      0,
    );
    cf.symbols.CFRelease(provider);
    if (image === null) throw new Error("winding(darwin): CGImageCreate failed");
    send.void_id(this.#layer, sel("setContents:"), image);
    cf.symbols.CFRelease(image);

    this.#width = width;
    this.#height = height;
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.cancelComposition();
    this.#closed = true;
    this.lib.unregisterWindow(this);
    WINDOWS_BY_VIEW.delete(pointerId(this.contentView));
    WINDOWS_BY_DELEGATE.delete(pointerId(this.#delegate));

    const { sel, send } = this.lib.ffi;
    send.void_id(this.nsWindow, sel("setDelegate:"), null);
    send.bool_id(this.nsWindow, sel("makeFirstResponder:"), null);
    send.void_id(this.nsWindow, sel("orderOut:"), null);
    send.void(this.contentView, sel("release"));
    send.void(this.nsWindow, sel("release"));
    send.void(this.#delegate, sel("release"));
  }
}

const BUTTONS = [, "left", "middle", "right"] as const;

class DarwinLibrary implements Library {
  readonly ffi: DarwinFfi;
  readonly nsApp: Deno.PointerValue;
  readonly colorSpace: Deno.PointerObject;
  readonly nativeClasses: NativeClasses;
  readonly windows = new Map<bigint, DarwinWindow>();
  readonly #distantPast: Deno.PointerValue;
  readonly #runLoopMode: Deno.PointerValue;
  #queue: UIEvent[] = [];
  #handledNativeEvent: bigint | undefined;
  #closed = false;

  constructor() {
    this.ffi = openDarwinFfi();
    const { cg, getClass, sel, send } = this.ffi;
    this.nativeClasses = ensureNativeClasses(this.ffi);
    this.nsApp = send.id(getClass("NSApplication"), sel("sharedApplication"));
    send.void_i64(this.nsApp, sel("setActivationPolicy:"), NS_APPLICATION_ACTIVATION_POLICY_REGULAR);
    send.void(this.nsApp, sel("finishLaunching"));
    this.#distantPast = send.id(getClass("NSDate"), sel("distantPast"));
    this.#runLoopMode = makeNSString(this.ffi, "kCFRunLoopDefaultMode");
    const colorSpace = cg.symbols.CGColorSpaceCreateDeviceRGB();
    if (colorSpace === null) throw new Error("winding(darwin): CGColorSpaceCreateDeviceRGB failed");
    this.colorSpace = colorSpace;
  }

  registerWindow(window: DarwinWindow): void {
    this.windows.set(window.id, window);
  }

  unregisterWindow(window: DarwinWindow): void {
    if (this.windows.get(window.id) === window) this.windows.delete(window.id);
  }

  pushEvent(event: UIEvent): void {
    this.#queue.push(event);
  }

  pushEvents(events: UIEvent[]): void {
    this.#queue.push(...events);
  }

  markNativeEventHandled(event: Deno.PointerValue): void {
    if (event !== null) this.#handledNativeEvent = pointerId(event);
  }

  openWindow(x = 0, y = 0, w = 800, h = 600): DarwinWindow {
    if (this.#closed) throw new Error("winding(darwin): library is closed");
    return new DarwinWindow(this, x, y, w, h);
  }

  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
    const { getClass, sel, send } = this.ffi;
    if (this.#queue.length) return this.#queue.shift();
    while (true) {
      const poolAlloc = send.id(getClass("NSAutoreleasePool"), sel("alloc"));
      const pool = send.id(poolAlloc, sel("init"));
      try {
        const event = send.id_u64PtrPtrBool(
          this.nsApp,
          sel("nextEventMatchingMask:untilDate:inMode:dequeue:"),
          NS_EVENT_MASK_ANY,
          this.#distantPast,
          this.#runLoopMode,
          true,
        );
        if (event === null) break;

        this.#handledNativeEvent = undefined;
        const nativeType = send.u64(event, sel("type"));
        send.void_id(this.nsApp, sel("sendEvent:"), event);

        if (
          (nativeType === NSEventType.KeyDown ||
            nativeType === NSEventType.KeyUp ||
            nativeType === NSEventType.FlagsChanged) &&
          this.#handledNativeEvent !== pointerId(event)
        ) {
          this.#pushKeyboardFallback(event, nativeType);
        }

        if (this.#queue.length) return this.#queue.shift();
        const translated = importEvent(event, this);
        if (translated !== undefined) return translated;
      } finally {
        if (pool !== null) send.void(pool, sel("drain"));
      }
    }
    return this.#queue.length ? this.#queue.shift() : undefined;
  }

  #pushKeyboardFallback(event: Deno.PointerValue, type: bigint): void {
    const { sel, send } = this.ffi;
    const windowPointer = send.id(event, sel("window"));
    const window = windowPointer === null ? undefined : this.windows.get(pointerId(windowPointer));
    if (window === undefined) return;
    if (type === NSEventType.FlagsChanged) {
      window.handleFlagsChanged(event);
      return;
    }

    const keycode = send.u16(event, sel("keyCode"));
    const code = getDomCode(keycode);
    const charactersPointer = send.id(event, sel("characters"));
    const ignoringPointer = send.id(event, sel("charactersIgnoringModifiers"));
    const characters = charactersPointer === null ? "" : readCFString(this.ffi.cf, charactersPointer);
    const charactersIgnoringModifiers = ignoringPointer === null ? "" : readCFString(this.ffi.cf, ignoringPointer);
    const key: KeyEvent = {
      type: type === NSEventType.KeyDown ? "keydown" : "keyup",
      keycode,
      code,
      key: logicalKeyForEvent({ code, characters, charactersIgnoringModifiers }),
      location: keyLocationForCode(code),
      repeat: type === NSEventType.KeyDown && send.bool(event, sel("isARepeat")),
      isComposing: window.inputState.hasMarkedText,
      text: type === NSEventType.KeyDown ? printableText(characters) ?? "" : "",
      textInputHandled: false,
      ...getModifiers(event, this.ffi),
      window,
    };
    this.#queue.push(key);
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    for (const window of [...this.windows.values()]) window.close();
    this.#closed = true;
    this.ffi.send.void(this.#runLoopMode, this.ffi.sel("release"));
    this.ffi.cf.symbols.CFRelease(this.colorSpace);
    this.ffi.close();
  }
}

function importEvent(event: Deno.PointerValue, lib: DarwinLibrary): UIEvent | undefined {
  const { sel, send } = lib.ffi;
  const type = send.u64(event, sel("type"));
  const windowPtr = send.id(event, sel("window"));
  const window = windowPtr !== null ? lib.windows.get(pointerId(windowPtr)) : undefined;

  switch (type) {
    case NSEventType.LeftMouseDown:
      return { type: "mousedown", button: "left", window };
    case NSEventType.LeftMouseUp:
      return { type: "mouseup", button: "left", window };
    case NSEventType.RightMouseDown:
      return { type: "mousedown", button: "right", window };
    case NSEventType.RightMouseUp:
      return { type: "mouseup", button: "right", window };
    case NSEventType.OtherMouseDown:
    case NSEventType.OtherMouseUp: {
      const buttonNumber = send.i64(event, sel("buttonNumber"));
      const button = BUTTONS[Number(buttonNumber) + 1];
      if (button === undefined) return undefined;
      return { type: type === NSEventType.OtherMouseDown ? "mousedown" : "mouseup", button, window };
    }
    case NSEventType.MouseMoved:
    case NSEventType.LeftMouseDragged:
    case NSEventType.RightMouseDragged:
    case NSEventType.OtherMouseDragged: {
      const point = send.point(event, sel("locationInWindow")) as Uint8Array;
      const x = readStructF64(point, 0);
      const y = readStructF64(point, 8);
      // Cocoa's window-local origin is bottom-left; flip to the top-left
      // origin used by the other winding backends.
      return { type: "mousemove", x, y: window !== undefined ? window.height - y : y, window };
    }
    case NSEventType.ScrollWheel: {
      const deltaX = send.f64(event, sel("deltaX"));
      const deltaY = send.f64(event, sel("deltaY"));
      return { type: "wheel", deltaX: -deltaX, deltaY: -deltaY, window };
    }
    default:
      return undefined;
  }
}

export const load: LoadLibrary = () => new DarwinLibrary();
