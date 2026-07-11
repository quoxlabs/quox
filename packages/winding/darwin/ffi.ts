// Minimal Objective-C runtime + AppKit/CoreGraphics FFI bindings.
//
// macOS has no stable C ABI for windowing (unlike X11/Win32): everything goes
// through the Objective-C message-dispatch runtime (`objc_msgSend`). Deno's FFI
// requires a fixed parameter/result shape per symbol, so the Darwin backend
// opens `libobjc` once per distinct call shape and shares those handles.

// `initWithUTF8String:` and friends require genuine UTF-8 bytes.
import { utf8CString as cStr } from "../text_encoding.ts";
export { cStr };

export const LIBOBJC = "/usr/lib/libobjc.dylib";
export const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
export const CORE_GRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
export const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
export const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
export const HITOOLBOX = "/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox";

export const systemSymbols = {
  pthread_main_np: { parameters: [], result: "i32" },
} as const satisfies Deno.ForeignLibraryInterface;

export const hitoolboxSymbols = {
  LMGetKbdType: { parameters: [], result: "u8" },
  KBGetLayoutType: { parameters: ["i16"], result: "u32" },
} as const satisfies Deno.ForeignLibraryInterface;

export type DarwinSystem = Deno.DynamicLibrary<typeof systemSymbols>;

/** AppKit objects and event dispatch are confined to the process main thread. */
export function assertMainThread(system: DarwinSystem): void {
  if (system.symbols.pthread_main_np() === 0) {
    throw new Error("winding(darwin): AppKit must be used on the process main thread (not a Worker)");
  }
}

export const runtimeSymbols = {
  objc_getClass: { parameters: ["buffer"], result: "pointer" },
  objc_getProtocol: { parameters: ["buffer"], result: "pointer" },
  sel_registerName: { parameters: ["buffer"], result: "pointer" },
  sel_getName: { parameters: ["pointer"], result: "pointer" },
  objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
  objc_disposeClassPair: { parameters: ["pointer"], result: "void" },
  objc_registerClassPair: { parameters: ["pointer"], result: "void" },
  class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
  class_addProtocol: { parameters: ["pointer", "pointer"], result: "bool" },
  class_conformsToProtocol: { parameters: ["pointer", "pointer"], result: "bool" },
} as const satisfies Deno.ForeignLibraryInterface;

export type ObjcRuntime = Deno.DynamicLibrary<typeof runtimeSymbols>;

export function getClass(runtime: ObjcRuntime, name: string): Deno.PointerObject {
  const p = runtime.symbols.objc_getClass(cStr(name));
  if (p === null) throw new Error(`winding(darwin) could not find Objective-C class '${name}'`);
  return p;
}
export function sel(runtime: ObjcRuntime, name: string): Deno.PointerValue {
  return runtime.symbols.sel_registerName(cStr(name));
}
export function selectorName(runtime: ObjcRuntime, selector: Deno.PointerValue): string {
  const p = runtime.symbols.sel_getName(selector);
  if (p === null) throw new Error("winding(darwin) could not read Objective-C selector name");
  return new Deno.UnsafePointerView(p).getCString();
}
export function getProtocol(runtime: ObjcRuntime, name: string): Deno.PointerObject {
  const p = runtime.symbols.objc_getProtocol(cStr(name));
  if (p === null) throw new Error(`winding(darwin) could not find Objective-C protocol '${name}'`);
  return p;
}
export function allocateClassPair(
  runtime: ObjcRuntime,
  superclass: Deno.PointerObject,
  name: string,
): Deno.PointerObject {
  const p = runtime.symbols.objc_allocateClassPair(superclass, cStr(name), 0n);
  if (p === null) throw new Error(`winding(darwin) failed to allocate class '${name}'`);
  return p;
}
export function addMethod(
  runtime: ObjcRuntime,
  cls: Deno.PointerObject,
  selector: Deno.PointerValue,
  imp: Deno.PointerValue,
  typeEncoding: string,
): void {
  const ok = runtime.symbols.class_addMethod(cls, selector, imp, cStr(typeEncoding));
  if (!ok) throw new Error("winding(darwin) failed to add method");
}
export function addProtocol(
  runtime: ObjcRuntime,
  cls: Deno.PointerObject,
  protocol: Deno.PointerObject,
): void {
  const ok = runtime.symbols.class_addProtocol(cls, protocol);
  if (!ok) throw new Error("winding(darwin) failed to add protocol to class");
}

