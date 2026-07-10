/** Allocation ceiling shared by XIM lookup and packed-text decoding. */
export const MAX_XIM_TEXT_BYTES = 1024 * 1024;

export interface NativeCallbackPointer {
  readonly pointer: Deno.PointerObject;
}

export function pointerFromAddress(address: bigint): Deno.PointerObject | null {
  return address === 0n ? null : Deno.UnsafePointer.create(address);
}

export function callbackRecord(
  callback: NativeCallbackPointer,
): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array([
    0n,
    Deno.UnsafePointer.value(callback.pointer),
  ]) as BigUint64Array<ArrayBuffer>;
}

/** Pack the LP64 XPoint representation used by the supported Linux ABI. */
export function packXPoint(x: number, y: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setInt16(0, clampI16(x), true);
  view.setInt16(2, clampI16(y), true);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

/** Pack the LP64 XRectangle representation used by the supported Linux ABI. */
export function packXRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setInt16(0, clampI16(x), true);
  view.setInt16(2, clampI16(y), true);
  view.setUint16(4, clampU16(width), true);
  view.setUint16(6, clampU16(height), true);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

/** Read an LP64 Linux XIMText. `undefined` means feedback-only or malformed. */
export function readXimText(pointer: Deno.PointerObject): string[] | undefined {
  const view = new Deno.UnsafePointerView(pointer);
  const length = view.getUint16(0);
  const isWide = view.getInt32(16) !== 0;
  const stringPointer = pointerFromAddress(view.getBigUint64(24));
  if (stringPointer === null) return undefined;
  return isWide ? decodeWideScalars(stringPointer, length) : decodeUtf8Scalars(stringPointer, length);
}

function decodeUtf8Scalars(
  pointer: Deno.PointerObject,
  length: number,
): string[] | undefined {
  if (!Number.isInteger(length) || length < 0 || length > MAX_XIM_TEXT_BYTES) return undefined;
  const view = new Deno.UnsafePointerView(pointer);
  const bytes: number[] = [];
  for (let scalar = 0; scalar < length; scalar++) {
    const lead = view.getUint8(bytes.length);
    if (lead === 0) return undefined;
    const width = lead < 0x80
      ? 1
      : lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
      ? 3
      : lead >= 0xf0 && lead <= 0xf4
      ? 4
      : 0;
    if (width === 0) return undefined;
    bytes.push(lead);
    for (let offset = 1; offset < width; offset++) {
      const continuation = view.getUint8(bytes.length);
      if ((continuation & 0xc0) !== 0x80) return undefined;
      bytes.push(continuation);
    }
  }
  try {
    return [...new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))];
  } catch {
    return undefined;
  }
}

function decodeWideScalars(
  pointer: Deno.PointerObject,
  length: number,
): string[] | undefined {
  if (!Number.isInteger(length) || length < 0 || length > MAX_XIM_TEXT_BYTES / 4) return undefined;
  const view = new Deno.UnsafePointerView(pointer);
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    const codePoint = view.getUint32(index * 4);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    result.push(String.fromCodePoint(codePoint));
  }
  return result;
}

function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(value)));
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}
