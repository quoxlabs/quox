const UINT32_MAX = 0xffff_ffff;

function numericRangeError(name: string, expectation: string): RangeError {
  return new RangeError(`quox: ${name} must ${expectation}`);
}

/** Require a JavaScript number that can safely cross an f64 WASM boundary. */
export function assertFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`quox: ${name} must be a number`);
  }
  if (!Number.isFinite(value)) {
    throw numericRangeError(name, "be finite");
  }
  return value;
}

/** Require a finite value that f32 can represent without overflowing or underflowing to zero. */
export function assertFloat32(value: unknown, name: string): number {
  const number = assertFiniteNumber(value, name);
  const narrowed = Math.fround(number);
  if (!Number.isFinite(narrowed) || (number !== 0 && narrowed === 0)) {
    throw numericRangeError(name, "be representable as a 32-bit float");
  }
  return number;
}

export function assertPositiveFloat32(value: unknown, name: string): number {
  const number = assertFloat32(value, name);
  if (number <= 0) {
    throw numericRangeError(name, "be a positive 32-bit float");
  }
  return number;
}

export function assertUint32(value: unknown, name: string): number {
  const number = assertFiniteNumber(value, name);
  if (!Number.isInteger(number) || number < 0 || number > UINT32_MAX) {
    throw numericRangeError(name, "be an unsigned 32-bit integer");
  }
  return number;
}

export function assertPositiveUint32(value: unknown, name: string): number {
  const number = assertUint32(value, name);
  if (number === 0) {
    throw numericRangeError(name, "be a positive unsigned 32-bit integer");
  }
  return number;
}

export function assertIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const number = assertFiniteNumber(value, name);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw numericRangeError(name, `be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

export function assertKnownMask(value: unknown, knownMask: number, name: string): number {
  const number = assertUint32(value, name);
  if ((number & ~knownMask) !== 0) {
    throw numericRangeError(name, `contain only the known 0x${knownMask.toString(16)} bits`);
  }
  return number;
}

/** Validate Winding's optional UTF-8 byte range without narrowing either offset in WASM. */
export function assertUtf8ByteRange(
  text: string,
  range: readonly [number, number] | null,
  name = "cursorRange",
): readonly [number, number] | null {
  if (range === null) return null;
  if (!Array.isArray(range) || range.length !== 2) {
    throw new TypeError(`quox: ${name} must be a two-item byte range or null`);
  }

  const start = assertUint32(range[0], `${name}[0]`);
  const end = assertUint32(range[1], `${name}[1]`);
  const bytes = new TextEncoder().encode(text);
  const isBoundary = (offset: number) =>
    offset === bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) !== 0x80);
  if (start > end || end > bytes.length || !isBoundary(start) || !isBoundary(end)) {
    throw numericRangeError(name, "contain ordered UTF-8 boundaries within the preedit text");
  }
  return [start, end];
}
