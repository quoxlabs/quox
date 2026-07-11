import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp, WlShmFormat } from "./ffi.ts";
import {
  type AnyCallback,
  args,
  BUFFER_EVENT_SIGNATURES,
  collectCleanupError,
  type LibcLibrary,
  makeVtable,
  MAP_FAILED,
  MAP_SHARED,
  MFD_CLOEXEC,
  PROT_READ,
  PROT_WRITE,
  throwCleanupErrors,
  type WaylandNativeLibrary,
  type WaylandNoopCallbacks,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";

export interface WaylandShmHost {
  readonly wl: WaylandNativeLibrary;
  readonly libc: LibcLibrary;
  readonly shm: Deno.PointerObject | null;
  readonly ifaces: {
    readonly shmPool: Deno.PointerObject;
    readonly buffer: Deno.PointerObject;
  };
  readonly noops: WaylandNoopCallbacks;
  requireArgb8888ShmFormat(): void;
}

const MAX_BUFFERS = 3;
const RGBA_BYTES_PER_PIXEL = 4;
const WAYLAND_INT32_MAX = 0x7fff_ffff;

export interface WaylandShmLayout {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly size: number;
}

export interface WaylandShmAttachment {
  readonly buffer: Deno.PointerObject;
  readonly layout: WaylandShmLayout;
}

/** Validate every image value that crosses a signed 32-bit Wayland argument. */
export function validateWaylandShmLayout(width: number, height: number): WaylandShmLayout {
  validateDimension(width, "width");
  validateDimension(height, "height");
  if (width > Math.floor(WAYLAND_INT32_MAX / RGBA_BYTES_PER_PIXEL)) {
    throw new RangeError("winding Wayland SHM stride exceeds the positive signed 32-bit protocol range");
  }
  const stride = width * RGBA_BYTES_PER_PIXEL;
  if (height > Math.floor(WAYLAND_INT32_MAX / stride)) {
    throw new RangeError("winding Wayland SHM pool size exceeds the positive signed 32-bit protocol range");
  }
  return { width, height, stride, size: stride * height };
}

/** Validate an exact public RGBA frame without allocating its native storage. */
export function validateWaylandShmFrame(
  width: number,
  height: number,
  sourceByteLength: number,
): WaylandShmLayout {
  const layout = validateWaylandShmLayout(width, height);
  if (sourceByteLength !== layout.size) {
    throw new RangeError(
      `winding Wayland blit needs exactly ${layout.size} RGBA bytes, received ${sourceByteLength}`,
    );
  }
  return layout;
}

function validateDimension(value: number, name: "width" | "height"): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`winding Wayland SHM ${name} must be a positive safe integer`);
  }
  if (value > WAYLAND_INT32_MAX) {
    throw new RangeError(`winding Wayland SHM ${name} exceeds the positive signed 32-bit protocol range`);
  }
}

/** Create a public-format frame that maps a new surface as opaque black. */
export function createOpaqueBlackFrame(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(validateWaylandShmLayout(width, height).size);
  for (let index = 3; index < rgba.byteLength; index += 4) rgba[index] = 0xff;
  return rgba;
}

/** Convert the public straight-alpha RGBA bytes to Wayland's premultiplied BGRA layout. */
export function copyStraightRgbaToPremultipliedBgra(
  source: Uint8Array,
  destination: Uint8Array,
): void {
  if (destination.byteLength % 4 !== 0 || source.byteLength < destination.byteLength) {
    throw new RangeError("winding Wayland pixel conversion needs complete RGBA pixels");
  }
  for (let index = 0; index < destination.byteLength; index += 4) {
    const alpha = source[index + 3];
    destination[index] = premultiply(source[index + 2], alpha);
    destination[index + 1] = premultiply(source[index + 1], alpha);
    destination[index + 2] = premultiply(source[index], alpha);
    destination[index + 3] = alpha;
  }
}

function premultiply(channel: number, alpha: number): number {
  return Math.floor((channel * alpha + 127) / 255);
}

/**
 * Owns a small release-aware set of wl_shm buffers.
 *
 * A committed buffer remains busy until the compositor sends `release`.  When
 * all slots are busy, `write` deliberately drops the new frame instead of
 * changing storage that the compositor may still be reading.
 */
export class WaylandShmBuffer {
  readonly #slots: WaylandShmBufferSlot[] = [];

  constructor(readonly host: WaylandShmHost) {}

  write(rgba: Uint8Array, width: number, height: number): WaylandShmAttachment | null {
    this.host.requireArgb8888ShmFormat();
    const layout = validateWaylandShmFrame(width, height, rgba.byteLength);

    let slot = this.#slots.find((candidate) => !candidate.busy && candidate.matches(layout.width, layout.height));
    slot ??= this.#slots.find((candidate) => !candidate.busy);
    if (!slot && this.#slots.length < MAX_BUFFERS) {
      slot = new WaylandShmBufferSlot(this.host);
      this.#slots.push(slot);
    }
    if (!slot) return null;
    return { buffer: slot.write(rgba, layout), layout };
  }

  close(): void {
    const errors: unknown[] = [];
    for (const slot of this.#slots.splice(0)) {
      collectCleanupError(errors, () => slot.close());
    }
    throwCleanupErrors("winding failed to close Wayland SHM buffers", errors);
  }
}

/** Owns one wl_buffer and the fd/mapping backing it. */
class WaylandShmBufferSlot {
  #fd = -1;
  #mapping: Deno.PointerObject | null = null;
  #size = 0;
  #buffer: Deno.PointerObject | null = null;
  #width = 0;
  #height = 0;
  #busy = false;
  #release: AnyCallback | null = null;
  #vtable: BigUint64Array<ArrayBuffer> | null = null;

  constructor(readonly host: WaylandShmHost) {}

