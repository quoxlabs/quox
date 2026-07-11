import type {
  KeyDownEvent,
  KeyEventBase,
  KeyModifiers,
  KeyUpEvent,
  Library,
  LoadLibrary,
  MouseButton,
  PointerModifiers,
  UIEvent,
  Window,
} from "../types.ts";
import {
  createKeyDownEvent,
  createKeyUpEvent,
  EventQueue,
  keyLocationForCode,
  NativeEventClock,
  PressedLogicalKeyCache,
} from "../input/mod.ts";
import { getDomCode } from "./dom_code.ts";
import { appKitWindowFrame, browserWheelDelta, type ScreenFrame } from "./geometry.ts";
import { DarwinInputState } from "./input_state.ts";
import {
  addMethod as runtimeAddMethod,
  addProtocol as runtimeAddProtocol,
  allocateClassPair as runtimeAllocateClassPair,
  APPKIT,
  assertMainThread,
  cfSymbols,
  cgSymbols,
  CORE_FOUNDATION,
  CORE_GRAPHICS,
  getClass as runtimeGetClass,
  getProtocol as runtimeGetProtocol,
  HITOOLBOX,
  hitoolboxSymbols,
  LIBOBJC,
  LIBSYSTEM,
  NS_NOT_FOUND,
  NSPOINT,
  NSRECT,
  type ObjcRuntime,
  openNSRectMsgSend,
  readCFString,
  readStructF64,
  RGBA_BITMAP_INFO,
  runtimeSymbols,
  sel as runtimeSel,
  selectorName as runtimeSelectorName,
  systemSymbols,
} from "./ffi.ts";
import {
  type DarwinNativeClasses,
  type DarwinNativeResponder,
  ensureNativeClasses,
  type NativeRange,
} from "./native_classes.ts";
import { cocoaRectFromClient, logicalKeyForEvent, uninterpretedCommitText } from "./text_input.ts";

// NSWindowStyleMask: Titled | Closable | Resizable | Miniaturizable
const NS_WINDOW_STYLE_MASK = 1 | 2 | 8 | 4;
const NS_BACKING_STORE_BUFFERED = 2n;
const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0n;
const NS_EVENT_MASK_ANY = 0xFFFFFFFFFFFFFFFFn;
const MAX_NATIVE_EVENTS_PER_POLL = 64;
const NS_EVENT_MODIFIER_FLAG_CAPS_LOCK = 1n << 16n;
const NS_EVENT_MODIFIER_FLAG_SHIFT = 1n << 17n;
const NS_EVENT_MODIFIER_FLAG_CONTROL = 1n << 18n;
const NS_EVENT_MODIFIER_FLAG_OPTION = 1n << 19n;
const NS_EVENT_MODIFIER_FLAG_COMMAND = 1n << 20n;
const NS_EVENT_MODIFIER_FLAG_FUNCTION = 1n << 23n;
// NSTrackingAreaOptions: MouseEnteredAndExited | ActiveAlways | InVisibleRect |
// EnabledDuringMouseDrag. The visible-rect option keeps bounds current across
// resizes, while ActiveAlways matches Winding's focus-independent boundary
// events and drag tracking avoids delayed hover transitions during capture.
const NS_TRACKING_AREA_OPTIONS = 0x01 | 0x80 | 0x200 | 0x400;

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
    case "Fn":
      return NS_EVENT_MODIFIER_FLAG_FUNCTION;
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
    id_bufUsizeU64: openMsgSend(
      libraries,
      ["pointer", "pointer", "buffer", "usize", "u64"],
      "pointer",
    ),
    id_id: openMsgSend(libraries, ["pointer", "pointer", "pointer"], "pointer"),
    id_u64: openMsgSend(libraries, ["pointer", "pointer", "u64"], "pointer"),
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
    bool_i64: openMsgSend(libraries, ["pointer", "pointer", "i64"], "bool"),
    point: openMsgSend(libraries, ["pointer", "pointer"], NSPOINT),
    point_pointId: openMsgSend(
      libraries,
      ["pointer", "pointer", NSPOINT, "pointer"],
      NSPOINT,
    ),
    f64: openMsgSend(libraries, ["pointer", "pointer"], "f64"),
    u16: openMsgSend(libraries, ["pointer", "pointer"], "u16"),
    i64: openMsgSend(libraries, ["pointer", "pointer"], "i64"),
    u64: openMsgSend(libraries, ["pointer", "pointer"], "u64"),
  } as const;
}

