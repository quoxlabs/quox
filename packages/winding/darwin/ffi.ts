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

export const runtimeSymbols = {
  objc_getClass: { parameters: ["buffer"], result: "pointer" },
  sel_registerName: { parameters: ["buffer"], result: "pointer" },
  objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
  objc_registerClassPair: { parameters: ["pointer"], result: "void" },
  class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
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

// A 4-tuple of f64 matches an NSRect { origin: {x, y}, size: {w, h} } layout on
// 64-bit (CGFloat == double). Deno's FFI struct support marshals this per the
// platform ABI, including the arm64/x86_64 large-struct-by-reference rules.
export const NSRECT = { struct: ["f64", "f64", "f64", "f64"] } as const;
export const NSPOINT = { struct: ["f64", "f64"] } as const;

// CoreGraphics / CoreFoundation plain C functions (not Objective-C messages).
export const cgSymbols = {
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
} as const satisfies Deno.ForeignLibraryInterface;

export const cfSymbols = {
  CFRelease: { parameters: ["pointer"], result: "void" },
} as const satisfies Deno.ForeignLibraryInterface;

// kCGImageAlphaLast | kCGBitmapByteOrderDefault: straight (non-premultiplied)
// alpha, RGBA byte order — matches the RGBA buffer winding's callers hand us.
export const RGBA_BITMAP_INFO = 3;

export function readStructF64(view: Uint8Array, offset: number): number {
  return new DataView(view.buffer, view.byteOffset, view.byteLength).getFloat64(offset, true);
}
