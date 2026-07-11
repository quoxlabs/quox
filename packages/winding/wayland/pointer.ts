/** Pure wl_pointer position and version-aware axis-frame state. */

export const WaylandPointerAxis = {
  vertical: 0,
  horizontal: 1,
} as const;

export const WaylandPointerAxisSource = {
  wheel: 0,
  finger: 1,
  continuous: 2,
  wheelTilt: 3,
} as const;

type PointerAxis = 0 | 1;

export interface WaylandWheelDelta {
  readonly time: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: 0 | 1;
}

export function waylandFixedToNumber(value: number): number {
  return value / 256;
}

/** Retains the enter location used by button and wheel events before the first motion. */
export class WaylandPointerPosition {
  #x = 0;
  #y = 0;

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }

  updateFixed(x: number, y: number): void {
    this.#x = waylandFixedToNumber(x);
    this.#y = waylandFixedToNumber(y);
  }
}

/**
 * Coalesces the axis metadata introduced with wl_pointer version 5.
 *
 * Older proxies do not receive frame events, so their axis values are returned immediately in
 * logical-pixel mode. Newer proxies return at most one complete diagonal wheel vector per frame.
 */
export class WaylandPointerFrameAccumulator {
  #version = 0;
  #fixed: [number, number] = [0, 0];
  #seen: [boolean, boolean] = [false, false];
  #stopped: [boolean, boolean] = [false, false];
  #discrete: [number | undefined, number | undefined] = [undefined, undefined];
  #source: number | undefined;
  #time: number | undefined;

  beginGeneration(version: number): void {
    this.#version = Number.isSafeInteger(version) && version > 0 ? version : 0;
    this.reset();
  }

  reset(): void {
    this.#fixed = [0, 0];
    this.#seen = [false, false];
    this.#stopped = [false, false];
    this.#discrete = [undefined, undefined];
    this.#source = undefined;
    this.#time = undefined;
  }

  axis(time: number, axis: number, fixedValue: number): WaylandWheelDelta | undefined {
    if (!isPointerAxis(axis)) return undefined;
    if (this.#version < 5) return wheelDelta(time, axis, waylandFixedToNumber(fixedValue), 0);
    this.#stopped[axis] = false;
    this.#fixed[axis] += fixedValue;
    this.#seen[axis] = true;
    this.#time = time;
    return undefined;
  }

  axisSource(source: number): void {
    if (this.#version >= 5) this.#source = source;
  }

  axisDiscrete(axis: number, steps: number): void {
    if (this.#version < 5 || !isPointerAxis(axis)) return;
    this.#discrete[axis] = Number.isSafeInteger(steps) && steps !== 0 ? steps : undefined;
  }

  axisStop(time: number, axis: number): void {
    if (this.#version < 5 || !isPointerAxis(axis)) return;
    this.#fixed[axis] = 0;
    this.#seen[axis] = false;
    this.#stopped[axis] = true;
    this.#discrete[axis] = undefined;
    this.#time = time;
  }

  frame(): WaylandWheelDelta | undefined {
    if (this.#version < 5) {
      this.reset();
      return undefined;
    }

    const vertical = this.#seen[WaylandPointerAxis.vertical] && !this.#stopped[WaylandPointerAxis.vertical]
      ? waylandFixedToNumber(this.#fixed[WaylandPointerAxis.vertical])
      : 0;
    const horizontal = this.#seen[WaylandPointerAxis.horizontal] && !this.#stopped[WaylandPointerAxis.horizontal]
      ? waylandFixedToNumber(this.#fixed[WaylandPointerAxis.horizontal])
      : 0;
    const time = this.#time;
    const smoothSource = this.#source === WaylandPointerAxisSource.finger ||
      this.#source === WaylandPointerAxisSource.continuous;
    const activeAxes = [vertical, horizontal]
      .map((value, axis) => ({ axis: axis as PointerAxis, value }))
      .filter(({ value }) => value !== 0);
    const useDiscrete = !smoothSource && activeAxes.length > 0 &&
      activeAxes.every(({ axis }) => this.#discrete[axis] !== undefined);
    const deltaY = useDiscrete && vertical !== 0 ? this.#discrete[WaylandPointerAxis.vertical] ?? 0 : vertical;
    const deltaX = useDiscrete && horizontal !== 0 ? this.#discrete[WaylandPointerAxis.horizontal] ?? 0 : horizontal;
    this.reset();

    if (time === undefined || (deltaX === 0 && deltaY === 0)) return undefined;
    return { time, deltaX, deltaY, deltaMode: useDiscrete ? 1 : 0 };
  }
}

function isPointerAxis(axis: number): axis is PointerAxis {
  return axis === WaylandPointerAxis.vertical || axis === WaylandPointerAxis.horizontal;
}

function wheelDelta(time: number, axis: PointerAxis, delta: number, deltaMode: 0 | 1): WaylandWheelDelta {
  return {
    time,
    deltaX: axis === WaylandPointerAxis.horizontal ? delta : 0,
    deltaY: axis === WaylandPointerAxis.vertical ? delta : 0,
    deltaMode,
  };
}
