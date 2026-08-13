import { libcFunctions, x11functions } from "./ffi.ts";

type X11Library = Deno.DynamicLibrary<typeof x11functions>;
type LibcLibrary = Deno.DynamicLibrary<typeof libcFunctions>;

function imageByteLength(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("winding(x11): image dimensions must be positive integers");
  }
  const length = width * height * 4;
  if (!Number.isSafeInteger(length)) {
    throw new RangeError("winding(x11): image dimensions are too large");
  }
  return length;
}

/**
 * An XImage whose pixel storage is allocated by libc. XDestroyImage owns both
 * the XImage structure and that storage, which keeps resize and shutdown
 * ownership entirely on the native side.
 */
export class NativeXImage implements Disposable {
  readonly pointer: Deno.PointerObject;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly #x11: X11Library["symbols"];
  #closed = false;

  constructor(
    x11: X11Library["symbols"],
    libc: LibcLibrary["symbols"],
    display: Deno.PointerObject,
    visual: Deno.PointerObject,
    width: number,
    height: number,
  ) {
    const byteLength = imageByteLength(width, height);
    const data = libc.malloc(BigInt(byteLength));
    if (data === null) throw new Error("winding(x11): failed to allocate XImage pixels");

    const pixels = new Uint8Array(
      new Deno.UnsafePointerView(data).getArrayBuffer(byteLength),
    );
    const image = x11.XCreateImage(
      display,
      visual,
      24,
      2,
      0,
      pixels,
      width,
      height,
      32,
      0,
    );
    if (image === null) {
      libc.free(data);
      throw new Error("winding(x11): XCreateImage failed");
    }

    this.#x11 = x11;
    this.pointer = image;
    this.pixels = pixels;
    this.width = width;
    this.height = height;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#x11.XDestroyImage(this.pointer);
  }
}
