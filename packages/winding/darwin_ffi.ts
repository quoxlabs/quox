// Minimal Objective-C runtime + AppKit/CoreGraphics FFI bindings.
//
// macOS has no stable C ABI for windowing (unlike X11/Win32): everything goes
// through the Objective-C message-dispatch runtime (`objc_msgSend`). Deno's FFI
// requires a fixed parameter/result shape per symbol, so we open `libobjc` once
// per distinct call shape we need and share those handles across the backend.

export function cStr(s: string): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(s.length + 1) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf;
}

const LIBOBJC = "/usr/lib/libobjc.dylib";

// Load the frameworks into the process so their classes and C functions become
// resolvable; we never call anything through these handles directly.
Deno.dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {});

const runtime = Deno.dlopen(
  LIBOBJC,
  {
    objc_getClass: { parameters: ["buffer"], result: "pointer" },
    sel_registerName: { parameters: ["buffer"], result: "pointer" },
    objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
    objc_registerClassPair: { parameters: ["pointer"], result: "void" },
    class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
  } as const satisfies Deno.ForeignLibraryInterface,
);

export function getClass(name: string): Deno.PointerObject {
  const p = runtime.symbols.objc_getClass(cStr(name));
  if (p === null) throw new Error(`winding(darwin) could not find Objective-C class '${name}'`);
  return p;
}
export function sel(name: string): Deno.PointerValue {
  return runtime.symbols.sel_registerName(cStr(name));
}
export function allocateClassPair(superclass: Deno.PointerObject, name: string): Deno.PointerObject {
  const p = runtime.symbols.objc_allocateClassPair(superclass, cStr(name), 0n);
  if (p === null) throw new Error(`winding(darwin) failed to allocate class '${name}'`);
  return p;
}
export const registerClassPair = runtime.symbols.objc_registerClassPair;
export function addMethod(
  cls: Deno.PointerObject,
  selector: Deno.PointerValue,
  imp: Deno.PointerValue,
  typeEncoding: string,
): void {
  const ok = runtime.symbols.class_addMethod(cls, selector, imp, cStr(typeEncoding));
  if (!ok) throw new Error("winding(darwin) failed to add method");
}

// A 4-tuple of f64 matches an NSRect { origin: {x, y}, size: {w, h} } layout on
// 64-bit (CGFloat == double). Deno's FFI struct support marshals this per the
// platform ABI, including the arm64/x86_64 large-struct-by-reference rules.
const NSRECT = { struct: ["f64", "f64", "f64", "f64"] } as const;
const NSPOINT = { struct: ["f64", "f64"] } as const;

function openMsgSend<
  const P extends readonly Deno.NativeType[],
  const R extends Deno.NativeResultType,
>(parameters: P, result: R) {
  const lib = Deno.dlopen(
    LIBOBJC,
    {
      objc_msgSend: { parameters, result },
    } as const,
  );
  return lib.symbols.objc_msgSend;
}

// One `objc_msgSend` handle per distinct call shape we need. All calls take
// (receiver, selector, ...args); extra unused argument slots are never passed.
export const send = {
  id: openMsgSend(["pointer", "pointer"], "pointer"),
  id_cstr: openMsgSend(["pointer", "pointer", "buffer"], "pointer"),
  id_rectU64U64Bool: openMsgSend(["pointer", "pointer", NSRECT, "u64", "u64", "bool"], "pointer"),
  id_u64PtrPtrBool: openMsgSend(["pointer", "pointer", "u64", "pointer", "pointer", "bool"], "pointer"),
  void: openMsgSend(["pointer", "pointer"], "void"),
  void_id: openMsgSend(["pointer", "pointer", "pointer"], "void"),
  void_bool: openMsgSend(["pointer", "pointer", "bool"], "void"),
  void_i64: openMsgSend(["pointer", "pointer", "i64"], "void"),
  point: openMsgSend(["pointer", "pointer"], NSPOINT),
  rect: openMsgSend(["pointer", "pointer"], NSRECT),
  f64: openMsgSend(["pointer", "pointer"], "f64"),
  u16: openMsgSend(["pointer", "pointer"], "u16"),
  i64: openMsgSend(["pointer", "pointer"], "i64"),
  u64: openMsgSend(["pointer", "pointer"], "u64"),
} as const;

// CoreGraphics / CoreFoundation plain C functions (not Objective-C messages).
export const cg = Deno.dlopen(
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  {
    CGColorSpaceCreateDeviceRGB: { parameters: [], result: "pointer" },
    CGDataProviderCreateWithData: {
      parameters: ["pointer", "buffer", "usize", "pointer"],
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
  } as const satisfies Deno.ForeignLibraryInterface,
);

export const cf = Deno.dlopen(
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  {
    CFRelease: { parameters: ["pointer"], result: "void" },
  } as const satisfies Deno.ForeignLibraryInterface,
);

// kCGImageAlphaLast | kCGBitmapByteOrderDefault: straight (non-premultiplied)
// alpha, RGBA byte order — matches the RGBA buffer winding's callers hand us.
export const RGBA_BITMAP_INFO = 3;

export function readStructF64(view: Uint8Array, offset: number): number {
  return new DataView(view.buffer, view.byteOffset, view.byteLength).getFloat64(offset, true);
}
