export interface ImeRequestTarget {
  setImeEnabled(enabled: boolean): void;
  setImeCursorArea(x: number, y: number, width: number, height: number): void;
}

export const IME_REQUEST_FLAG = {
  cursorArea: 1 << 0,
  enabled: 1 << 1,
  contextRestart: 1 << 2,
} as const;

/** Apply one atomic Rust IME-request snapshot, preserving logical-editor restart edges. */
export function applyImeRequestSnapshot(window: ImeRequestTarget, snapshot: Float32Array): void {
  if (snapshot.length !== 6) {
    throw new RangeError(`invalid IME request snapshot length: ${snapshot.length}`);
  }
  const flags = Math.trunc(snapshot[0]);
  if (!Number.isFinite(snapshot[0]) || flags !== snapshot[0] || (flags & ~7) !== 0) {
    throw new RangeError(`invalid IME request flags: ${snapshot[0]}`);
  }
  const contextRestart = (flags & IME_REQUEST_FLAG.contextRestart) !== 0;
  const enabled = snapshot[5] !== 0;
  if (contextRestart) {
    if (!enabled) throw new RangeError("an IME context restart must end enabled");
    window.setImeEnabled(false);
  }
  if (flags & IME_REQUEST_FLAG.cursorArea) {
    window.setImeCursorArea(snapshot[1], snapshot[2], snapshot[3], snapshot[4]);
  }
  if (contextRestart || (flags & IME_REQUEST_FLAG.enabled)) {
    window.setImeEnabled(enabled);
  }
}
