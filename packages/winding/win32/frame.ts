const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;

export interface Win32FramebufferSize {
  readonly width: number;
  readonly height: number;
}

/** One immutable-by-ownership native frame candidate. */
export interface Win32PreparedFrame extends Win32FramebufferSize {
  readonly bgra: Uint8Array<ArrayBuffer>;
  readonly bitmapInfo: ArrayBuffer;
}

/** Validate and convert an RGBA frame without mutating retained paint state. */
export function prepareWin32Frame(
  rgba: Uint8Array,
  width: number,
  height: number,
  framebuffer: Win32FramebufferSize | undefined,
): Win32PreparedFrame {
  validateDimension(width);
  validateDimension(height);
  if (framebuffer === undefined) {
    throw new Error("winding(win32): current framebuffer size is unavailable");
  }
  if (width !== framebuffer.width || height !== framebuffer.height) {
    throw new RangeError(
      `winding(win32): ${width}x${height} frame does not match ${framebuffer.width}x${framebuffer.height} framebuffer`,
    );
  }

  const byteLengthBig = BigInt(width) * BigInt(height) * 4n;
  if (byteLengthBig > BigInt(UINT32_MAX)) {
    throw new RangeError("winding(win32): frame byte length exceeds Win32 bitmap and typed-array bounds");
  }
  const byteLength = Number(byteLengthBig);
  if (rgba.byteLength !== byteLength) {
    throw new RangeError(
      `winding(win32): RGBA buffer has ${rgba.byteLength} bytes; expected ${byteLength}`,
    );
  }

  let bgra: Uint8Array<ArrayBuffer>;
  try {
    bgra = new Uint8Array(byteLength) as Uint8Array<ArrayBuffer>;
  } catch (cause) {
    throw new RangeError("winding(win32): failed to allocate converted frame", { cause });
  }
  for (let offset = 0; offset < byteLength; offset += 4) {
    bgra[offset] = rgba[offset + 2];
    bgra[offset + 1] = rgba[offset + 1];
    bgra[offset + 2] = rgba[offset];
    bgra[offset + 3] = rgba[offset + 3];
  }

  const bitmapInfo = new ArrayBuffer(BITMAPINFOHEADER_SIZE);
  const view = new DataView(bitmapInfo);
  view.setUint32(0, BITMAPINFOHEADER_SIZE, true); // biSize
  view.setInt32(4, width, true); // biWidth
  view.setInt32(8, -height, true); // biHeight (negative = top-down)
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 32, true); // biBitCount
  view.setUint32(16, BI_RGB, true); // biCompression
  view.setUint32(20, byteLength, true); // biSizeImage
  return { width, height, bgra, bitmapInfo };
}

/**
 * Own the last fully drawn frame. Failed candidate draws never replace the
 * frame that a later WM_PAINT must restore.
 */
export class Win32RetainedFrame {
  #current: Win32PreparedFrame | undefined;

  get current(): Win32PreparedFrame | undefined {
    return this.#current;
  }

  drawAndRetain(candidate: Win32PreparedFrame, draw: (frame: Win32PreparedFrame) => number): void {
    requireCompleteDraw(candidate, draw(candidate));
    this.#current = candidate;
  }

  redraw(draw: (frame: Win32PreparedFrame) => number): void {
    if (this.#current !== undefined) requireCompleteDraw(this.#current, draw(this.#current));
  }
}

function validateDimension(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > INT32_MAX) {
    throw new RangeError("winding(win32): frame dimensions must be positive signed 32-bit safe integers");
  }
}

function requireCompleteDraw(frame: Win32PreparedFrame, copiedScanLines: number): void {
  if (copiedScanLines !== frame.height) {
    throw new Error(
      `winding(win32): SetDIBitsToDevice copied ${copiedScanLines} of ${frame.height} scan lines`,
    );
  }
}
