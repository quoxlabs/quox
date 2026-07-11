import { libcFunctions, x11functions } from "./ffi.ts";

type X11Library = Deno.DynamicLibrary<typeof x11functions>;
type LibcLibrary = Deno.DynamicLibrary<typeof libcFunctions>;
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

function imageByteLength(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("winding(x11): image dimensions must be positive integers");
  }
  const length = width * height * 4;
  if (!Number.isSafeInteger(length) || length > MAX_IMAGE_BYTES) {
    throw new RangeError("winding(x11): image dimensions are too large");
  }
  return length;
}

const LSB_FIRST = 0;

interface ChannelMask {
  readonly mask: bigint;
  readonly shift: bigint;
  readonly maximum: bigint;
}

function channelMask(mask: bigint): ChannelMask {
  if (mask === 0n) throw new Error("winding(x11): default visual has an empty colour mask");
  let shift = 0n;
  while (((mask >> shift) & 1n) === 0n) shift++;
  let bits = 0n;
  while (((mask >> (shift + bits)) & 1n) !== 0n) bits++;
  const maximum = (1n << bits) - 1n;
  if ((maximum << shift) !== mask) {
    throw new Error("winding(x11): non-contiguous TrueColor masks are unsupported");
  }
  return { mask, shift, maximum };
}

function scaleChannel(value: number, channel: ChannelMask): bigint {
  const scaled = (BigInt(value) * channel.maximum + 127n) / 255n;
  return (scaled << channel.shift) & channel.mask;
}

export interface XImageFormat {
  readonly byteOrder: number;
  readonly bytesPerLine: number;
  readonly bitsPerPixel: number;
  readonly redMask: bigint;
  readonly greenMask: bigint;
  readonly blueMask: bigint;
}

/** Convert straight RGBA into the server's actual default TrueColor layout. */
export function packRgbaPixels(
  rgba: Uint8Array,
  destination: Uint8Array,
  width: number,
  height: number,
  format: XImageFormat,
): void {
  const bytesPerPixel = format.bitsPerPixel / 8;
  if (![1, 2, 3, 4].includes(bytesPerPixel) || !Number.isInteger(bytesPerPixel)) {
    throw new Error(`winding(x11): unsupported ${format.bitsPerPixel}-bit XImage format`);
  }
  if (format.bytesPerLine < width * bytesPerPixel) {
    throw new Error("winding(x11): XImage stride is shorter than a scanline");
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new RangeError("winding(x11): RGBA buffer size does not match its dimensions");
  }
  if (destination.byteLength < format.bytesPerLine * height) {
    throw new RangeError("winding(x11): XImage storage is shorter than its declared stride");
  }

  const red = channelMask(format.redMask);
  const green = channelMask(format.greenMask);
  const blue = channelMask(format.blueMask);
  for (let y = 0; y < height; y++) {
    let source = y * width * 4;
    let target = y * format.bytesPerLine;
    for (let x = 0; x < width; x++, source += 4, target += bytesPerPixel) {
      const pixel = scaleChannel(rgba[source], red) |
        scaleChannel(rgba[source + 1], green) |
        scaleChannel(rgba[source + 2], blue);
      for (let byte = 0; byte < bytesPerPixel; byte++) {
        const destinationByte = format.byteOrder === LSB_FIRST ? byte : bytesPerPixel - byte - 1;
        destination[target + destinationByte] = Number((pixel >> BigInt(byte * 8)) & 0xffn);
      }
    }
  }
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
  readonly #format: XImageFormat;
  readonly #x11: X11Library["symbols"];
  #closed = false;

  constructor(
    x11: X11Library["symbols"],
    libc: LibcLibrary["symbols"],
    display: Deno.PointerObject,
    visual: Deno.PointerObject,
    depth: number,
    width: number,
    height: number,
  ) {
    imageByteLength(width, height);
    const image = x11.XCreateImage(
      display,
      visual,
      depth,
      2,
      0,
      null,
      width,
      height,
      32,
      0,
    );
    if (image === null) throw new Error("winding(x11): XCreateImage failed");

    const view = new Deno.UnsafePointerView(image);
    const format: XImageFormat = {
      byteOrder: view.getInt32(24),
      bytesPerLine: view.getInt32(44),
      bitsPerPixel: view.getInt32(48),
      redMask: view.getBigUint64(56),
      greenMask: view.getBigUint64(64),
      blueMask: view.getBigUint64(72),
    };
    const byteLength = format.bytesPerLine * height;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_IMAGE_BYTES) {
      x11.XDestroyImage(image);
      throw new Error("winding(x11): XCreateImage returned an invalid stride");
    }
    const data = libc.malloc(BigInt(byteLength));
    if (data === null) {
      x11.XDestroyImage(image);
      throw new Error("winding(x11): failed to allocate XImage pixels");
    }

    let pixels: Uint8Array;
    try {
      pixels = new Uint8Array(new Deno.UnsafePointerView(data).getArrayBuffer(byteLength));
      // Expose can arrive before the application submits its first frame.
      // Never let recycled process heap contents become window pixels.
      pixels.fill(0);
      // XCreateImage initializes its format before storage is supplied. Once
      // attached, XDestroyImage owns and frees this allocation.
      const dataAddress = new BigUint64Array([Deno.UnsafePointer.value(data)]);
      const dataField = Deno.UnsafePointer.offset(image, 16n);
      libc.memcpy(dataField, dataAddress, 8n);
    } catch (error) {
      libc.free(data);
      x11.XDestroyImage(image);
      throw error;
    }

    this.#x11 = x11;
    this.pointer = image;
    this.pixels = pixels;
    this.width = width;
    this.height = height;
    this.#format = format;
  }

  write(rgba: Uint8Array): void {
    if (this.#closed) throw new Error("winding(x11): image is closed");
    packRgbaPixels(rgba, this.pixels, this.width, this.height, this.#format);
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
