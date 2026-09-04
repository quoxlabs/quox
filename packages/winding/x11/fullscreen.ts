/** EWMH `_NET_WM_STATE` actions. */
export const NET_WM_STATE_REMOVE = 0n;
export const NET_WM_STATE_ADD = 1n;

/** Source indication used by normal applications. */
const NET_WM_STATE_SOURCE_APPLICATION = 1n;

/**
 * Encode the LP64 XClientMessageEvent used to change fullscreen state.
 *
 * Winding's X11 backend targets the same 64-bit Linux ABI as the rest of its
 * Xlib FFI declarations, where Atom, Window, and C `long` are eight bytes.
 */
export function encodeFullscreenClientMessage(
  display: Deno.PointerValue,
  window: bigint,
  netWmState: bigint,
  netWmStateFullscreen: bigint,
  fullscreen: boolean,
): ArrayBuffer {
  const event = new ArrayBuffer(192);
  const view = new DataView(event);
  view.setInt32(0, 33, true); // ClientMessage
  view.setInt32(16, 1, true); // send_event = True
  view.setBigUint64(24, display === null ? 0n : Deno.UnsafePointer.value(display), true);
  view.setBigUint64(32, window, true);
  view.setBigUint64(40, netWmState, true);
  view.setInt32(48, 32, true);
  view.setBigInt64(56, fullscreen ? NET_WM_STATE_ADD : NET_WM_STATE_REMOVE, true);
  view.setBigUint64(64, netWmStateFullscreen, true);
  view.setBigUint64(72, 0n, true);
  view.setBigInt64(80, NET_WM_STATE_SOURCE_APPLICATION, true);
  view.setBigInt64(88, 0n, true);
  return event;
}

/** Parse an LP64 Atom array returned by XGetWindowProperty. */
export function parseAtomProperty(bytes: ArrayBuffer, count: number): bigint[] {
  const view = new DataView(bytes);
  const atoms: bigint[] = [];
  for (let index = 0; index < count; index++) {
    atoms.push(view.getBigUint64(index * 8, true));
  }
  return atoms;
}
