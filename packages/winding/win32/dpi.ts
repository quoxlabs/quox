/** Pure Win32 DPI-awareness and logical/native geometry helpers. */

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

export const USER_DEFAULT_SCREEN_DPI = 96;

/** Values returned by GetAwarenessFromDpiAwarenessContext. */
export enum Win32DpiAwareness {
  INVALID = -1,
  UNAWARE = 0,
  SYSTEM = 1,
  PER_MONITOR = 2,
}

export interface Win32OuterGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Win32DpiChange extends Win32OuterGeometry {
  dpi: number;
}

/** Tracks the immutable awareness and effective DPI of one HWND. */
export class Win32DpiState {
  #dpi: number;

  constructor(readonly awareness: Win32DpiAwareness, dpi: number) {
    if (
      awareness !== Win32DpiAwareness.UNAWARE && awareness !== Win32DpiAwareness.SYSTEM &&
      awareness !== Win32DpiAwareness.PER_MONITOR
    ) {
      throw new Error("winding(win32): invalid window DPI awareness");
    }
    this.#dpi = awareness === Win32DpiAwareness.UNAWARE ? USER_DEFAULT_SCREEN_DPI : validateDpi(dpi);
  }

  get dpi(): number {
    return this.#dpi;
  }

  get devicePixelRatio(): number {
    return this.#dpi / USER_DEFAULT_SCREEN_DPI;
  }

  get handlesDpiChanges(): boolean {
    return this.awareness === Win32DpiAwareness.PER_MONITOR;
  }

  nativeToLogical(value: number): number {
    return value / this.devicePixelRatio;
  }

  logicalToNative(value: number): number {
    return value * this.devicePixelRatio;
  }

  /** Update only a per-monitor-aware HWND from WM_DPICHANGED. */
  update(dpi: number): boolean {
    if (!this.handlesDpiChanges) return false;
    const next = validateDpi(dpi);
    const changed = next !== this.#dpi;
    this.#dpi = next;
    return changed;
  }

  /** Convert the public outer-frame geometry to CreateWindow/SetWindowPos units. */
  outerGeometry(
    x: number,
    y: number,
    width: number,
    height: number,
    systemDpi = this.#dpi,
  ): Win32OuterGeometry {
    return scaleWin32OuterGeometry(x, y, width, height, systemDpi, this.#dpi);
  }
}

/**
 * Scale primary-origin screen position and outer size independently. Before an
 * HWND exists both DPIs are the system DPI; after creation its monitor DPI can
 * refine only the size without moving it to a different monitor.
 */
export function scaleWin32OuterGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
  positionDpi: number,
  sizeDpi: number,
): Win32OuterGeometry {
  const positionScale = validateDpi(positionDpi) / USER_DEFAULT_SCREEN_DPI;
  const sizeScale = validateDpi(sizeDpi) / USER_DEFAULT_SCREEN_DPI;
  return {
    x: nativeLong(x * positionScale, "position"),
    y: nativeLong(y * positionScale, "position"),
    width: nativeDimension(width * sizeScale),
    height: nativeDimension(height * sizeScale),
  };
}

/** Decode WM_DPICHANGED's equal-axis DPI and suggested physical outer rectangle. */
export function decodeWin32DpiChange(
  wParam: number | bigint,
  rectangle: ArrayBuffer | ArrayBufferView,
): Win32DpiChange {
  const raw = BigInt.asUintN(32, BigInt(wParam));
  const dpiX = Number(raw & 0xffffn);
  const dpiY = Number((raw >> 16n) & 0xffffn);
  if (dpiX !== dpiY) throw new Error("winding(win32): WM_DPICHANGED reported unequal axis DPI");
  const dpi = validateDpi(dpiX);

  const bytes = rectangle instanceof ArrayBuffer
    ? new Uint8Array(rectangle)
    : new Uint8Array(rectangle.buffer, rectangle.byteOffset, rectangle.byteLength);
  if (bytes.byteLength < 16) throw new RangeError("winding(win32): truncated WM_DPICHANGED rectangle");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x = view.getInt32(0, true);
  const y = view.getInt32(4, true);
  const width = view.getInt32(8, true) - x;
  const height = view.getInt32(12, true) - y;
  if (width <= 0 || width > INT32_MAX || height <= 0 || height > INT32_MAX) {
    throw new Error("winding(win32): invalid WM_DPICHANGED rectangle");
  }
  return { dpi, x, y, width, height };
}

function validateDpi(dpi: number): number {
  if (!Number.isSafeInteger(dpi) || dpi <= 0 || dpi > 0xffff) {
    throw new RangeError("winding(win32): invalid window DPI");
  }
  return dpi;
}

function nativeLong(value: number, name: string): number {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded < INT32_MIN || rounded > INT32_MAX) {
    throw new RangeError(`winding(win32): scaled window ${name} exceeds signed 32-bit range`);
  }
  return rounded;
}

function nativeDimension(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || rounded > INT32_MAX) {
    throw new RangeError("winding(win32): scaled outer window dimensions exceed signed 32-bit range");
  }
  return rounded;
}
