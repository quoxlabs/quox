import type { KeyModifiers, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { getDomCode } from "./dom_code.ts";
import {
  addMethod as runtimeAddMethod,
  allocateClassPair as runtimeAllocateClassPair,
  APPKIT,
  cfSymbols,
  cgSymbols,
  CORE_FOUNDATION,
  CORE_GRAPHICS,
  cStr,
  getClass as runtimeGetClass,
  LIBOBJC,
  NSPOINT,
  NSRECT,
  type ObjcRuntime,
  readStructF64,
  RGBA_BITMAP_INFO,
  runtimeSymbols,
  sel as runtimeSel,
} from "./ffi.ts";

// NSWindowStyleMask: Titled | Closable | Resizable | Miniaturizable
const NS_WINDOW_STYLE_MASK = 1 | 2 | 8 | 4;
const NS_BACKING_STORE_BUFFERED = 2n;
const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0n;
const NS_EVENT_MASK_ANY = 0xFFFFFFFFFFFFFFFFn;
const NS_EVENT_MODIFIER_FLAG_SHIFT = 1n << 17n;
const NS_EVENT_MODIFIER_FLAG_CONTROL = 1n << 18n;
const NS_EVENT_MODIFIER_FLAG_OPTION = 1n << 19n;
const NS_EVENT_MODIFIER_FLAG_COMMAND = 1n << 20n;

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
    id_rectU64U64Bool: openMsgSend(
      libraries,
      ["pointer", "pointer", NSRECT, "u64", "u64", "bool"],
      "pointer",
    ),
    id_u64PtrPtrBool: openMsgSend(
      libraries,
      ["pointer", "pointer", "u64", "pointer", "pointer", "bool"],
      "pointer",
    ),
    void: openMsgSend(libraries, ["pointer", "pointer"], "void"),
    void_id: openMsgSend(libraries, ["pointer", "pointer", "pointer"], "void"),
    void_bool: openMsgSend(libraries, ["pointer", "pointer", "bool"], "void"),
    void_i64: openMsgSend(libraries, ["pointer", "pointer", "i64"], "void"),
    point: openMsgSend(libraries, ["pointer", "pointer"], NSPOINT),
    rect: openMsgSend(libraries, ["pointer", "pointer"], NSRECT),
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

    const cg = Deno.dlopen(CORE_GRAPHICS, cgSymbols);
    opened.push(cg);

    const cf = Deno.dlopen(CORE_FOUNDATION, cfSymbols);
    opened.push(cf);

    return {
      appKit,
      runtime,
      send,
      cg,
      cf,
      getClass: (name: string) => runtimeGetClass(runtime, name),
      sel: (name: string) => runtimeSel(runtime, name),
      allocateClassPair: (superclass: Deno.PointerObject, name: string) =>
        runtimeAllocateClassPair(runtime, superclass, name),
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

function getModifiers(event: Deno.PointerValue, lib: DarwinLibrary): KeyModifiers {
  const { sel, send } = lib.ffi;
  const flags = send.u64(event, sel("modifierFlags"));
  const metaKey = (flags & NS_EVENT_MODIFIER_FLAG_COMMAND) !== 0n;
  return {
    shiftKey: (flags & NS_EVENT_MODIFIER_FLAG_SHIFT) !== 0n,
    ctrlKey: (flags & NS_EVENT_MODIFIER_FLAG_CONTROL) !== 0n,
    altKey: (flags & NS_EVENT_MODIFIER_FLAG_OPTION) !== 0n,
    metaKey,
    accelKey: metaKey,
  };
}

class DarwinWindow implements Window {
  readonly id: bigint;
  readonly nsWindow: Deno.PointerValue;
  readonly contentView: Deno.PointerValue;
  readonly #layer: Deno.PointerValue;
  readonly #delegate: Deno.PointerValue;
  #width: number;
  #height: number;
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

    const delegateAlloc = send.id(lib.delegateClass, sel("alloc"));
    this.#delegate = send.id(delegateAlloc, sel("init"));
    lib.delegates.set(pointerId(this.#delegate), this);
    send.void_id(win, sel("setDelegate:"), this.#delegate);

    this.contentView = send.id(win, sel("contentView"));
    send.void_bool(this.contentView, sel("setWantsLayer:"), true);
    this.#layer = send.id(this.contentView, sel("layer"));

    send.void_bool(win, sel("makeKeyAndOrderFront:"), false);
    send.void_bool(lib.nsApp, sel("activateIgnoringOtherApps:"), true);

    lib.windows.set(this.id, this);
  }

  setSize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  get height(): number {
    return this.#height;
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
    this.lib.windows.delete(this.id);
    this.lib.delegates.delete(pointerId(this.#delegate));
  }
}

const BUTTONS = [, "left", "middle", "right"] as const;

class DarwinLibrary implements Library {
  readonly ffi: DarwinFfi;
  readonly nsApp: Deno.PointerValue;
  readonly colorSpace: Deno.PointerObject;
  readonly delegateClass: Deno.PointerObject;
  readonly windows = new Map<bigint, DarwinWindow>();
  readonly delegates = new Map<bigint, DarwinWindow>();
  readonly #distantPast: Deno.PointerValue;
  readonly #runLoopMode: Deno.PointerValue;
  readonly #shouldCloseCallback: Deno.UnsafeCallback<
    { parameters: ["pointer", "pointer", "pointer"]; result: "bool" }
  >;
  readonly #didResizeCallback: Deno.UnsafeCallback<
    { parameters: ["pointer", "pointer", "pointer"]; result: "void" }
  >;
  #queue: UIEvent[] = [];

  constructor() {
    this.ffi = openDarwinFfi();
    const {
      addMethod,
      allocateClassPair,
      cg,
      getClass,
      registerClassPair,
      sel,
      send,
    } = this.ffi;
    this.nsApp = send.id(getClass("NSApplication"), sel("sharedApplication"));
    send.void_i64(this.nsApp, sel("setActivationPolicy:"), NS_APPLICATION_ACTIVATION_POLICY_REGULAR);
    send.void(this.nsApp, sel("finishLaunching"));
    this.#distantPast = send.id(getClass("NSDate"), sel("distantPast"));
    this.#runLoopMode = makeNSString(this.ffi, "kCFRunLoopDefaultMode");
    const colorSpace = cg.symbols.CGColorSpaceCreateDeviceRGB();
    if (colorSpace === null) throw new Error("winding(darwin): CGColorSpaceCreateDeviceRGB failed");
    this.colorSpace = colorSpace;

    this.#shouldCloseCallback = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "bool" },
      (self) => {
        const window = this.delegates.get(pointerId(self));
        this.#queue.push({ type: "close", window });
        // Never let AppKit tear the window down itself; the application
        // decides when to actually close, matching the win32/x11 backends.
        return false;
      },
    );
    this.#didResizeCallback = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      (self) => {
        const window = this.delegates.get(pointerId(self));
        if (window === undefined) return;
        const frame = send.rect(window.contentView, sel("frame")) as Uint8Array;
        const width = Math.round(readStructF64(frame, 16));
        const height = Math.round(readStructF64(frame, 24));
        window.setSize(width, height);
        this.#queue.push({ type: "resize", width, height, window });
      },
    );

    this.delegateClass = allocateClassPair(getClass("NSObject"), "WindingWindowDelegate");
    addMethod(this.delegateClass, sel("windowShouldClose:"), this.#shouldCloseCallback.pointer, "c@:@");
    addMethod(this.delegateClass, sel("windowDidResize:"), this.#didResizeCallback.pointer, "v@:@");
    registerClassPair(this.delegateClass);
  }

  openWindow(x = 0, y = 0, w = 800, h = 600): DarwinWindow {
    return new DarwinWindow(this, x, y, w, h);
  }

  event(): UIEvent | undefined {
    const { sel, send } = this.ffi;
    if (this.#queue.length) return this.#queue.shift();
    while (true) {
      const event = send.id_u64PtrPtrBool(
        this.nsApp,
        sel("nextEventMatchingMask:untilDate:inMode:dequeue:"),
        NS_EVENT_MASK_ANY,
        this.#distantPast,
        this.#runLoopMode,
        true,
      );
      if (event === null) break;
      // Let AppKit do its normal internal dispatch (dragging, resizing, the
      // close button's default action, ...); this may also invoke our
      // delegate synchronously and push onto #queue.
      send.void_id(this.nsApp, sel("sendEvent:"), event);
      if (this.#queue.length) return this.#queue.shift();
      const translated = importEvent(event, this);
      if (translated !== undefined) return translated;
    }
    return this.#queue.length ? this.#queue.shift() : undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }
  close(): void {
    this.#shouldCloseCallback.close();
    this.#didResizeCallback.close();
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
    case NSEventType.KeyDown: {
      const keycode = send.u16(event, sel("keyCode"));
      return { type: "keydown", keycode, code: getDomCode(keycode), ...getModifiers(event, lib), window };
    }
    case NSEventType.KeyUp: {
      const keycode = send.u16(event, sel("keyCode"));
      return { type: "keyup", keycode, code: getDomCode(keycode), ...getModifiers(event, lib), window };
    }
    default:
      return undefined;
  }
}

export const load: LoadLibrary = () => new DarwinLibrary();
