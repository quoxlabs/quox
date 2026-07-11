/**
 * Keep the intentionally stale checked-in WASM presentable until a normal
 * build picks up its HiDPI renderer source. Rebuilt renderers already return
 * the exact framebuffer byte count and take the zero-copy path.
 */
export function fitRgbaToFramebuffer(
  rgba: Uint8Array,
  logicalWidth: number,
  logicalHeight: number,
  framebufferWidth: number,
  framebufferHeight: number,
): Uint8Array {
  const framebufferBytes = framebufferWidth * framebufferHeight * 4;
  if (rgba.byteLength === framebufferBytes) return rgba;

  const logicalBytes = logicalWidth * logicalHeight * 4;
  if (rgba.byteLength !== logicalBytes) {
    throw new RangeError(
      `renderer returned ${rgba.byteLength} RGBA bytes; expected ${logicalBytes} or ${framebufferBytes}`,
    );
  }

  const scaled = new Uint8Array(framebufferBytes);
  for (let y = 0; y < framebufferHeight; y++) {
    const sourceY = Math.min(logicalHeight - 1, Math.floor(y * logicalHeight / framebufferHeight));
    for (let x = 0; x < framebufferWidth; x++) {
      const sourceX = Math.min(logicalWidth - 1, Math.floor(x * logicalWidth / framebufferWidth));
      const source = (sourceY * logicalWidth + sourceX) * 4;
      const target = (y * framebufferWidth + x) * 4;
      scaled[target] = rgba[source];
      scaled[target + 1] = rgba[source + 1];
      scaled[target + 2] = rgba[source + 2];
      scaled[target + 3] = rgba[source + 3];
    }
  }
  return scaled;
}