  get busy(): boolean {
    return this.#busy;
  }

  matches(width: number, height: number): boolean {
    return this.#buffer !== null && this.#width === width && this.#height === height;
  }

  write(rgba: Uint8Array, layout: WaylandShmLayout): Deno.PointerObject {
    if (this.#busy) throw new Error("winding attempted to rewrite a busy Wayland SHM buffer");
    if (!this.#buffer || layout.width !== this.#width || layout.height !== this.#height) {
      this.#replace(layout);
    }

    const destination = new Uint8Array(
      new Deno.UnsafePointerView(this.#mapping!).getArrayBuffer(layout.size),
    );
    copyStraightRgbaToPremultipliedBgra(rgba, destination);
    this.#busy = true;
    return this.#buffer!;
  }

  #replace(layout: WaylandShmLayout): void {
    this.close();
    const { width, height, stride, size } = layout;
    const { host } = this;
    const symbols = host.wl.symbols;
    let fd = -1;
    let mapping: Deno.PointerObject | null = null;
    let pool: Deno.PointerObject | null = null;
    let buffer: Deno.PointerObject | null = null;
    const errors: unknown[] = [];
    try {
      fd = host.libc.symbols.memfd_create(cStr("winding-shm"), MFD_CLOEXEC);
      if (fd < 0) throw new Error("winding memfd_create failed");
      if (host.libc.symbols.ftruncate(fd, BigInt(size)) !== 0) {
        throw new Error("winding ftruncate failed");
      }
      const mapped = host.libc.symbols.mmap(
        null,
        BigInt(size),
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        fd,
        0n,
      );
      if (!mapped || Deno.UnsafePointer.value(mapped) === MAP_FAILED) {
        throw new Error("winding mmap failed");
      }
      mapping = mapped;

      pool = symbols.wl_proxy_marshal_array_flags(
        host.shm!,
        WlOp.SHM_CREATE_POOL,
        host.ifaces.shmPool,
        symbols.wl_proxy_get_version(host.shm!),
        0,
        args(0n, BigInt(fd), BigInt(size)),
      );
      if (!pool) throw new Error("winding wl_shm_create_pool failed");
      buffer = symbols.wl_proxy_marshal_array_flags(
        pool,
        WlOp.SHM_POOL_CREATE_BUFFER,
        host.ifaces.buffer,
        symbols.wl_proxy_get_version(pool),
        0,
        args(0n, 0n, BigInt(width), BigInt(height), BigInt(stride), BigInt(WlShmFormat.ARGB8888)),
      );
      if (!buffer) throw new Error("winding wl_shm_pool_create_buffer failed");

      const release = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer"], result: "void" },
        () => {
          this.#busy = false;
        },
      );
      const vtable = makeVtable([release], BUFFER_EVENT_SIGNATURES, host.noops);
      if (symbols.wl_proxy_add_listener(buffer, Deno.UnsafePointer.of(vtable), null) !== 0) {
        release.close();
        throw new Error("winding failed to listen for Wayland SHM buffer release");
      }
      this.#release = release;
      this.#vtable = vtable;
    } catch (error) {
      errors.push(error);
    } finally {
      if (pool) {
        collectCleanupError(errors, () => {
          symbols.wl_proxy_marshal_array_flags(
            pool!,
            WlOp.SHM_POOL_DESTROY,
            null,
            symbols.wl_proxy_get_version(pool!),
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        });
      }
    }

    if (errors.length > 0 || !mapping || !buffer) {
      if (buffer) {
        collectCleanupError(errors, () => {
          symbols.wl_proxy_marshal_array_flags(
            buffer!,
            WlOp.BUFFER_DESTROY,
            null,
            1,
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        });
      }
      if (mapping) {
        collectCleanupError(errors, () => {
          if (host.libc.symbols.munmap(mapping!, BigInt(size)) !== 0) {
            throw new Error("winding munmap failed while unwinding SHM allocation");
          }
        });
      }
      if (fd >= 0) {
        collectCleanupError(errors, () => {
          if (host.libc.symbols.close(fd) !== 0) {
            throw new Error("winding close failed while unwinding SHM allocation");
          }
        });
      }
      throwCleanupErrors("winding failed to allocate Wayland SHM buffer", errors);
      throw new Error("winding failed to allocate Wayland SHM buffer");
    }

    this.#fd = fd;
    this.#mapping = mapping;
    this.#size = size;
    this.#buffer = buffer;
    this.#width = width;
    this.#height = height;
    this.#busy = false;
  }

  close(): void {
    const buffer = this.#buffer;
    const mapping = this.#mapping;
    const size = this.#size;
    const fd = this.#fd;
    this.#buffer = null;
    this.#mapping = null;
    this.#size = 0;
    this.#fd = -1;
    this.#width = 0;
    this.#height = 0;
    this.#busy = false;
    const release = this.#release;
    this.#release = null;
    this.#vtable = null;

    const errors: unknown[] = [];
    if (buffer) {
      collectCleanupError(errors, () => {
        this.host.wl.symbols.wl_proxy_marshal_array_flags(
          buffer,
          WlOp.BUFFER_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    if (mapping && size > 0) {
      collectCleanupError(errors, () => {
        if (this.host.libc.symbols.munmap(mapping, BigInt(size)) !== 0) {
          throw new Error("winding munmap failed while closing SHM buffer");
        }
      });
    }
    if (fd >= 0) {
      collectCleanupError(errors, () => {
        if (this.host.libc.symbols.close(fd) !== 0) {
          throw new Error("winding close failed while closing SHM buffer");
        }
      });
    }
    if (release) collectCleanupError(errors, () => release.close());
    throwCleanupErrors("winding failed to close Wayland SHM buffer", errors);
  }
}
