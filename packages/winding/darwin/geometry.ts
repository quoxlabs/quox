export interface ScreenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DARWIN_WINDOW_POSITION_LIMIT = 16_000;
export const DARWIN_WINDOW_DIMENSION_LIMIT = 10_000;

/** Validate the NSScreen data used to translate Winding's coordinate space. */
export function validateDarwinScreenFrame(screen: ScreenFrame): void {
  if (
    !Number.isFinite(screen.x) || !Number.isFinite(screen.y) ||
    !Number.isFinite(screen.width) || !Number.isFinite(screen.height) ||
    screen.width <= 0 || screen.height <= 0
  ) {
    throw new RangeError(
      "winding(darwin): primary screen frame must have finite coordinates and positive finite dimensions",
    );
  }
}

/** Validate the screen-space rectangle that will cross an AppKit boundary. */
export function validateAppKitWindowRect(
  rect: ArrayLike<number>,
  description: string,
): void {
  const x = rect[0];
  const y = rect[1];
  const width = rect[2];
  const height = rect[3];
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    Math.abs(x) > DARWIN_WINDOW_POSITION_LIMIT ||
    Math.abs(y) > DARWIN_WINDOW_POSITION_LIMIT
  ) {
    throw new RangeError(
      `winding(darwin): ${description} position must be finite and within ±${DARWIN_WINDOW_POSITION_LIMIT} screen units`,
    );
  }
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0 ||
    width > DARWIN_WINDOW_DIMENSION_LIMIT ||
    height > DARWIN_WINDOW_DIMENSION_LIMIT
  ) {
    throw new RangeError(
      `winding(darwin): ${description} dimensions must be positive, finite, and no larger than ${DARWIN_WINDOW_DIMENSION_LIMIT} screen units`,
    );
  }
}

/** Validate Winding's logical outer frame before any AppKit window message. */
export function validateDarwinGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    Math.abs(x) > DARWIN_WINDOW_POSITION_LIMIT ||
    Math.abs(y) > DARWIN_WINDOW_POSITION_LIMIT
  ) {
    throw new RangeError(
      `winding(darwin): outer window position must be finite and within ±${DARWIN_WINDOW_POSITION_LIMIT} logical units`,
    );
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 ||
    width > DARWIN_WINDOW_DIMENSION_LIMIT ||
    height > DARWIN_WINDOW_DIMENSION_LIMIT
  ) {
    throw new RangeError(
      `winding(darwin): outer window dimensions must be positive integers no larger than ${DARWIN_WINDOW_DIMENSION_LIMIT} logical units`,
    );
  }
}

export interface SurfaceMetrics {
  /** Rounded logical client dimensions used by input and layout. */
  width: number;
  height: number;
  /** Independently rounded dimensions of the AppKit backing-space rectangle. */
  framebufferWidth: number;
  framebufferHeight: number;
  devicePixelRatio: number;
}

/**
 * Keep AppKit's logical and backing measurements independent. In scaled modes
 * the converted backing extent is authoritative and need not equal the rounded
 * logical extent multiplied by the scale factor.
 */
export function surfaceMetrics(
  logicalWidth: number,
  logicalHeight: number,
  backingWidth: number,
  backingHeight: number,
  devicePixelRatio: number,
): SurfaceMetrics {
  return {
    width: Math.round(logicalWidth),
    height: Math.round(logicalHeight),
    framebufferWidth: Math.round(backingWidth),
    framebufferHeight: Math.round(backingHeight),
    devicePixelRatio,
  };
}

/** Convert Winding's primary-screen top-left frame to AppKit screen coordinates. */
export function appKitWindowFrame(
  x: number,
  y: number,
  width: number,
  height: number,
  primaryScreen: ScreenFrame,
): Float64Array {
  return new Float64Array([
    primaryScreen.x + x,
    primaryScreen.y + primaryScreen.height - y - height,
    width,
    height,
  ]);
}

/** Translate AppKit scroll values into DOM direction and unit conventions. */
export function browserWheelDelta(
  scrollingDeltaX: number,
  scrollingDeltaY: number,
  precise: boolean,
): { deltaX: number; deltaY: number; deltaMode: 0 | 1 } {
  return {
    deltaX: -scrollingDeltaX,
    deltaY: -scrollingDeltaY,
    deltaMode: precise ? 0 : 1,
  };
}
