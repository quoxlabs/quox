const WHEEL_LINE_PIXELS = 40;

/** Convert browser-style positive-right/down wheel deltas to Blitz's content-motion convention. */
export function wheelPixelsForBlitz(
  deltaX: number,
  deltaY: number,
  deltaMode: 0 | 1 | 2,
  viewportWidth: number,
  viewportHeight: number,
): readonly [deltaX: number, deltaY: number] {
  const scaleX = deltaMode === 0 ? 1 : deltaMode === 1 ? WHEEL_LINE_PIXELS : viewportWidth;
  const scaleY = deltaMode === 0 ? 1 : deltaMode === 1 ? WHEEL_LINE_PIXELS : viewportHeight;
  return [-deltaX * scaleX, -deltaY * scaleY];
}
