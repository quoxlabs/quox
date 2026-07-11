import {
  appKitWindowFrame,
  browserWheelDelta,
  DARWIN_WINDOW_DIMENSION_LIMIT,
  DARWIN_WINDOW_POSITION_LIMIT,
  type ScreenFrame,
  surfaceMetrics,
  validateAppKitWindowRect,
  validateDarwinGeometry,
  validateDarwinScreenFrame,
} from "./geometry.ts";

const primary: ScreenFrame = { x: 0, y: 0, width: 1920, height: 1080 };

Deno.test("Darwin maps primary-screen top-left window frames into AppKit coordinates", () => {
  assertEquals(
    [...appKitWindowFrame(100, 80, 640, 480, primary)],
    [100, 520, 640, 480],
  );
});

Deno.test("Darwin window coordinates cover displays on every side of the primary", () => {
  assertEquals(
    [...appKitWindowFrame(-1280, 56, 320, 200, primary)],
    [-1280, 824, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(1920, 40, 320, 200, primary)],
    [1920, 840, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(80, -900, 320, 200, primary)],
    [80, 1780, 320, 200],
  );
  assertEquals(
    [...appKitWindowFrame(80, 1080, 320, 200, primary)],
    [80, -200, 320, 200],
  );
});

Deno.test("Darwin rejects invalid primary-screen data before coordinate conversion", () => {
  validateDarwinScreenFrame({ x: -1920.5, y: -1080.25, width: 1920, height: 1080 });

  const ordinary: ScreenFrame = { ...primary };
  for (const field of ["x", "y", "width", "height"] as const) {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const screen = { ...ordinary, [field]: invalid };
      assertRangeError(
        () => validateDarwinScreenFrame(screen),
        "primary screen frame",
      );
    }
  }
  for (const dimension of [0, -1]) {
    assertRangeError(
      () => validateDarwinScreenFrame({ ...ordinary, width: dimension }),
      "primary screen frame",
    );
    assertRangeError(
      () => validateDarwinScreenFrame({ ...ordinary, height: dimension }),
      "primary screen frame",
    );
  }
});

Deno.test("Darwin validates transformed AppKit positions at native boundaries", () => {
  const negativePrimary: ScreenFrame = {
    x: -2000,
    y: -900,
    width: 1920,
    height: 1080,
  };
  const negativeFrame = appKitWindowFrame(100, 80, 640, 480, negativePrimary);
  validateAppKitWindowRect(negativeFrame, "transformed AppKit outer frame");
  assertEquals([...negativeFrame], [-1900, -380, 640, 480]);

  const shiftedRight: ScreenFrame = { x: 250, y: 0, width: 1920, height: 1080 };
  const exactRightBoundary = appKitWindowFrame(15_750, 0, 64, 64, shiftedRight);
  validateAppKitWindowRect(exactRightBoundary, "transformed AppKit outer frame");
  assertEquals(exactRightBoundary[0], DARWIN_WINDOW_POSITION_LIMIT);
  validateDarwinGeometry(15_750.5, 0, 64, 64);
  assertRangeError(
    () =>
      validateAppKitWindowRect(
        appKitWindowFrame(15_750.5, 0, 64, 64, shiftedRight),
        "transformed AppKit outer frame",
      ),
    "transformed AppKit outer frame position",
  );

  const shiftedUp: ScreenFrame = { x: 0, y: 300, width: 1920, height: 2000 };
  const exactUpperBoundary = appKitWindowFrame(0, -13_800, 100, 100, shiftedUp);
  validateAppKitWindowRect(exactUpperBoundary, "transformed AppKit outer frame");
  assertEquals(exactUpperBoundary[1], DARWIN_WINDOW_POSITION_LIMIT);
  validateDarwinGeometry(0, -13_800.5, 100, 100);
  assertRangeError(
    () =>
      validateAppKitWindowRect(
        appKitWindowFrame(0, -13_800.5, 100, 100, shiftedUp),
        "transformed AppKit outer frame",
      ),
    "transformed AppKit outer frame position",
  );

  const shiftedDown: ScreenFrame = { x: 0, y: -1000, width: 1920, height: 800 };
  const exactLowerBoundary = appKitWindowFrame(0, 15_700, 100, 100, shiftedDown);
  validateAppKitWindowRect(exactLowerBoundary, "transformed AppKit outer frame");
  assertEquals(exactLowerBoundary[1], -DARWIN_WINDOW_POSITION_LIMIT);
  validateDarwinGeometry(0, 15_700.5, 100, 100);
  assertRangeError(
    () =>
      validateAppKitWindowRect(
        appKitWindowFrame(0, 15_700.5, 100, 100, shiftedDown),
        "transformed AppKit outer frame",
      ),
    "transformed AppKit outer frame position",
  );
});