export function classConformsToProtocol(
  runtime: ObjcRuntime,
  cls: Deno.PointerObject,
  protocol: Deno.PointerObject,
): boolean {
  return runtime.symbols.class_conformsToProtocol(cls, protocol);
}

// Objective-C's BOOL is a C++ bool on Apple arm64 and a signed char on
// x86_64. This matters in dynamic method type encodings even though Deno uses
// the same `bool` FFI type for both calling conventions.
export const OBJC_BOOL_ENCODING = Deno.build.arch === "aarch64" ? "B" : "c";

// A 4-tuple of f64 matches an NSRect { origin: {x, y}, size: {w, h} } layout on
// 64-bit (CGFloat == double). Deno's FFI struct support marshals this per the
// platform ABI, including the arm64/x86_64 large-struct-by-reference rules.
export const NSRECT = { struct: ["f64", "f64", "f64", "f64"] } as const;
export const NSPOINT = { struct: ["f64", "f64"] } as const;
export const NSRANGE = { struct: ["usize", "usize"] } as const;

// NSNotFound is NSIntegerMax, not NSUIntegerMax. Winding only supports
// 64-bit Darwin targets, where NSInteger is a signed 64-bit value.
export const NS_NOT_FOUND = 0x7fff_ffff_ffff_ffffn;

export interface NSRangeValue {
  location: bigint;
  length: bigint;
}

type StructBytes = ArrayBufferView<ArrayBufferLike>;

function structDataView(view: StructBytes): DataView {
  return new DataView(view.buffer, view.byteOffset, view.byteLength);
}

