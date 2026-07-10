import { XEventType } from "./ffi.ts";

/** Core X11 represents auto-repeat as a release immediately followed by a matching press. */
export function isAutoRepeatPair(
  release: DataView<ArrayBuffer>,
  press: DataView<ArrayBuffer>,
): boolean {
  return press.getInt32(0, true) === XEventType.KeyPress &&
    press.getBigUint64(32, true) === release.getBigUint64(32, true) &&
    press.getBigUint64(56, true) === release.getBigUint64(56, true) &&
    press.getUint32(84, true) === release.getUint32(84, true);
}
