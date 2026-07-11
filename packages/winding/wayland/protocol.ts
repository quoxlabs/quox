import type { UIEvent } from "../types.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { libdlSymbols, type waylandSymbols, XdgToplevelState } from "./ffi.ts";

export const libcSymbols = {
  memfd_create: { parameters: ["buffer", "u32"], result: "i32" },
  ftruncate: { parameters: ["i32", "i64"], result: "i32" },
  mmap: { parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"], result: "pointer" },
  munmap: { parameters: ["pointer", "usize"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
  poll: { parameters: ["buffer", "usize", "i32"], result: "i32" },
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
export const POLLOUT = 4;
export const POLLERR = 8;
export const POLLHUP = 16;
export const POLLNVAL = 32;
export const RTLD_NOW = 0x2;
export const RTLD_NOLOAD = 0x4;
export const LIBWAYLAND_CLIENT_SO = "libwayland-client.so.0";
export const LIBXKBCOMMON_SO = "libxkbcommon.so.0";
export const WL_MARSHAL_FLAG_DESTROY = 1;
export const DEFAULT_CURSOR_WIDTH = 24;
export const DEFAULT_CURSOR_HEIGHT = 24;
export const DEFAULT_CURSOR_HOTSPOT_X = 1;
export const DEFAULT_CURSOR_HOTSPOT_Y = 1;
const MAX_WL_ARRAY_U32_ENTRIES = 4096;

export type AnyCallback = { pointer: Deno.PointerObject; close(): void };
export type WaylandCallbackParameter = "pointer" | "u32" | "i32";
export type WaylandEventSignature = readonly WaylandCallbackParameter[];

export const REGISTRY_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32", "pointer", "u32"],
  ["pointer", "pointer", "u32"],
] as const satisfies readonly WaylandEventSignature[];
export const SHM_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32"],
] as const satisfies readonly WaylandEventSignature[];
export const BUFFER_EVENT_SIGNATURES = [
  ["pointer", "pointer"],
] as const satisfies readonly WaylandEventSignature[];
export const SEAT_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32"],
  ["pointer", "pointer", "pointer"],
] as const satisfies readonly WaylandEventSignature[];
export const POINTER_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32", "pointer", "i32", "i32"],
  ["pointer", "pointer", "u32", "pointer"],
  ["pointer", "pointer", "u32", "i32", "i32"],
  ["pointer", "pointer", "u32", "u32", "u32", "u32"],
  ["pointer", "pointer", "u32", "u32", "i32"],
  ["pointer", "pointer"],
  ["pointer", "pointer", "u32"],
  ["pointer", "pointer", "u32", "u32"],
  ["pointer", "pointer", "u32", "i32"],
  ["pointer", "pointer", "u32", "i32"],
  ["pointer", "pointer", "u32", "u32"],
] as const satisfies readonly WaylandEventSignature[];
export const KEYBOARD_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32", "i32", "u32"],
  ["pointer", "pointer", "u32", "pointer", "pointer"],
  ["pointer", "pointer", "u32", "pointer"],
  ["pointer", "pointer", "u32", "u32", "u32", "u32"],
  ["pointer", "pointer", "u32", "u32", "u32", "u32", "u32"],
  ["pointer", "pointer", "i32", "i32"],
] as const satisfies readonly WaylandEventSignature[];
export const XDG_WM_BASE_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32"],
] as const satisfies readonly WaylandEventSignature[];
export const XDG_SURFACE_EVENT_SIGNATURES = [
  ["pointer", "pointer", "u32"],
] as const satisfies readonly WaylandEventSignature[];
export const XDG_TOPLEVEL_EVENT_SIGNATURES = [
  ["pointer", "pointer", "i32", "i32", "pointer"],
  ["pointer", "pointer"],
  ["pointer", "pointer", "i32", "i32"],
  ["pointer", "pointer", "pointer"],
] as const satisfies readonly WaylandEventSignature[];
export const TEXT_INPUT_V3_EVENT_SIGNATURES = [
  ["pointer", "pointer", "pointer"],
  ["pointer", "pointer", "pointer"],
  ["pointer", "pointer", "pointer", "i32", "i32"],
  ["pointer", "pointer", "pointer"],
  ["pointer", "pointer", "u32", "u32"],
  ["pointer", "pointer", "u32"],
] as const satisfies readonly WaylandEventSignature[];

export function args(...values: bigint[]): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array(values.length === 0 ? [0n] : values);
}

export function nullableCString(pointer: Deno.PointerValue): string | null {
  return pointer ? new Deno.UnsafePointerView(pointer).getCString() : null;
}

export function readEventCount(ifaceAddress: bigint): number {
  return new Deno.UnsafePointerView(Deno.UnsafePointer.create(ifaceAddress)!).getUint32(24);
}

export function waylandConnectionError(
  context: string,
  displayError: number,
  protocolInterface?: string,
  protocolObjectId?: number,
  protocolCode?: number,
): Error {
  if (protocolInterface !== undefined) {
    return new Error(
      `winding Wayland connection failed during ${context}: ${protocolInterface}@${protocolObjectId} ` +
        `reported protocol error ${protocolCode} (display error ${displayError})`,
    );
  }
  if (displayError !== 0) {
    return new Error(`winding Wayland connection failed during ${context}: display error ${displayError}`);
  }
  return new Error(`winding Wayland connection closed during ${context}`);
}