function openDarwinFfi() {
  const opened: Closeable[] = [];
  try {
    // This must be the first native check. Loading AppKit is harmless by
    // itself, but no AppKit class or object may be touched from a Worker.
    const system = Deno.dlopen(LIBSYSTEM, systemSymbols);
    opened.push(system);
    assertMainThread(system);

    // Load AppKit into the process so its Objective-C classes become resolvable;
    // we never call anything through this handle directly.
    const appKit = Deno.dlopen(APPKIT, {});
    opened.push(appKit);

    const hitoolbox = Deno.dlopen(HITOOLBOX, hitoolboxSymbols);
    opened.push(hitoolbox);

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
      hitoolbox,
      runtime,
      send,
      nsrect,
      cg,
      cf,
      system,
      assertMainThread: () => assertMainThread(system),
      isIsoKeyboard: () => hitoolbox.symbols.KBGetLayoutType(hitoolbox.symbols.LMGetKbdType()) === 0x49534f20,
      getClass: (name: string) => runtimeGetClass(runtime, name),
      sel: (name: string) => runtimeSel(runtime, name),
      allocateClassPair: (superclass: Deno.PointerObject, name: string) =>
        runtimeAllocateClassPair(runtime, superclass, name),
      getProtocol: (name: string) => runtimeGetProtocol(runtime, name),
      addProtocol: (cls: Deno.PointerObject, protocol: Deno.PointerObject) =>
        runtimeAddProtocol(runtime, cls, protocol),
      selectorName: (selector: Deno.PointerValue) => runtimeSelectorName(runtime, selector),
      registerClassPair: runtime.symbols.objc_registerClassPair,
      disposeClassPair: runtime.symbols.objc_disposeClassPair,
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

function withAutoreleasePool<T>(ffi: DarwinFfi, operation: () => T): T {
  const { getClass, sel, send } = ffi;
  const alloc = send.id(getClass("NSAutoreleasePool"), sel("alloc"));
  const pool = send.id(alloc, sel("init"));
  if (pool === null) throw new Error("winding(darwin): failed to create autorelease pool");
  try {
    return operation();
  } finally {
    send.void(pool, sel("drain"));
  }
}

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

function makeNSString(ffi: DarwinFfi, s: string): Deno.PointerObject {
  const { getClass, sel, send } = ffi;
  const alloc = send.id(getClass("NSString"), sel("alloc"));
  if (alloc === null) throw new Error("winding(darwin): failed to allocate NSString");
  const bytes = new TextEncoder().encode(s);
  const string = send.id_bufUsizeU64(
    alloc,
    sel("initWithBytes:length:encoding:"),
    bytes,
    BigInt(bytes.byteLength),
    4n, // NSUTF8StringEncoding
  );
  if (string === null) throw new Error("winding(darwin): failed to initialize UTF-8 NSString");
  return string;
}

function pointerId(p: Deno.PointerValue): bigint {
  return BigInt(Deno.UnsafePointer.value(p));
}

function primaryScreenFrame(ffi: DarwinFfi): ScreenFrame {
  const { getClass, nsrect, sel, send } = ffi;
  const screens = send.id(getClass("NSScreen"), sel("screens"));
  const primary = screens === null ? null : send.id(screens, sel("firstObject"));
  if (primary === null) throw new Error("winding(darwin): AppKit reported no screens");
  const frame = nsrect.noArgs(primary, sel("frame"));
  return {
    x: readStructF64(frame, 0),
    y: readStructF64(frame, 8),
    width: readStructF64(frame, 16),
    height: readStructF64(frame, 24),
  };
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
    altGraphKey: false,
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

function validatedBlitGeometry(
  rgba: Uint8Array,
  width: number,
  height: number,
  expectedWidth: number,
  expectedHeight: number,
): { rowBytes: bigint; totalBytes: number } {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("winding(darwin): blit dimensions must be positive safe integers");
  }
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new RangeError(
      `winding(darwin): blit dimensions ${width}x${height} do not match client size ${expectedWidth}x${expectedHeight}`,
    );
  }
  const rowBytes = width * 4;
  const totalBytes = rowBytes * height;
  if (!Number.isSafeInteger(rowBytes) || !Number.isSafeInteger(totalBytes)) {
    throw new RangeError("winding(darwin): blit byte size exceeds exact JavaScript/size_t range");
  }
  if (rgba.byteLength !== totalBytes) {
    throw new RangeError(
      `winding(darwin): RGBA buffer has ${rgba.byteLength} bytes; expected ${totalBytes}`,
    );
  }
  return { rowBytes: BigInt(rowBytes), totalBytes };
}

class DarwinWindow implements Window, DarwinNativeResponder {
  readonly id: bigint;
  readonly nsWindow: Deno.PointerValue;
  readonly contentView: Deno.PointerValue;
  readonly #layer: Deno.PointerValue;
  readonly #delegate: Deno.PointerValue;
  readonly inputState: DarwinInputState;
  #viewImage: Deno.PointerValue = null;
  #width: number;
  #height: number;
  #discardingMarkedText = false;
  #keyDispatchActive = false;
  #producedText: string | undefined;
  #producedPreedit = false;
  readonly #pressedKeys = new PressedLogicalKeyCache<number>();
  #ready = false;
  #closed = false;

  constructor(readonly lib: DarwinLibrary, x = 0, y = 0, w = 800, h = 600) {
    lib.assertMainThread();
    const { getClass, nsrect, sel, send } = lib.ffi;
    const windowClass = getClass("NSWindow");
    const styleMask = BigInt(NS_WINDOW_STYLE_MASK);
    const frame = appKitWindowFrame(x, y, w, h, primaryScreenFrame(lib.ffi));
    const contentRect = nsrect.rectU64Arg(
      windowClass,
      sel("contentRectForFrameRect:styleMask:"),
      frame,
      styleMask,
    );
    const contentWidth = readStructF64(contentRect, 16);
    const contentHeight = readStructF64(contentRect, 24);
    const alloc = send.id(windowClass, sel("alloc"));
    const win = send.id_rectU64U64Bool(
      alloc,
      sel("initWithContentRect:styleMask:backing:defer:"),
      contentRect,
      styleMask,
      NS_BACKING_STORE_BUFFERED,
      false,
    );
    if (win === null) throw new Error("winding(darwin): failed to create NSWindow");
    this.nsWindow = win;
    this.id = pointerId(win);
    this.#width = Math.round(contentWidth);
    this.#height = Math.round(contentHeight);
    this.inputState = new DarwinInputState(this);
    let delegate: Deno.PointerValue = null;
    let contentView: Deno.PointerValue = null;
    let delegateRegistered = false;
    let viewRegistered = false;
    try {
      const delegateAlloc = send.id(lib.nativeClasses.delegate, sel("alloc"));
      delegate = send.id(delegateAlloc, sel("init"));
      if (delegate === null) throw new Error("winding(darwin): failed to create window delegate");
      this.#delegate = delegate;
      lib.nativeClasses.registerDelegate(delegate, this);
      delegateRegistered = true;
      send.void_id(win, sel("setDelegate:"), delegate);

      const viewAlloc = send.id(lib.nativeClasses.contentView, sel("alloc"));
      contentView = send.id_rect(
        viewAlloc,
        sel("initWithFrame:"),
        new Float64Array([0, 0, contentWidth, contentHeight]),
      );
      if (contentView === null) throw new Error("winding(darwin): failed to create content view");
      this.contentView = contentView;
      lib.nativeClasses.registerView(contentView, this);
      viewRegistered = true;
      send.void_id(win, sel("setContentView:"), contentView);
      // NSWindow defaults this to false, which suppresses ordinary unpressed
      // mouse motion even though drag events continue to arrive.
      send.void_bool(win, sel("setAcceptsMouseMovedEvents:"), true);
      send.void_bool(contentView, sel("setWantsLayer:"), true);
      const layer = send.id(contentView, sel("layer"));
      if (layer === null) throw new Error("winding(darwin): failed to create content layer");
      this.#layer = layer;

      // Tracking area to receive mouseEntered:/mouseExited: on our delegate (registered as its
      // owner below), which AppKit invokes directly rather than delivering as queued NSEvents.
      const trackingAreaAlloc = send.id(getClass("NSTrackingArea"), sel("alloc"));
      const trackingArea = send.id_rectU64PtrPtr(
        trackingAreaAlloc,
        sel("initWithRect:options:owner:userInfo:"),
        new Float64Array(4),
        BigInt(NS_TRACKING_AREA_OPTIONS),
        delegate,
        null,
      );
      if (trackingArea === null) throw new Error("winding(darwin): failed to create tracking area");
      try {
        send.void_id(contentView, sel("addTrackingArea:"), trackingArea);
      } finally {
        send.void(trackingArea, sel("release"));
      }

      // A window cannot reliably become key while its application is inactive.
      // Activate first so AppKit delivers windowDidBecomeKey: synchronously when
      // the desktop session permits foreground activation.
      const modernActivate = sel("activate");
      if (send.bool_id(lib.nsApp, sel("respondsToSelector:"), modernActivate)) {
        send.void(lib.nsApp, modernActivate);
      } else {
        send.void_bool(lib.nsApp, sel("activateIgnoringOtherApps:"), true);
      }
      send.void_id(win, sel("makeKeyAndOrderFront:"), null);
      if (!send.bool_id(win, sel("makeFirstResponder:"), contentView)) {
        throw new Error("winding(darwin): failed to make content view first responder");
      }
      lib.nativeClasses.throwIfCallbackFailed();
      lib.registerWindow(this);
      this.#ready = true;
      if (send.bool(win, sel("isKeyWindow"))) this.handleFocusGained();
    } catch (error) {
      const errors = [error];
      const cleanup = (operation: () => void): void => {
        try {
          operation();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      };
      cleanup(() => lib.unregisterWindow(this));
      if (viewRegistered) cleanup(() => lib.nativeClasses.unregisterView(contentView));
      if (delegateRegistered) cleanup(() => lib.nativeClasses.unregisterDelegate(delegate));
      cleanup(() => this.inputState.close());
      cleanup(() => send.void_id(win, sel("setDelegate:"), null));
      cleanup(() => send.bool_id(win, sel("makeFirstResponder:"), null));
      cleanup(() => send.void_id(win, sel("orderOut:"), null));
      if (contentView !== null) cleanup(() => send.void(contentView, sel("release")));
      cleanup(() => send.void(win, sel("release")));
      if (delegate !== null) cleanup(() => send.void(delegate, sel("release")));
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "winding(darwin): errors while unwinding window creation");
    }
  }

  setSize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  get height(): number {
    return this.#height;
  }

  handleNativeWindowEvent(
    kind:
      | "close"
      | "resize"
      | "geometrychange"
      | "mouseenter"
      | "mouseleave"
      | "focus"
      | "blur"
      | "hidden"
      | "visible",
    event?: Deno.PointerValue,
  ): void {
    if (!this.#ready || this.#closed) return;
    switch (kind) {
      case "close":
        this.lib.pushEvent({ type: "close", window: this });
        return;
      case "resize":
        this.handleResize();
        return;
      case "geometrychange":
        this.invalidateCharacterCoordinates();
        return;
      case "mouseenter":
      case "mouseleave":
        if (event !== undefined && event !== null) {
          this.lib.pushEvent({ type: kind, ...pointerSnapshot(event, this), window: this });
        }
        return;
      case "focus":
        this.handleFocusGained();
        return;
      case "blur":
        this.handleFocusLost();
        return;
      case "hidden":
      case "visible":
        this.lib.pushEvent({
          type: "visibilitychange",
          visible: kind === "visible",
          window: this,
        });
        return;
    }
  }

  handleNativeKeyEvent(
    kind: "keydown" | "keyup" | "flagschanged",
    event: Deno.PointerValue,
  ): void {
    switch (kind) {
      case "keydown":
        this.handleKeyDown(event);
        return;
      case "keyup":
        this.handleKeyUp(event);
        return;
      case "flagschanged":
        this.handleFlagsChanged(event);
        return;
    }
  }

  handleNativePointerEvent(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    const translated = importPointerEvent(event, this);
    if (translated !== undefined) this.lib.pushEvent(translated);
  }

  handleNativeUpdateLayer(): void {
    if (this.#closed) return;
    const { sel, send } = this.lib.ffi;
    send.void_id(this.#layer, sel("setContents:"), this.#viewImage);
  }

  handleNativeInsertText(
    text: Deno.PointerValue,
    replacementLocation: bigint,
    replacementLength: bigint,
  ): void {
    this.handleInsertText(text, replacementLocation, replacementLength);
  }

  handleNativeSetMarkedText(
    text: Deno.PointerValue,
    selectionLocation: bigint,
    selectionLength: bigint,
    replacementLocation: bigint,
    replacementLength: bigint,
  ): void {
    this.handleSetMarkedText(
      text,
      selectionLocation,
      selectionLength,
      replacementLocation,
      replacementLength,
    );
  }

  handleNativeUnmarkText(): void {
    this.handleUnmarkText();
  }

  handleNativeCommand(command: Deno.PointerValue): void {
    this.handleCommand(command);
  }

  get nativeHasMarkedText(): boolean {
    return this.inputState.hasMarkedText;
  }

  get nativeMarkedRange(): NativeRange {
    return this.inputState.markedRange;
  }

  get nativeSelectedRange(): NativeRange {
    return this.inputState.selectedRange;
  }

  nativeValidAttributes(): Deno.PointerValue {
    return this.emptyArray();
  }

  nativeAttributedSubstring(
    location: bigint,
    length: bigint,
  ): { value: Deno.PointerValue; actualRange: NativeRange } | null {
    const substring = this.inputState.substringForRange(location, length);
    if (substring === null) return null;
    const { getClass, sel, send } = this.lib.ffi;
    const string = makeNSString(this.lib.ffi, substring.text);
    let attributed: Deno.PointerValue = null;
    try {
      const alloc = send.id(getClass("NSAttributedString"), sel("alloc"));
      attributed = send.id_id(alloc, sel("initWithString:"), string);
      if (attributed === null) {
        throw new Error("winding(darwin): failed to create attributed substring");
      }
      return {
        value: send.id(attributed, sel("autorelease")),
        actualRange: substring.actualRange,
      };
    } finally {
      send.void(string, sel("release"));
    }
  }

  nativeFirstRectForCharacterRange(
    location: bigint,
    length: bigint,
  ): { rect: Uint8Array; actualRange: NativeRange } {
    const actualRange = this.inputState.actualCaretRange(location, length) ?? {
      location: NS_NOT_FOUND,
      length: 0n,
    };
    return {
      rect: this.firstRectForCharacterRange(actualRange.location !== NS_NOT_FOUND),
      actualRange,
    };
  }

  handleResize(): void {
    if (this.#closed) return;
    const { nsrect, sel } = this.lib.ffi;
    const frame = nsrect.noArgs(this.contentView, sel("frame"));
    const width = Math.round(readStructF64(frame, 16));
    const height = Math.round(readStructF64(frame, 24));
    this.setSize(width, height);
    this.invalidateCharacterCoordinates();
    this.lib.pushEvent({ type: "resize", width, height, window: this });
  }

  handleFocusGained(): void {
    if (this.#closed) return;
    this.lib.pushEvent({ type: "focus", window: this });
    this.inputState.setNativeFocused(true);
    this.observeNativeInputContext();
    this.#flushInputState();
  }

  handleFocusLost(): void {
    if (this.#closed) return;
    this.inputState.setNativeFocused(false);
    this.inputState.observeNativeActive(false);
    this.#flushInputState();
    this.#discardNativeMarkedText();
    this.resetModifierState();
    this.#pressedKeys.clear();
    this.lib.pushEvent({ type: "blur", window: this });
  }

  handleKeyDown(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    this.lib.markNativeEventHandled(event);
    const native = this.#nativeKeyData(event);
    const key: KeyDownEvent = createKeyDownEvent({
      ...native.base,
      repeat: this.lib.ffi.send.bool(event, this.lib.ffi.sel("isARepeat")),
      editDisposition: "key-default",
    });
    this.inputState.beginKey(key);
    this.#keyDispatchActive = true;
    this.#producedText = undefined;
    this.#producedPreedit = false;
    try {
      if (this.inputState.active) {
        const { getClass, sel, send } = this.lib.ffi;
        const events = send.id_id(getClass("NSArray"), sel("arrayWithObject:"), event);
        send.void_id(this.contentView, sel("interpretKeyEvents:"), events);
      } else {
        this.#producedText = this.inputState.insertText(
          uninterpretedCommitText(native.characters, native.base.ctrlKey, native.base.metaKey) ?? "",
        );
      }
    } finally {
      const batch = this.inputState.finishKey();
      const completedKey = batch[0];
      if (completedKey?.type === "keydown") {
        const resolvedKey = logicalKeyForEvent({
          keycode: completedKey.keycode,
          code: completedKey.code,
          characters: native.characters,
          charactersIgnoringModifiers: native.charactersIgnoringModifiers,
          producedText: this.#producedText,
          producedPreedit: this.#producedPreedit || completedKey.isComposing,
          deadKey: this.#producedPreedit && completedKey.altKey,
        });
        this.#pressedKeys.press(completedKey.keycode, resolvedKey);
        // UI Events resolves `key` for every native repeat using the current
        // modifier/layout state rather than freezing the initial press value.
        completedKey.key = resolvedKey;
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
    const native = this.#nativeKeyData(event);
    const matchedPress = this.#pressedKeys.has(native.base.keycode);
    const retainedKey = this.#pressedKeys.release(native.base.keycode, native.base.key);
    const currentKey = matchedPress && retainedKey !== "Dead" ? native.base.key : retainedKey;
    const key: KeyUpEvent = createKeyUpEvent({
      ...native.base,
      key: currentKey,
    });
    this.lib.pushEvent(key);
  }

  /** A keydown consumed by AppKit before reaching the content responder is OS-owned. */
  handlePlatformKeyDown(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    const native = this.#nativeKeyData(event);
    const key = createKeyDownEvent({
      ...native.base,
      repeat: this.lib.ffi.send.bool(event, this.lib.ffi.sel("isARepeat")),
      editDisposition: "platform",
    });
    this.#pressedKeys.press(key.keycode, key.key);
    this.lib.pushEvent(key);
  }

  handleFlagsChanged(event: Deno.PointerValue): void {
    if (this.#closed || event === null) return;
    this.lib.markNativeEventHandled(event);
    // AppKit only defines `characters` and `charactersIgnoringModifiers` for
    // key-down/up events. In particular, querying either property on a
    // FlagsChanged event raises NSInternalInconsistencyException, which cannot
    // safely unwind through the FFI boundary.
    const base = this.#nativeKeyBase(event);
    const code = base.code;
    const flags = this.lib.ffi.send.u64(event, this.lib.ffi.sel("modifierFlags"));
    const flag = modifierFlagForCode(code);
    const type = this.inputState.modifierTransition(code, flags, flag);
    if (type === "keydown") {
      const key: KeyDownEvent = createKeyDownEvent({
        ...base,
        repeat: false,
        editDisposition: "key-default",
      });
      this.#pressedKeys.press(key.keycode, key.key);
      this.lib.pushEvent(key);
    } else {
      const key: KeyUpEvent = createKeyUpEvent({
        ...base,
        key: this.#pressedKeys.release(base.keycode, base.key),
      });
      this.lib.pushEvent(key);
    }
  }

  resetModifierState(): void {
    this.inputState.resetModifiers();
  }

  handleInsertText(
    value: Deno.PointerValue,
    replacementLocation = NS_NOT_FOUND,
    replacementLength = 0n,
  ): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.active) return;
    const text = readInputString(value, this.lib.ffi);
    const committed = this.inputState.insertText(text, replacementLocation, replacementLength);
    if (this.#keyDispatchActive) this.#producedText = committed;
    this.#flushInputState();
  }

  handleSetMarkedText(
    value: Deno.PointerValue,
    selectionLocation: bigint,
    selectionLength: bigint,
    replacementLocation = NS_NOT_FOUND,
    replacementLength = 0n,
  ): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.active) return;
    if (this.#keyDispatchActive) this.#producedPreedit = true;
    this.inputState.setMarkedText(
      readInputString(value, this.lib.ffi),
      selectionLocation,
      selectionLength,
      replacementLocation,
      replacementLength,
    );
    this.#flushInputState();
  }

  handleUnmarkText(): void {
    if (this.#closed || this.#discardingMarkedText || !this.inputState.active) return;
    const committed = this.inputState.unmarkText();
    if (this.#keyDispatchActive) this.#producedText = committed;
    this.#flushInputState();
  }

  handleCommand(command: Deno.PointerValue): void {
    if (this.#closed || command === null || !this.inputState.active) return;
    this.inputState.performCommand(this.lib.ffi.selectorName(command));
    this.#flushInputState();
  }

  emptyArray(): Deno.PointerValue {
    const { getClass, sel, send } = this.lib.ffi;
    return send.id(getClass("NSArray"), sel("array"));
  }

  firstRectForCharacterRange(zeroWidthCaret = false): Uint8Array {
    const { nsrect, sel } = this.lib.ffi;
    const bounds = nsrect.noArgs(this.contentView, sel("bounds"));
    const viewHeight = readStructF64(bounds, 24);
    const local = cocoaRectFromClient(this.inputState.cursorArea, viewHeight);
    if (zeroWidthCaret) local.width = 0;
    const windowRect = nsrect.rectPointerArg(
      this.contentView,
      sel("convertRect:toView:"),
      new Float64Array([local.x, local.y, local.width, local.height]),
      null,
    );
    return nsrect.rectArg(
      this.nsWindow,
      sel("convertRectToScreen:"),
      windowRect,
    );
  }

  setImeEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.lib.withAutoreleasePool(() => {
      if (enabled === this.inputState.imeEnabled) return;
      this.inputState.setImeEnabled(enabled);
      this.observeNativeInputContext();
      this.#flushInputState();
      if (!enabled) this.#discardNativeMarkedText();
    });
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.#assertOpen();
    this.lib.withAutoreleasePool(() => {
      this.inputState.setCursorArea(x, y, width, height);
      this.invalidateCharacterCoordinates();
    });
  }

  invalidateCharacterCoordinates(): void {
    if (this.#closed) return;
    const { sel, send } = this.lib.ffi;
    const inputContext = send.id(this.contentView, sel("inputContext"));
    if (inputContext !== null) send.void(inputContext, sel("invalidateCharacterCoordinates"));
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    this.#assertOpen();
    this.inputState.setSurroundingText(text, selectionStartBytes, selectionEndBytes);
  }

  cancelComposition(): void {
    this.#assertOpen();
    this.lib.withAutoreleasePool(() => {
      this.inputState.cancelComposition();
      this.#flushInputState();
      this.#discardNativeMarkedText();
    });
  }

  observeNativeInputContext(): void {
    if (this.#closed) return;
    const { getClass, sel, send } = this.lib.ffi;
    const ownContext = send.id(this.contentView, sel("inputContext"));
    this.inputState.setNativeAvailable(ownContext !== null);
    const currentContext = send.id(
      getClass("NSTextInputContext"),
      sel("currentInputContext"),
    );
    const client = currentContext === null ? null : send.id(currentContext, sel("client"));
    const ownsCurrentContext = client !== null && pointerId(client) === pointerId(this.contentView);
    this.inputState.observeNativeActive(ownsCurrentContext);
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

  #nativeKeyData(event: Deno.PointerValue): {
    base: Omit<KeyEventBase, "type">;
    characters: string;
    charactersIgnoringModifiers: string;
  } {
    const { sel, send } = this.lib.ffi;
    const charactersPointer = send.id(event, sel("characters"));
    const eventFlags = send.u64(event, sel("modifierFlags"));
    const glyphModifiers = eventFlags & (
      NS_EVENT_MODIFIER_FLAG_CAPS_LOCK |
      NS_EVENT_MODIFIER_FLAG_SHIFT |
      NS_EVENT_MODIFIER_FLAG_OPTION
    );
    const charactersIgnoringModifiersPointer = send.id_u64(
      event,
      sel("charactersByApplyingModifiers:"),
      glyphModifiers,
    );
    const characters = charactersPointer === null ? "" : readCFString(this.lib.ffi.cf, charactersPointer);
    const charactersIgnoringModifiers = charactersIgnoringModifiersPointer === null
      ? ""
      : readCFString(this.lib.ffi.cf, charactersIgnoringModifiersPointer);
    const base = this.#nativeKeyBase(
      event,
      logicalKeyForEvent({
        keycode: send.u16(event, sel("keyCode")),
        code: getDomCode(
          send.u16(event, sel("keyCode")),
          this.lib.ffi.isIsoKeyboard(),
        ),
        characters,
        charactersIgnoringModifiers,
      }),
    );
    return { base, characters, charactersIgnoringModifiers };
  }

  /** Read the NSEvent fields that are valid for every keyboard event type. */
  #nativeKeyBase(
    event: Deno.PointerValue,
    logicalKey?: string,
  ): Omit<KeyEventBase, "type"> {
    const { sel, send } = this.lib.ffi;
    const keycode = send.u16(event, sel("keyCode"));
    const code = getDomCode(keycode, this.lib.ffi.isIsoKeyboard());
    return {
      keycode,
      code,
      key: logicalKey ?? logicalKeyForEvent({
        keycode,
        code,
        characters: "",
        charactersIgnoringModifiers: "",
      }),
      location: keycode === 0x47 ? 3 : keyLocationForCode(code),
      isComposing: this.inputState.composing,
      ...getModifiers(event, this.lib.ffi),
      window: this,
    };
  }

  setTitle(title: string): void {
    this.#assertOpen();
    this.lib.withAutoreleasePool(() => {
      const { sel, send } = this.lib.ffi;
      const titleString = makeNSString(this.lib.ffi, title);
      try {
        send.void_id(this.nsWindow, sel("setTitle:"), titleString);
      } finally {
        send.void(titleString, sel("release"));
      }
    });
  }

  blit(rgba: Uint8Array, width: number, height: number): void {
    this.#assertOpen();
    this.lib.withAutoreleasePool(() => this.#blit(rgba, width, height));
  }

  #blit(rgba: Uint8Array, width: number, height: number): void {
    const { cf, cg, sel, send } = this.lib.ffi;
    const { rowBytes } = validatedBlitGeometry(rgba, width, height, this.#width, this.#height);
    // CFDataCreate copies the bytes into immutable native-owned storage. The
    // provider retains that storage until the last CGImage/CALayer reference
    // is gone, so no JavaScript buffer needs an approximate lifetime root.
    let data: Deno.PointerValue = null;
    let provider: Deno.PointerValue = null;
    let image: Deno.PointerValue = null;
    try {
      data = cf.symbols.CFDataCreate(null, rgba, BigInt(rgba.byteLength));
      if (data === null) throw new Error("winding(darwin): CFDataCreate failed");
      provider = cg.symbols.CGDataProviderCreateWithCFData(data);
      if (provider === null) throw new Error("winding(darwin): CGDataProviderCreateWithCFData failed");
      image = cg.symbols.CGImageCreate(
        BigInt(width),
        BigInt(height),
        8n,
        32n,
        rowBytes,
        this.lib.colorSpace,
        RGBA_BITMAP_INFO,
        provider,
        null,
        false,
        0,
      );
      if (image === null) throw new Error("winding(darwin): CGImageCreate failed");
      const previous = this.#viewImage;
      this.#viewImage = image;
      image = null;
      try {
        send.void_bool(this.contentView, sel("setNeedsDisplay:"), true);
      } catch (error) {
        image = this.#viewImage;
        this.#viewImage = previous;
        throw error;
      }
      if (previous !== null) cf.symbols.CFRelease(previous);
    } finally {
      try {
        if (image !== null) cf.symbols.CFRelease(image);
      } finally {
        try {
          if (provider !== null) cf.symbols.CFRelease(provider);
        } finally {
          if (data !== null) cf.symbols.CFRelease(data);
        }
      }
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.lib.assertMainThread();
    this.lib.withAutoreleasePool(() => this.#closeNative());
  }

  #closeNative(): void {
    this.#closed = true;
    this.#ready = false;
    const errors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    cleanup(() => this.lib.unregisterWindow(this));
    cleanup(() => this.lib.nativeClasses.unregisterView(this.contentView));
    cleanup(() => this.lib.nativeClasses.unregisterDelegate(this.#delegate));
    cleanup(() => this.#pressedKeys.clear());
    cleanup(() => this.inputState.close());
    cleanup(() => this.#discardNativeMarkedText());
    const { sel, send } = this.lib.ffi;
    cleanup(() => {
      if (this.#viewImage !== null) {
        this.lib.ffi.cf.symbols.CFRelease(this.#viewImage);
        this.#viewImage = null;
      }
    });
    cleanup(() => send.void_id(this.nsWindow, sel("setDelegate:"), null));
    cleanup(() => send.bool_id(this.nsWindow, sel("makeFirstResponder:"), null));
    cleanup(() => send.void_id(this.nsWindow, sel("orderOut:"), null));
    cleanup(() => send.void(this.contentView, sel("release")));
    cleanup(() => send.void(this.nsWindow, sel("release")));
    cleanup(() => send.void(this.#delegate, sel("release")));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "winding(darwin): errors while closing window");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("winding(darwin): window is closed");
    this.lib.assertOpen();
  }
}

export function nativeMouseButton(buttonNumber: number | bigint): MouseButton | undefined {
  switch (buttonNumber) {
    case 0:
    case 0n:
      return "left";
    case 1:
    case 1n:
      return "right";
    case 2:
    case 2n:
      return "middle";
    case 3:
    case 3n:
      return "back";
    case 4:
    case 4n:
      return "forward";
    default:
      return undefined;
  }
}

class DarwinLibrary implements Library {
  readonly ffi: DarwinFfi;
  readonly nsApp: Deno.PointerValue;
  readonly colorSpace: Deno.PointerObject;
  readonly nativeClasses: DarwinNativeClasses;
  readonly windows = new Map<bigint, DarwinWindow>();
  readonly #distantPast: Deno.PointerValue;
  readonly #runLoopMode: Deno.PointerValue;
  readonly #queue = new EventQueue<UIEvent>();
  readonly #eventClock = new NativeEventClock();
  #handledNativeEvent: bigint | undefined;
  #closed = false;

  constructor() {
    this.ffi = openDarwinFfi();
    let distantPast: Deno.PointerValue = null;
    let runLoopMode: Deno.PointerValue = null;
    let colorSpace: Deno.PointerValue = null;
    let initialized: {
      nativeClasses: DarwinNativeClasses;
      nsApp: Deno.PointerObject;
      distantPast: Deno.PointerObject;
      runLoopMode: Deno.PointerObject;
      colorSpace: Deno.PointerObject;
    };
    try {
      initialized = withAutoreleasePool(this.ffi, () => {
        const { cg, getClass, sel, send } = this.ffi;
        const nativeClasses = ensureNativeClasses(this.ffi);
        const nsApp = send.id(getClass("NSApplication"), sel("sharedApplication"));
        if (nsApp === null) throw new Error("winding(darwin): NSApplication.sharedApplication returned nil");
        if (!send.bool_i64(nsApp, sel("setActivationPolicy:"), NS_APPLICATION_ACTIVATION_POLICY_REGULAR)) {
          throw new Error("winding(darwin): NSApplication rejected the regular activation policy");
        }
        send.void(nsApp, sel("finishLaunching"));
        distantPast = send.id(send.id(getClass("NSDate"), sel("distantPast")), sel("retain"));
        if (distantPast === null) throw new Error("winding(darwin): failed to retain NSDate.distantPast");
        runLoopMode = makeNSString(this.ffi, "kCFRunLoopDefaultMode");
        colorSpace = cg.symbols.CGColorSpaceCreateDeviceRGB();
        if (colorSpace === null) throw new Error("winding(darwin): CGColorSpaceCreateDeviceRGB failed");
        return { nativeClasses, nsApp, distantPast, runLoopMode, colorSpace };
      });
    } catch (error) {
      const errors = [error];
      const cleanup = (operation: () => void): void => {
        try {
          operation();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      };
      const { cf, sel, send } = this.ffi;
      if (colorSpace !== null) cleanup(() => cf.symbols.CFRelease(colorSpace));
      if (runLoopMode !== null) cleanup(() => send.void(runLoopMode, sel("release")));
      if (distantPast !== null) cleanup(() => send.void(distantPast, sel("release")));
      cleanup(() => this.ffi.close());
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "winding(darwin): errors while unwinding library creation");
    }
    this.nativeClasses = initialized.nativeClasses;
    this.nsApp = initialized.nsApp;
    this.#distantPast = initialized.distantPast;
    this.#runLoopMode = initialized.runLoopMode;
    this.colorSpace = initialized.colorSpace;
  }

  assertMainThread(): void {
    this.ffi.assertMainThread();
  }

  assertOpen(): void {
    if (this.#closed) throw new Error("winding(darwin): library is closed");
    this.assertMainThread();
  }

  withAutoreleasePool<T>(operation: () => T): T {
    return withAutoreleasePool(this.ffi, operation);
  }

  registerWindow(window: DarwinWindow): void {
    this.windows.set(window.id, window);
  }

  unregisterWindow(window: DarwinWindow): void {
    if (this.windows.get(window.id) === window) this.windows.delete(window.id);
    this.#queue.purgeWindow(window);
  }

  pushEvent(event: UIEvent): void {
    this.#queue.push(event);
  }

  pushEvents(events: UIEvent[]): void {
    this.#queue.pushBatch(events);
  }

  markNativeEventHandled(event: Deno.PointerValue): void {
    if (event !== null) this.#handledNativeEvent = pointerId(event);
  }

  pointerTimeStamp(nativeSeconds: number): number {
    return this.#eventClock.timeStamp(nativeSeconds * 1000);
  }

  openWindow(x = 0, y = 0, w = 800, h = 600): DarwinWindow {
    this.assertOpen();
    return this.withAutoreleasePool(() => new DarwinWindow(this, x, y, w, h));
  }

  event(): UIEvent | undefined {
    this.assertOpen();
    this.nativeClasses.throwIfCallbackFailed();
    const { getClass, sel, send } = this.ffi;
    if (this.#queue.length) return this.#queue.shift();
    this.withAutoreleasePool(() => {
      for (const window of this.windows.values()) window.observeNativeInputContext();
    });
    this.nativeClasses.throwIfCallbackFailed();
    if (this.#queue.length) return this.#queue.shift();
    for (let dispatched = 0; dispatched < MAX_NATIVE_EVENTS_PER_POLL; dispatched++) {
      const poolAlloc = send.id(getClass("NSAutoreleasePool"), sel("alloc"));
      const pool = send.id(poolAlloc, sel("init"));
      if (pool === null) throw new Error("winding(darwin): failed to create event autorelease pool");
      try {
        const event = send.id_u64PtrPtrBool(
          this.nsApp,
          sel("nextEventMatchingMask:untilDate:inMode:dequeue:"),
          NS_EVENT_MASK_ANY,
          this.#distantPast,
          this.#runLoopMode,
          true,
        );
        this.nativeClasses.throwIfCallbackFailed();
        if (event === null) {
          send.void(this.nsApp, sel("updateWindows"));
          break;
        }

        this.#handledNativeEvent = undefined;
        const nativeType = send.u64(event, sel("type"));
        send.void_id(this.nsApp, sel("sendEvent:"), event);
        send.void(this.nsApp, sel("updateWindows"));
        this.nativeClasses.throwIfCallbackFailed();

        if (
          (nativeType === NSEventType.KeyDown ||
            nativeType === NSEventType.KeyUp ||
            nativeType === NSEventType.FlagsChanged) &&
          this.#handledNativeEvent !== pointerId(event)
        ) {
          this.#pushKeyboardFallback(event, nativeType);
          this.nativeClasses.throwIfCallbackFailed();
        }

        if (this.#queue.length) return this.#queue.shift();
      } finally {
        send.void(pool, sel("drain"));
        this.nativeClasses.throwIfCallbackFailed();
      }
    }
    this.nativeClasses.throwIfCallbackFailed();
    return this.#queue.shift();
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
    if (type === NSEventType.KeyDown) window.handlePlatformKeyDown(event);
    else window.handleKeyUp(event);
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.assertMainThread();
    this.#closed = true;
    this.#queue.close();

    const cleanupErrors: unknown[] = [];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    cleanup(() =>
      this.withAutoreleasePool(() => {
        for (const window of [...this.windows.values()]) cleanup(() => window.close());
        cleanup(() => this.ffi.send.void(this.#runLoopMode, this.ffi.sel("release")));
        cleanup(() => this.ffi.send.void(this.#distantPast, this.ffi.sel("release")));
        cleanup(() => this.ffi.cf.symbols.CFRelease(this.colorSpace));
      })
    );
    cleanup(() => this.nativeClasses.throwIfCallbackFailed());
    cleanup(() => this.ffi.close());

    if (activeLibrary === this) activeLibrary = undefined;
    if (darwinGlobals[ACTIVE_LIBRARY_SLOT] === this) delete darwinGlobals[ACTIVE_LIBRARY_SLOT];

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "winding(darwin): errors during native shutdown");
    }
  }
}

let activeLibrary: DarwinLibrary | undefined;
const ACTIVE_LIBRARY_SLOT = "__quox_winding_darwin_active_library__";
const darwinGlobals = globalThis as unknown as Record<string, unknown>;

function importPointerEvent(event: Deno.PointerValue, window: DarwinWindow): UIEvent | undefined {
  const { sel, send } = window.lib.ffi;
  const type = send.u64(event, sel("type"));

  switch (type) {
    case NSEventType.LeftMouseDown:
    case NSEventType.LeftMouseUp:
    case NSEventType.RightMouseDown:
    case NSEventType.RightMouseUp:
    case NSEventType.OtherMouseDown:
    case NSEventType.OtherMouseUp: {
      const pressed = type === NSEventType.LeftMouseDown || type === NSEventType.RightMouseDown ||
        type === NSEventType.OtherMouseDown;
      const buttonNumber = type === NSEventType.LeftMouseDown || type === NSEventType.LeftMouseUp
        ? 0n
        : type === NSEventType.RightMouseDown || type === NSEventType.RightMouseUp
        ? 1n
        : send.i64(event, sel("buttonNumber"));
      const button = nativeMouseButton(buttonNumber);
      if (button === undefined) return undefined;
      return {
        type: pressed ? "mousedown" : "mouseup",
        button,
        detail: Math.max(0, Number(send.i64(event, sel("clickCount")))),
        ...pointerSnapshot(event, window, button, pressed),
        window,
      };
    }
    case NSEventType.MouseMoved:
    case NSEventType.LeftMouseDragged:
    case NSEventType.RightMouseDragged:
    case NSEventType.OtherMouseDragged: {
      return { type: "mousemove", ...pointerSnapshot(event, window), window };
    }
    case NSEventType.ScrollWheel: {
      const delta = browserWheelDelta(
        send.f64(event, sel("scrollingDeltaX")),
        send.f64(event, sel("scrollingDeltaY")),
        send.bool(event, sel("hasPreciseScrollingDeltas")),
      );
      return { type: "wheel", ...pointerSnapshot(event, window), ...delta, window };
    }
    default:
      return undefined;
  }
}

function pointerSnapshot(
  event: Deno.PointerValue,
  window: DarwinWindow,
  changedButton?: MouseButton,
  pressed?: boolean,
): {
  x: number;
  y: number;
  buttons: number;
  timeStamp: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
} {
  const { getClass, sel, send } = window.lib.ffi;
  const windowPoint = send.point(event, sel("locationInWindow")) as Uint8Array;
  const point = send.point_pointId(
    window.contentView,
    sel("convertPoint:fromView:"),
    windowPoint,
    null,
  ) as Uint8Array;
  let buttons = Number(send.u64(getClass("NSEvent"), sel("pressedMouseButtons")) & 0x1fn);
  if (changedButton !== undefined && pressed !== undefined) {
    const mask = mouseButtonMask(changedButton);
    buttons = pressed ? buttons | mask : buttons & ~mask;
  }
  return {
    x: readStructF64(point, 0),
    y: window.height - readStructF64(point, 8),
    buttons,
    timeStamp: window.lib.pointerTimeStamp(send.f64(event, sel("timestamp"))),
    ...pointerModifiers(getModifiers(event, window.lib.ffi)),
  };
}

function pointerModifiers(modifiers: KeyModifiers): PointerModifiers {
  return {
    shiftKey: modifiers.shiftKey,
    ctrlKey: modifiers.ctrlKey,
    altKey: modifiers.altKey,
    metaKey: modifiers.metaKey,
  };
}

function mouseButtonMask(button: MouseButton): number {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    case "back":
      return 8;
    case "forward":
      return 16;
  }
}

export const load: LoadLibrary = () => {
  if (activeLibrary !== undefined || darwinGlobals[ACTIVE_LIBRARY_SLOT] !== undefined) {
    throw new Error("winding(darwin): only one Darwin library may be open at a time");
  }
  const library = new DarwinLibrary();
  activeLibrary = library;
  darwinGlobals[ACTIVE_LIBRARY_SLOT] = library;
  return library;
};
