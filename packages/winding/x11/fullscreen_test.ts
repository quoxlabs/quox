import {
  encodeFullscreenClientMessage,
  NET_WM_STATE_ADD,
  NET_WM_STATE_REMOVE,
  parseAtomProperty,
} from "./fullscreen.ts";

Deno.test("EWMH fullscreen client messages use the LP64 XClientMessage layout", () => {
  const entering = new DataView(encodeFullscreenClientMessage(null, 11n, 22n, 33n, true));
  assertEquals(entering.getInt32(0, true), 33);
  assertEquals(entering.getInt32(16, true), 1);
  assertEquals(entering.getBigUint64(24, true), 0n);
  assertEquals(entering.getBigUint64(32, true), 11n);
  assertEquals(entering.getBigUint64(40, true), 22n);
  assertEquals(entering.getInt32(48, true), 32);
  assertEquals(entering.getBigInt64(56, true), NET_WM_STATE_ADD);
  assertEquals(entering.getBigUint64(64, true), 33n);
  assertEquals(entering.getBigInt64(80, true), 1n);

  const exiting = new DataView(encodeFullscreenClientMessage(null, 11n, 22n, 33n, false));
  assertEquals(exiting.getBigInt64(56, true), NET_WM_STATE_REMOVE);
});

Deno.test("EWMH atom property parsing preserves the Xlib LP64 atom values", () => {
  const bytes = new ArrayBuffer(24);
  const view = new DataView(bytes);
  view.setBigUint64(0, 7n, true);
  view.setBigUint64(8, 0x1_0000_0001n, true);
  view.setBigUint64(16, 99n, true);
  const atoms = parseAtomProperty(bytes, 3);
  assertEquals(atoms.length, 3);
  assertEquals(atoms[0], 7n);
  assertEquals(atoms[1], 0x1_0000_0001n);
  assertEquals(atoms[2], 99n);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
}