export function hasFatalPollEvent(revents: number): boolean {
  return (revents & (POLLERR | POLLHUP | POLLNVAL)) !== 0;
}

export function pointerCapabilityAction(
  available: boolean,
  active: boolean,
): "acquire" | "release" | undefined {
  if (available && !active) return "acquire";
  if (!available && active) return "release";
  return undefined;
}

/** Small opaque arrow used when the optional cursor-shape protocol is absent. */
export function createDefaultCursorPixels(): Uint8Array {
  const pixels = new Uint8Array(DEFAULT_CURSOR_WIDTH * DEFAULT_CURSOR_HEIGHT * 4);
  for (let y = 1; y <= 20; y++) {
    const lastX = Math.min(11, 1 + Math.floor(y / 2));
    for (let x = 1; x <= lastX; x++) {
      const offset = (y * DEFAULT_CURSOR_WIDTH + x) * 4;
      const outline = y === 1 || x === 1 || x === lastX || y === 20;
      const channel = outline ? 0 : 255;
      pixels[offset] = channel;
      pixels[offset + 1] = channel;
      pixels[offset + 2] = channel;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
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
  return readWlArrayU32(statesPointer).includes(state);
}

/** Decode a native wl_array of uint32 values without trusting its wire-controlled size. */
export function readWlArrayU32(arrayPointer: Deno.PointerValue): number[] {
  if (!arrayPointer) return [];
  const array = new Deno.UnsafePointerView(arrayPointer);
  const size = array.getBigUint64(0);
  const dataAddress = array.getBigUint64(16);
  const dataPointer = Deno.UnsafePointer.create(dataAddress);
  if (!dataPointer) return [];
  const data = new Deno.UnsafePointerView(dataPointer);
  return decodeWlArrayU32(size, dataAddress, (offset) => data.getUint32(offset));
}

/** Pure validation/decoding seam for native wl_array headers. */
export function decodeWlArrayU32(
  size: bigint,
  dataAddress: bigint,
  readUint32: (offset: number) => number,
): number[] {
  if (
    size === 0n || dataAddress === 0n || size % 4n !== 0n ||
    size > BigInt(MAX_WL_ARRAY_U32_ENTRIES * Uint32Array.BYTES_PER_ELEMENT)
  ) return [];
  const result: number[] = [];
  for (let offset = 0; offset < Number(size); offset += Uint32Array.BYTES_PER_ELEMENT) {
    result.push(readUint32(offset));
  }
  return result;
}

export interface WaylandNoopProvider<Callback = AnyCallback> {
  callback(parameters: WaylandEventSignature): Callback;
}

export function resolveVtableCallbacks<Callback>(
  handlers: readonly (Callback | null)[],
  signatures: readonly WaylandEventSignature[],
  noops: WaylandNoopProvider<Callback>,
): Callback[] {
  if (handlers.length > signatures.length) {
    throw new RangeError("winding Wayland listener has more handlers than protocol events");
  }
  return signatures.map((signature, index) => handlers[index] ?? noops.callback(signature));
}

export class WaylandNoopCallbacks implements WaylandNoopProvider {
  readonly #callbacks = new Map<string, AnyCallback>();
  readonly #owned: AnyCallback[] = [];
  #closed = false;

  constructor(
    readonly create: (parameters: WaylandEventSignature) => AnyCallback = (parameters) =>
      new Deno.UnsafeCallback(
        { parameters: [...parameters], result: "void" },
        () => {},
      ),
  ) {}

  callback(parameters: WaylandEventSignature): AnyCallback {
    if (this.#closed) throw new Error("winding Wayland no-op callbacks are closed");
    const key = parameters.join(",");
    const existing = this.#callbacks.get(key);
    if (existing) return existing;
    const callback = this.create(parameters);
    this.#callbacks.set(key, callback);
    this.#owned.push(callback);
    return callback;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#callbacks.clear();
    const errors: unknown[] = [];
    for (const callback of this.#owned.splice(0).reverse()) {
      collectCleanupError(errors, () => callback.close());
    }
    throwCleanupErrors("winding failed to close exact Wayland no-op callbacks", errors);
  }
}

export function makeVtable(
  handlers: readonly (AnyCallback | null)[],
  signatures: readonly WaylandEventSignature[],
  noops: WaylandNoopProvider,
): BigUint64Array<ArrayBuffer> {
  const callbacks = resolveVtableCallbacks(handlers, signatures, noops);
  return new BigUint64Array(callbacks.map((callback) => Deno.UnsafePointer.value(callback.pointer)));
}

export function collectCleanupError(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

/** Reverse-order ownership stack for constructors that cannot return a partial native object. */
export class NativeInitializationCleanup {
  readonly #actions: Array<() => void> = [];

  defer(action: () => void): void {
    this.#actions.push(action);
  }

  fail(primaryError: unknown, message: string): never {
    const errors: unknown[] = [primaryError];
    for (let index = this.#actions.length - 1; index >= 0; index--) {
      collectCleanupError(errors, this.#actions[index]);
    }
    if (errors.length === 1) throw primaryError;
    throw new AggregateError(errors, message);
  }
}

export function throwCleanupErrors(message: string, errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/** Structural callback host shared by native resource controllers. */
export interface NativeCallbackHost {
  readonly wl: WaylandNativeLibrary;
  readonly noops: WaylandNoopCallbacks;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
  throwIfConnectionFailed(): void;
}

export const SUSPENDED_TOPLEVEL_STATE = XdgToplevelState.SUSPENDED;
