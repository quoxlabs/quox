export interface ScreenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
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
