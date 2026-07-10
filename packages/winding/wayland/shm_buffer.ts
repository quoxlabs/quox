import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp, WlShmFormat } from "./ffi.ts";
import {
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

/** Owns a wl_buffer and the fd/mapping backing it. */
export class WaylandShmBuffer {
  #fd = -1;
  #mapping: Deno.PointerObject | null = null;
  #size = 0;
  #buffer: Deno.PointerObject | null = null;
  #width = 0;
  #height = 0;

  constructor(readonly host: WaylandShmHost) {}

  write(rgba: Uint8Array, width: number, height: number): Deno.PointerObject {
    const size = checkedImageSize(width, height);
    if (rgba.byteLength < size) {
      throw new RangeError(`winding Wayland blit needs ${size} RGBA bytes, received ${rgba.byteLength}`);
    }
    if (!this.#buffer || width !== this.#width || height !== this.#height) {
      this.#replace(width, height, size);
    }

    const destination = new Uint8Array(
      new Deno.UnsafePointerView(this.#mapping!).getArrayBuffer(size),
    );
    for (let index = 0; index < size; index += 4) {
      destination[index] = rgba[index + 2];
      destination[index + 1] = rgba[index + 1];
      destination[index + 2] = rgba[index];
      destination[index + 3] = rgba[index + 3];
    }
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