Deno.test("Darwin validates converted AppKit content rectangles", () => {
  const description = "converted AppKit content rectangle";
  validateAppKitWindowRect(
    [
      -DARWIN_WINDOW_POSITION_LIMIT,
      DARWIN_WINDOW_POSITION_LIMIT,
      DARWIN_WINDOW_DIMENSION_LIMIT,
      0.5,
    ],
    description,
  );

  for (
    const position of [
      -DARWIN_WINDOW_POSITION_LIMIT - 0.5,
      DARWIN_WINDOW_POSITION_LIMIT + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]
  ) {
    assertRangeError(
      () => validateAppKitWindowRect([position, 0, 1, 1], description),
      `${description} position`,
    );
    assertRangeError(
      () => validateAppKitWindowRect([0, position, 1, 1], description),
      `${description} position`,
    );
  }
  for (
    const dimension of [
      -1,
      0,
      DARWIN_WINDOW_DIMENSION_LIMIT + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]
  ) {
    assertRangeError(
      () => validateAppKitWindowRect([0, 0, dimension, 1], description),
      `${description} dimensions`,
    );
    assertRangeError(
      () => validateAppKitWindowRect([0, 0, 1, dimension], description),
      `${description} dimensions`,
    );
  }
});

Deno.test("Darwin wheel deltas preserve AppKit precision in browser units", () => {
  assertEquals(browserWheelDelta(2.25, -7.5, true), {
    deltaX: -2.25,
    deltaY: 7.5,
    deltaMode: 0,
  });
  assertEquals(browserWheelDelta(-1, 3, false), {
    deltaX: 1,
    deltaY: -3,
    deltaMode: 1,
  });
});

Deno.test("Darwin keeps logical bounds independent from exact backing pixels", () => {
  assertEquals(surfaceMetrics(799.5, 599.5, 1599, 1199, 2), {
    width: 800,
    height: 600,
    framebufferWidth: 1599,
    framebufferHeight: 1199,
    devicePixelRatio: 2,
  });
});

Deno.test("Darwin validates logical outer frames before native window creation", () => {
  validateDarwinGeometry(-120.5, 80.25, 800, 600);
  validateDarwinGeometry(
    -DARWIN_WINDOW_POSITION_LIMIT,
    DARWIN_WINDOW_POSITION_LIMIT,
    DARWIN_WINDOW_DIMENSION_LIMIT,
    DARWIN_WINDOW_DIMENSION_LIMIT,
  );

  const ordinary = [0, 0, 800, 600] as const;
  for (let field = 0; field < ordinary.length; field++) {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const geometry = [...ordinary] as [number, number, number, number];
      geometry[field] = invalid;
      assertRangeError(() => validateDarwinGeometry(...geometry));
    }
  }

  for (const x of [-DARWIN_WINDOW_POSITION_LIMIT - 0.5, DARWIN_WINDOW_POSITION_LIMIT + 0.5]) {
    assertRangeError(() => validateDarwinGeometry(x, 0, 1, 1));
  }
  for (const y of [-Number.MAX_VALUE, Number.MAX_VALUE]) {
    assertRangeError(() => validateDarwinGeometry(0, y, 1, 1));
  }
  for (const dimension of [-1, 0, 0.5, DARWIN_WINDOW_DIMENSION_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
    assertRangeError(() => validateDarwinGeometry(0, 0, dimension, 1));
    assertRangeError(() => validateDarwinGeometry(0, 0, 1, dimension));
  }
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertRangeError(operation: () => void, expectedMessage?: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof RangeError)) {
    throw new Error(`expected RangeError, got ${String(thrown)}`);
  }
  if (expectedMessage !== undefined && !thrown.message.includes(expectedMessage)) {
    throw new Error(
      `expected RangeError containing ${JSON.stringify(expectedMessage)}, got ${thrown.message}`,
    );
  }
}