function asUnsignedSize(value: number | bigint, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`winding(darwin) NSRange ${field} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`winding(darwin) NSRange ${field} does not fit NSUInteger`);
  }
  return value;
}

export function makeNSRange(
  location: number | bigint,
  length: number | bigint,
): BigUint64Array {
  const range = new BigUint64Array(2);
  writeNSRange(range, {
    location: asUnsignedSize(location, "location"),
    length: asUnsignedSize(length, "length"),
  });
  return range;
}

export function readNSRange(view: StructBytes): NSRangeValue {
  if (view.byteLength < 16) throw new RangeError("winding(darwin) NSRange buffer is too small");
  const data = structDataView(view);
  return {
    location: data.getBigUint64(0, true),
    length: data.getBigUint64(8, true),
  };
}

export function writeNSRange(view: StructBytes, range: NSRangeValue): void {
  if (view.byteLength < 16) throw new RangeError("winding(darwin) NSRange buffer is too small");
  const data = structDataView(view);
  data.setBigUint64(0, asUnsignedSize(range.location, "location"), true);
  data.setBigUint64(8, asUnsignedSize(range.length, "length"), true);
}

export const NSRECT_MSG_SEND_USES_STRET = Deno.build.arch === "x86_64";

type Closeable = { close(): void };
type NSRectBuffer = ArrayBufferView<ArrayBufferLike>;

export interface NSRectMsgSend {
  noArgs(receiver: Deno.PointerValue, selector: Deno.PointerValue): Uint8Array;
  rectArg(
    receiver: Deno.PointerValue,
    selector: Deno.PointerValue,
    rect: NSRectBuffer,
  ): Uint8Array;
  rectU64Arg(
    receiver: Deno.PointerValue,
    selector: Deno.PointerValue,
    rect: NSRectBuffer,
    value: bigint,
  ): Uint8Array;
  rectPointerArg(
    receiver: Deno.PointerValue,
    selector: Deno.PointerValue,
    rect: NSRectBuffer,
    pointer: Deno.PointerValue,
  ): Uint8Array;
  rangePointerArgs(
    receiver: Deno.PointerValue,
    selector: Deno.PointerValue,
    range: StructBytes,
    actualRange: Deno.PointerValue,
  ): Uint8Array;
}

/**
 * Open the Objective-C message shapes that return NSRect.
 *
 * On x86_64, a 32-byte NSRect uses the explicit `objc_msgSend_stret` ABI and
 * the hidden result pointer is therefore modelled as the first FFI argument.
 * Apple arm64 removed objc_msgSend_stret; there the struct is returned through
 * ordinary objc_msgSend. The returned wrapper keeps that distinction out of
 * call sites. Its dynamic-library handles are appended to `libraries` and are
 * owned/closed by the caller together with its other Objective-C handles.
 */
export function openNSRectMsgSend(libraries: Closeable[]): NSRectMsgSend {
  if (NSRECT_MSG_SEND_USES_STRET) {
    const noArgsLib = Deno.dlopen(
      LIBOBJC,
      {
        objc_msgSend_stret: {
          parameters: ["buffer", "pointer", "pointer"],
          result: "void",
        },
      } as const,
    );
    const rectArgLib = Deno.dlopen(
      LIBOBJC,
      {
        objc_msgSend_stret: {
          parameters: ["buffer", "pointer", "pointer", NSRECT],
          result: "void",
        },
      } as const,
    );
    const rectU64ArgLib = Deno.dlopen(
      LIBOBJC,
      {
        objc_msgSend_stret: {
          parameters: ["buffer", "pointer", "pointer", NSRECT, "u64"],
          result: "void",
        },
      } as const,
    );
    const rangePointerArgsLib = Deno.dlopen(
      LIBOBJC,
      {
        objc_msgSend_stret: {
          parameters: ["buffer", "pointer", "pointer", NSRANGE, "pointer"],
          result: "void",
        },
      } as const,
    );
    const rectPointerArgLib = Deno.dlopen(
      LIBOBJC,
      {
        objc_msgSend_stret: {
          parameters: ["buffer", "pointer", "pointer", NSRECT, "pointer"],
          result: "void",
        },
      } as const,
    );
    libraries.push(
      noArgsLib,
      rectArgLib,
      rectU64ArgLib,
      rectPointerArgLib,
      rangePointerArgsLib,
    );
    return {
      noArgs(receiver, selector) {
        const result = new Float64Array(4);
        noArgsLib.symbols.objc_msgSend_stret(result, receiver, selector);
        return new Uint8Array(result.buffer);
      },
      rectArg(receiver, selector, rect) {
        const result = new Float64Array(4);
        rectArgLib.symbols.objc_msgSend_stret(result, receiver, selector, rect);
        return new Uint8Array(result.buffer);
      },
      rectU64Arg(receiver, selector, rect, value) {
        const result = new Float64Array(4);
        rectU64ArgLib.symbols.objc_msgSend_stret(result, receiver, selector, rect, value);
        return new Uint8Array(result.buffer);
      },
      rectPointerArg(receiver, selector, rect, pointer) {
        const result = new Float64Array(4);
        rectPointerArgLib.symbols.objc_msgSend_stret(result, receiver, selector, rect, pointer);
        return new Uint8Array(result.buffer);
      },
      rangePointerArgs(receiver, selector, range, actualRange) {
        const result = new Float64Array(4);
        rangePointerArgsLib.symbols.objc_msgSend_stret(
          result,
          receiver,
          selector,
          range,
          actualRange,
        );
        return new Uint8Array(result.buffer);
      },
    };
  }

  const noArgsLib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: {
        parameters: ["pointer", "pointer"],
        result: NSRECT,
      },
    } as const,
  );
  const rectArgLib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: {
        parameters: ["pointer", "pointer", NSRECT],
        result: NSRECT,
      },
    } as const,
  );
  const rectU64ArgLib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: {
        parameters: ["pointer", "pointer", NSRECT, "u64"],
        result: NSRECT,
      },
    } as const,
  );
  const rangePointerArgsLib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: {
        parameters: ["pointer", "pointer", NSRANGE, "pointer"],
        result: NSRECT,
      },
    } as const,
  );
  const rectPointerArgLib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: {
        parameters: ["pointer", "pointer", NSRECT, "pointer"],
        result: NSRECT,
      },
    } as const,
  );
  libraries.push(
    noArgsLib,
    rectArgLib,
    rectU64ArgLib,
    rectPointerArgLib,
    rangePointerArgsLib,
  );
  return {
    noArgs: (receiver, selector) => noArgsLib.symbols.objc_msgSend(receiver, selector) as Uint8Array,
    rectArg: (receiver, selector, rect) => rectArgLib.symbols.objc_msgSend(receiver, selector, rect) as Uint8Array,
    rectU64Arg: (receiver, selector, rect, value) =>
      rectU64ArgLib.symbols.objc_msgSend(receiver, selector, rect, value) as Uint8Array,
    rectPointerArg: (receiver, selector, rect, pointer) =>
      rectPointerArgLib.symbols.objc_msgSend(receiver, selector, rect, pointer) as Uint8Array,
    rangePointerArgs: (receiver, selector, range, actualRange) =>
      rangePointerArgsLib.symbols.objc_msgSend(receiver, selector, range, actualRange) as Uint8Array,
  };
}

// CoreGraphics / CoreFoundation plain C functions (not Objective-C messages).
export const cgSymbols = {
  kCGColorSpaceSRGB: { type: "pointer" },
  CGColorSpaceCreateWithName: { parameters: ["pointer"], result: "pointer" },
  CGDataProviderCreateWithCFData: {
    parameters: ["pointer"],
    result: "pointer",
  },
  CGImageCreate: {
    parameters: [
      "usize",
      "usize",
      "usize",
      "usize",
      "usize",
      "pointer",
      "u32",
      "pointer",
      "pointer",
      "bool",
      "i32",
    ],
    result: "pointer",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export const cfSymbols = {
  CFDataCreate: { parameters: ["pointer", "buffer", "i64"], result: "pointer" },
  CFRelease: { parameters: ["pointer"], result: "void" },
  CFStringGetLength: { parameters: ["pointer"], result: "i64" },
  CFStringGetMaximumSizeForEncoding: { parameters: ["i64", "u32"], result: "i64" },
  CFStringGetBytes: {
    parameters: ["pointer", NSRANGE, "u32", "u8", "bool", "buffer", "i64", "buffer"],
    result: "i64",
  },
} as const satisfies Deno.ForeignLibraryInterface;

export type CoreFoundation = Deno.DynamicLibrary<typeof cfSymbols>;

// kCFStringEncodingUTF8. CFStringGetBytes gives us the exact output length, so
// embedded NULs survive conversion (unlike C-string based NSString helpers).
export const CF_STRING_ENCODING_UTF8 = 0x0800_0100;

export function readCFString(cf: CoreFoundation, string: Deno.PointerValue): string {
  if (string === null) throw new TypeError("winding(darwin) cannot read a null CFString");
  const utf16Length = cf.symbols.CFStringGetLength(string);
  if (utf16Length < 0n) throw new Error("winding(darwin) CFString reported a negative length");
  if (utf16Length === 0n) return "";

  const maximum = cf.symbols.CFStringGetMaximumSizeForEncoding(
    utf16Length,
    CF_STRING_ENCODING_UTF8,
  );
  if (maximum < 0n || maximum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("winding(darwin) CFString is too large to copy");
  }

  const bytes = new Uint8Array(Number(maximum));
  const used = new BigInt64Array(1);
  const converted = cf.symbols.CFStringGetBytes(
    string,
    makeNSRange(0n, utf16Length),
    CF_STRING_ENCODING_UTF8,
    0,
    false,
    bytes,
    maximum,
    used,
  );
  if (converted !== utf16Length || used[0] < 0n || used[0] > maximum) {
    throw new Error("winding(darwin) failed to convert complete CFString to UTF-8");
  }
  // `ignoreBOM: true` disables TextDecoder's signature stripping, preserving
  // a genuine leading U+FEFF from the native NSString.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(0, Number(used[0])),
  );
}

// kCGImageAlphaLast | kCGBitmapByteOrderDefault: straight (non-premultiplied)
// alpha, RGBA byte order. The image's named sRGB color space supplies the
// public buffer contract's color interpretation.
export const RGBA_BITMAP_INFO = 3;

export function readStructF64(view: Uint8Array, offset: number): number {
  return structDataView(view).getFloat64(offset, true);
}
