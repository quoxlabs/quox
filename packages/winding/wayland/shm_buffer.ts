import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp, WlShmFormat } from "./ffi.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  type LibcLibrary,
  MAP_FAILED,
  MAP_SHARED,
  MFD_CLOEXEC,
  PROT_READ,
  PROT_WRITE,
  throwCleanupErrors,
  type WaylandNativeLibrary,
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
}

const MAX_BUFFERS = 3;

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

  write(rgba: Uint8Array, width: number, height: number): Deno.PointerObject | null {
    const size = checkedImageSize(width, height);
    if (rgba.byteLength < size) {
      throw new RangeError(`winding Wayland blit needs ${size} RGBA bytes, received ${rgba.byteLength}`);
    }

    let slot = this.#slots.find((candidate) => !candidate.busy && candidate.matches(width, height));
    slot ??= this.#slots.find((candidate) => !candidate.busy);
    if (!slot && this.#slots.length < MAX_BUFFERS) {
      slot = new WaylandShmBufferSlot(this.host);
      this.#slots.push(slot);
    }
    if (!slot) return null;
    return slot.write(rgba, width, height, size);
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

  write(rgba: Uint8Array, width: number, height: number, size: number): Deno.PointerObject {
    if (this.#busy) throw new Error("winding attempted to rewrite a busy Wayland SHM buffer");
    if (!this.#buffer || width !== this.#width || height !== this.#height) {
      this.#replace(width, height, size);
    }

    const destination = new Uint8Array(
      new Deno.UnsafePointerView(this.#mapping!).getArrayBuffer(size),
    );
    copyStraightRgbaToPremultipliedBgra(rgba, destination);
    this.#busy = true;
    return this.#buffer!;
  }

  #replace(width: number, height: number, size: number): void {
    this.close();
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
        args(0n, 0n, BigInt(width), BigInt(height), BigInt(width * 4), BigInt(WlShmFormat.ARGB8888)),
      );
      if (!buffer) throw new Error("winding wl_shm_pool_create_buffer failed");

      const release = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer"], result: "void" },
        () => {
          this.#busy = false;
        },
      );
      const vtable = new BigUint64Array([Deno.UnsafePointer.value(release.pointer)]);
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

function checkedImageSize(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("winding Wayland blit dimensions must be positive safe integers");
  }
  const size = width * height * 4;
  if (!Number.isSafeInteger(size)) throw new RangeError("winding Wayland blit dimensions overflow");
  return size;
}
