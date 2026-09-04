import type { UIEvent } from "../types.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { libdlSymbols, type waylandSymbols, XdgToplevelState } from "./ffi.ts";

export const libcSymbols = {
  memfd_create: { parameters: ["buffer", "u32"], result: "i32" },
  ftruncate: { parameters: ["i32", "i64"], result: "i32" },
  mmap: { parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"], result: "pointer" },
  munmap: { parameters: ["pointer", "usize"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
  poll: { parameters: ["buffer", "u32", "i32"], result: "i32" },
} as const satisfies Deno.ForeignLibraryInterface;

export type LibcLibrary = Deno.DynamicLibrary<typeof libcSymbols>;
export type WaylandNativeLibrary = Deno.DynamicLibrary<typeof waylandSymbols>;

export const PROT_READ = 0x1;
export const PROT_WRITE = 0x2;
export const MAP_SHARED = 0x01;
export const MAP_PRIVATE = 0x02;
export const MAP_FAILED = 0xffffffffffffffffn;
export const MFD_CLOEXEC = 1;
export const POLLIN = 1;
export const RTLD_NOW = 0x2;
export const RTLD_NOLOAD = 0x4;
export const LIBWAYLAND_CLIENT_SO = "libwayland-client.so.0";
export const LIBXKBCOMMON_SO = "libxkbcommon.so.0";
export const WL_MARSHAL_FLAG_DESTROY = 1;

export type AnyCallback = { pointer: Deno.PointerObject; close(): void };

export function args(...values: bigint[]): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array(values.length === 0 ? [0n] : values);
}

export function nullableCString(pointer: Deno.PointerValue): string | null {
  return pointer ? new Deno.UnsafePointerView(pointer).getCString() : null;
}

export function readEventCount(ifaceAddress: bigint): number {
  return new Deno.UnsafePointerView(Deno.UnsafePointer.create(ifaceAddress)!).getUint32(24);
}

export function dlsymRequired(
  libdl: Deno.DynamicLibrary<typeof libdlSymbols>,
  handle: Deno.PointerObject,
  name: string,
): Deno.PointerObject {
  const pointer = libdl.symbols.dlsym(handle, cStr(name));
  if (!pointer) throw new Error(`winding failed to resolve symbol ${name}`);
  return pointer;
}

export function hasXdgToplevelState(statesPointer: Deno.PointerValue, state: number): boolean {
  if (!statesPointer) return false;
  const array = new Deno.UnsafePointerView(statesPointer);
  const size = Number(array.getBigUint64(0));
  if (size <= 0) return false;
  const dataPointer = Deno.UnsafePointer.create(array.getBigUint64(16));
  if (!dataPointer) return false;
  const data = new Deno.UnsafePointerView(dataPointer);
  for (let offset = 0; offset < size; offset += 4) {
    if (data.getUint32(offset) === state) return true;
  }
  return false;
}

export function makeVtable(
  handlers: Array<AnyCallback | null>,
  totalSlots: number,
  noop: AnyCallback,
): BigUint64Array<ArrayBuffer> {
  const vtable = new BigUint64Array(Math.max(handlers.length, totalSlots));
  const noopPointer = Deno.UnsafePointer.value(noop.pointer);
  for (let index = 0; index < vtable.length; index++) {
    const callback = index < handlers.length ? handlers[index] : null;
    vtable[index] = callback ? Deno.UnsafePointer.value(callback.pointer) : noopPointer;
  }
  return vtable;
}

export function collectCleanupError(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

export function throwCleanupErrors(message: string, errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/** Structural callback host shared by native resource controllers. */
export interface NativeCallbackHost {
  readonly wl: WaylandNativeLibrary;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
}

export const SUSPENDED_TOPLEVEL_STATE = XdgToplevelState.SUSPENDED;
export const FULLSCREEN_TOPLEVEL_STATE = XdgToplevelState.FULLSCREEN;
