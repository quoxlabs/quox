/** Translate browser-style positive-right/down deltas to Blitz's content-motion convention. */
export function wheelDeltaForBlitz(
  deltaX: number,
  deltaY: number,
  deltaMode: 0 | 1 | 2,
  viewportWidth: number,
  viewportHeight: number,
): readonly [deltaX: number, deltaY: number] {
  // Blitz represents pixels and lines directly, but not pages. Preserve the first two units and
  // adapt page deltas to the logical viewport dimensions exactly once.
  const scaleX = deltaMode === 2 ? viewportWidth : 1;
  const scaleY = deltaMode === 2 ? viewportHeight : 1;
  return [-deltaX * scaleX, -deltaY * scaleY];
}
