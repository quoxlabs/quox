import { FRACTIONAL_SCALE_PROTOCOL_METADATA, WlOp } from "./ffi.ts";
import {
  calculateWaylandFractionalFramebufferSize,
  isValidWaylandFractionalScaleNumerator,
  tryDestroyWaylandFractionalChildren,
  WAYLAND_FRACTIONAL_SCALE_DENOMINATOR,
  WaylandFractionalScaleLifecycle,
  WaylandFractionalScaleManagerState,
  WaylandFractionalSurfaceOwnership,
} from "./fractional_scale.ts";
import { isWaylandGlobalInterface } from "./global_registry.ts";
import { planWaylandSurfaceFrame, WaylandConfigureAckState } from "./output.ts";
import { FRACTIONAL_SCALE_EVENT_SIGNATURES } from "./protocol.ts";
import { validateWaylandShmLayout } from "./shm_buffer.ts";
import {
  createInitialWaylandBlackFrame,
  dispatchWaylandWindowCallbackIfOpen,
  selectWaylandConfigurationScale,
  teardownWaylandOptionalWindowChildren,
  teardownWaylandWindowChildrenAfterUnregister,
  WaylandConfigureState,
} from "./window.ts";

Deno.test("fractional-scale and viewporter metadata exactly covers protocol version 1", () => {
  assertEquals(FRACTIONAL_SCALE_PROTOCOL_METADATA, {
    fractionalScaleManager: {
      name: "wp_fractional_scale_manager_v1",
      version: 1,
      requests: [
        { name: "destroy", signature: "", objectTypes: [] },
        {
          name: "get_fractional_scale",
          signature: "no",
          objectTypes: ["fractionalScale", "wlSurface"],
        },
      ],
      events: [],
    },
    fractionalScale: {
      name: "wp_fractional_scale_v1",
      version: 1,
      requests: [{ name: "destroy", signature: "", objectTypes: [] }],
      events: [{ name: "preferred_scale", signature: "u", objectTypes: [] }],
    },
    viewporter: {
      name: "wp_viewporter",
      version: 1,
      requests: [
        { name: "destroy", signature: "", objectTypes: [] },
        { name: "get_viewport", signature: "no", objectTypes: ["viewport", "wlSurface"] },
      ],
      events: [],
    },
    viewport: {
      name: "wp_viewport",
      version: 1,
      requests: [
        { name: "destroy", signature: "", objectTypes: [] },
        { name: "set_source", signature: "ffff", objectTypes: [] },
        { name: "set_destination", signature: "ii", objectTypes: [] },
      ],
      events: [],
    },
  });
  assertEquals({
    managerDestroy: WlOp.WP_FRACTIONAL_SCALE_MANAGER_DESTROY,
    getFractionalScale: WlOp.WP_FRACTIONAL_SCALE_MANAGER_GET_FRACTIONAL_SCALE,
    fractionalScaleDestroy: WlOp.WP_FRACTIONAL_SCALE_DESTROY,
    viewporterDestroy: WlOp.WP_VIEWPORTER_DESTROY,
    getViewport: WlOp.WP_VIEWPORTER_GET_VIEWPORT,
    viewportDestroy: WlOp.WP_VIEWPORT_DESTROY,
    setSource: WlOp.WP_VIEWPORT_SET_SOURCE,
    setDestination: WlOp.WP_VIEWPORT_SET_DESTINATION,
  }, {
    managerDestroy: 0,
    getFractionalScale: 1,
    fractionalScaleDestroy: 0,
    viewporterDestroy: 0,
    getViewport: 1,
    viewportDestroy: 0,
    setSource: 1,
    setDestination: 2,
  });
  assertEquals(FRACTIONAL_SCALE_EVENT_SIGNATURES, [["pointer", "pointer", "u32"]]);
  assertEquals(isWaylandGlobalInterface("wp_fractional_scale_manager_v1"), true);
  assertEquals(isWaylandGlobalInterface("wp_viewporter"), true);
});

Deno.test("fractional surface children require both managers and outlive their generations", () => {
  const managers = new WaylandFractionalScaleManagerState<object>();
  const firstFractionalManager = {};
  const firstViewporter = {};
  const firstFractional = managers.bind("fractional-scale", firstFractionalManager, 1);
  assertEquals(managers.current, undefined);
  const firstViewport = managers.bind("viewporter", firstViewporter, 1);
  const pair = managers.current!;
  assert(pair.fractionalScale === firstFractional);
  assert(pair.viewporter === firstViewport);

  const lifecycle = new WaylandFractionalScaleLifecycle();
  const children = lifecycle.begin(pair);
  assert(children !== undefined);
  assertEquals(lifecycle.prefer(children, 180), false);
  assertEquals(lifecycle.activate(children), true);

  assert(managers.unbind("fractional-scale", firstFractionalManager) === firstFractional);
  assert(managers.unbind("viewporter", firstViewporter) === firstViewport);
  assertEquals(managers.current, undefined);
  assertEquals(lifecycle.prefer(children, 180), true);
  assertEquals(lifecycle.preferredNumerator, 180);

  const replacementFractional = managers.bind("fractional-scale", {}, 1);
  const replacementViewport = managers.bind("viewporter", {}, 1);
  assert(replacementFractional.generation !== firstFractional.generation);
  assert(replacementViewport.generation !== firstViewport.generation);
  assertEquals(lifecycle.begin(managers.current!), undefined);

  assertEquals(lifecycle.finish(children), true);
  const replacementChildren = lifecycle.begin(managers.current!);
  assert(replacementChildren !== undefined);
  assertEquals(lifecycle.activate(replacementChildren), true);
  assertEquals(lifecycle.prefer(children, 240), false);
  assertEquals(lifecycle.prefer(replacementChildren, 240), true);
});

Deno.test("an unconfirmed child destroy blocks duplicate surface associations", () => {
  const managers = new WaylandFractionalScaleManagerState<object>();
  managers.bind("fractional-scale", {}, 1);
  managers.bind("viewporter", {}, 1);
  const lifecycle = new WaylandFractionalScaleLifecycle();
  const generation = lifecycle.begin(managers.current!);
  assert(generation !== undefined);
  assertEquals(lifecycle.activate(generation), true);
  assertEquals(lifecycle.disable(generation), true);
  assertEquals(lifecycle.active, false);
  assertEquals(lifecycle.begin(managers.current!), undefined);
  assertEquals(lifecycle.prefer(generation, 180), false);
});

Deno.test("fractional framebuffer sizing uses exact numerator-over-120 rounding", () => {
  assertEquals(WAYLAND_FRACTIONAL_SCALE_DENOMINATOR, 120);
  assertEquals(calculateWaylandFractionalFramebufferSize(100, 50, 180), {
    width: 150,
    height: 75,
    devicePixelRatio: 1.5,
    numerator: 180,
  });
  assertEquals(calculateWaylandFractionalFramebufferSize(3, 3, 60), {
    width: 2,
    height: 2,
    devicePixelRatio: 0.5,
    numerator: 60,
  });
  assertEquals(calculateWaylandFractionalFramebufferSize(1, 1, 1), undefined);
  assertEquals(calculateWaylandFractionalFramebufferSize(0x7fff_ffff, 1, 0xffff_ffff), undefined);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
    assertEquals(isValidWaylandFractionalScaleNumerator(invalid), false);
  }
});

Deno.test("fractional frames keep buffer scale one and set a logical viewport destination", () => {
  assertEquals(
    planWaylandSurfaceFrame(6, 1.5, 800, 600, 1200, 900, {
      viewportAvailable: true,
      fractionalScaleNumerator: 180,
    }),
    [
      { kind: "set-buffer-scale", scale: 1 },
      { kind: "set-viewport-destination", width: 800, height: 600 },
      { kind: "attach" },
      { kind: "damage-buffer", width: 1200, height: 900 },
      { kind: "commit" },
    ],
  );
  assertEquals(
    planWaylandSurfaceFrame(3, 1.5, 800, 600, 1200, 900, {
      viewportAvailable: true,
      fractionalScaleNumerator: 180,
    }),
    [
      { kind: "set-buffer-scale", scale: 1 },
      { kind: "set-viewport-destination", width: 800, height: 600 },
      { kind: "attach" },
      { kind: "damage-surface", width: 800, height: 600 },
      { kind: "commit" },
    ],
  );
});

Deno.test("fractional preferences invalidate frames without duplicating configure acknowledgements", () => {
  const managers = new WaylandFractionalScaleManagerState<object>();
  managers.bind("fractional-scale", {}, 1);
  managers.bind("viewporter", {}, 1);
  const lifecycle = new WaylandFractionalScaleLifecycle();
  const generation = lifecycle.begin(managers.current!)!;
  lifecycle.activate(generation);

  const configure = new WaylandConfigureState(640, 480);
  const logical = configure.complete(77).configuration;
  assertEquals(lifecycle.prefer(generation, 150), true);
  const size = lifecycle.framebufferSize(logical.width, logical.height)!;
  const fractional = configure.applyFractionalScale(
    logical,
    size.width,
    size.height,
    size.devicePixelRatio,
    size.numerator,
    true,
  );
  assertEquals(fractional.framebufferWidth, 800);
  assertEquals(fractional.framebufferHeight, 600);
  assertEquals(fractional.devicePixelRatio, 1.25);
  assertEquals(fractional.fractionalScaleNumerator, 150);
  assertEquals(fractional.frameToken, logical.frameToken + 1);
  assert(configure.applyFractionalScale(fractional, 800, 600, 1.25, 150, true) === fractional);

  const sameSizeConfigure = new WaylandConfigureState(640, 480);
  const sameSizeLogical = sameSizeConfigure.complete(78).configuration;
  const integerAtSameSize = sameSizeConfigure.applyScale(
    sameSizeConfigure.applyFractionalScale(sameSizeLogical, 1280, 960, 2, 240, true),
    2,
    true,
  );
  assertEquals(integerAtSameSize.fractionalScaleNumerator, undefined);
  assertEquals(integerAtSameSize.frameToken, sameSizeLogical.frameToken + 2);

  const acknowledgements: number[] = [];
  const acks = new WaylandConfigureAckState();
  assertEquals(acks.ack(fractional.serial, (serial) => acknowledgements.push(serial)), true);
  assertEquals(acks.ack(fractional.serial, (serial) => acknowledgements.push(serial)), false);
  assertEquals(acknowledgements, [77]);
});

Deno.test("a preferred fractional scale received before configure sizes the initial black frame", () => {
  const managers = new WaylandFractionalScaleManagerState<object>();
  managers.bind("fractional-scale", {}, 1);
  managers.bind("viewporter", {}, 1);
  const fractionalScale = new WaylandFractionalScaleLifecycle();
  const generation = fractionalScale.begin(managers.current!)!;
  fractionalScale.activate(generation);
  assertEquals(fractionalScale.prefer(generation, 180), true);

  const configure = new WaylandConfigureState(100, 50);
  const initial = selectWaylandConfigurationScale(
    configure,
    configure.complete(88).configuration,
    fractionalScale,
    undefined,
    false,
  );
  assertEquals(initial.framebufferWidth, 150);
  assertEquals(initial.framebufferHeight, 75);
  assertEquals(initial.fractionalScaleNumerator, 180);
  const black = createInitialWaylandBlackFrame(initial);
  assertEquals(black.byteLength, 150 * 75 * 4);
  assertEquals([...black.subarray(0, 4)], [0, 0, 0, 255]);
  assertEquals([...black.subarray(black.byteLength - 4)], [0, 0, 0, 255]);
});

Deno.test("SHM-overflowing fractional sizes fall back to core scaling and unset the viewport", () => {
  const managers = new WaylandFractionalScaleManagerState<object>();
  managers.bind("fractional-scale", {}, 1);
  managers.bind("viewporter", {}, 1);
  const lifecycle = new WaylandFractionalScaleLifecycle();
  const generation = lifecycle.begin(managers.current!)!;
  lifecycle.activate(generation);
  lifecycle.prefer(generation, 240);

  assertEquals(calculateWaylandFractionalFramebufferSize(20_000, 20_000, 240), {
    width: 40_000,
    height: 40_000,
    devicePixelRatio: 2,
    numerator: 240,
  });
  const selected = lifecycle.framebufferSize(20_000, 20_000, (size) => {
    try {
      validateWaylandShmLayout(size.width, size.height);
      return true;
    } catch {
      return false;
    }
  });
  assertEquals(selected, undefined);
  validateWaylandShmLayout(20_000, 20_000);

  const configure = new WaylandConfigureState(20_000, 20_000);
  const core = configure.applyScale(configure.complete(91).configuration, 1, true);
  assertEquals(core.fractionalScaleNumerator, undefined);
  assertEquals(
    planWaylandSurfaceFrame(
      6,
      core.devicePixelRatio,
      core.width,
      core.height,
      core.framebufferWidth,
      core.framebufferHeight,
      { viewportAvailable: true, fractionalScaleNumerator: core.fractionalScaleNumerator },
    ),
    [
      { kind: "set-buffer-scale", scale: 1 },
      { kind: "set-viewport-destination", width: -1, height: -1 },
      { kind: "attach" },
      { kind: "damage-buffer", width: 20_000, height: 20_000 },
      { kind: "commit" },
    ],
  );
  assertEquals(
    planWaylandSurfaceFrame(6, 1, 20_000, 20_000, 20_000, 20_000, {
      viewportAvailable: true,
      fractionalScaleNumerator: 240,
    }),
    [
      { kind: "set-buffer-scale", scale: 1 },
      { kind: "set-viewport-destination", width: -1, height: -1 },
      { kind: "attach" },
      { kind: "damage-buffer", width: 20_000, height: 20_000 },
      { kind: "commit" },
    ],
  );
});

Deno.test("closed windows unregister before failed optional teardown and retained callbacks stay inert", () => {
  const owner = { name: "window" };
  const viewport = { name: "viewport proxy" };
  const fractionalScale = { name: "fractional proxy" };
  const callback = { name: "preferred callback", closed: false };
  const vtable = { name: "listener vtable" };
  const ownership = new WaylandFractionalSurfaceOwnership<
    typeof viewport,
    typeof callback,
    typeof vtable,
    typeof owner
  >(owner);
  ownership.installFractionalScaleProxy(fractionalScale);
  ownership.installPreferredCallback(callback);
  ownership.installVtable(vtable);
  ownership.installViewport(viewport);

  const routes = new Map([["surface", owner]]);
  const callbackRoots = new Set<typeof callback>();
  const ownershipRoots = new Set<object>();
  const order: string[] = [];
  let registered = true;
  const childrenDestroyed = teardownWaylandWindowChildrenAfterUnregister(
    registered,
    () => {
      registered = false;
      order.push("mark unregistered");
    },
    () => {
      order.push("unregister and purge route");
      routes.delete("surface");
    },
    () =>
      teardownWaylandOptionalWindowChildren(
        () => {
          order.push("try decoration destroy");
          return false;
        },
        () =>
          ownership.cleanup({
            destroyViewport: () => {
              order.push("try viewport destroy");
              throw new Error("viewport destroy failed");
            },
            destroyFractionalScale: () => {
              order.push("try fractional-scale destroy");
              throw new Error("fractional-scale destroy failed");
            },
            closeCallback: () => order.push("unexpected callback close"),
            retainCallback: (retained) => callbackRoots.add(retained),
            releaseCallback: (retained) => callbackRoots.delete(retained),
            retainOwnershipRoot: (root) => ownershipRoots.add(root),
            releaseOwnershipRoot: (root) => ownershipRoots.delete(root),
            reportError: () => order.push("record child error"),
          }),
      ),
    () => order.push("unexpected unregister error"),
  );

  assertEquals(childrenDestroyed, false);
  assertEquals(registered, false);
  assertEquals(routes.size, 0);
  assertEquals(order, [
    "mark unregistered",
    "unregister and purge route",
    "try decoration destroy",
    "try viewport destroy",
    "record child error",
    "try fractional-scale destroy",
    "record child error",
  ]);
  assert(ownership.viewport === viewport);
  assert(ownership.fractionalScale === fractionalScale);
  assert(ownership.preferredCallback === callback);
  assert(ownership.vtable === vtable);
  assert(ownership.owner === owner);
  assertEquals([...callbackRoots], [callback]);
  assertEquals([...ownershipRoots], [ownership]);

  let lateEffects = 0;
  for (const listener of ["xdg configure", "toplevel configure", "toplevel close", "decoration configure"]) {
    assertEquals(
      dispatchWaylandWindowCallbackIfOpen(true, () => {
        lateEffects++;
        routes.set(listener, owner);
      }),
      false,
    );
  }
  assertEquals(lateEffects, 0);
  assertEquals(routes.size, 0);

  // WaylandLibrary clears these roots only after wl_display_disconnect has reclaimed the proxies.
  assertEquals(callbackRoots.size, 1);
  assertEquals(ownershipRoots.size, 1);
  for (const retained of callbackRoots) retained.closed = true;
  callbackRoots.clear();
  ownershipRoots.clear();
  assertEquals(callback.closed, true);
  assertEquals(callbackRoots.size, 0);
  assertEquals(ownershipRoots.size, 0);
});

Deno.test("fractional children are destroyed in protocol-safe order and failures retain ownership", () => {
  const order: string[] = [];
  assertEquals(
    tryDestroyWaylandFractionalChildren(
      "viewport",
      "fractional-scale",
      (child) => order.push(`destroy ${child}`),
      (child) => order.push(`destroy ${child}`),
      () => order.push("unexpected error"),
    ),
    { viewportDestroyed: true, fractionalScaleDestroyed: true },
  );
  order.push("destroy wl_surface");
  assertEquals(order, ["destroy viewport", "destroy fractional-scale", "destroy wl_surface"]);

  const failures: unknown[] = [];
  const attempted: string[] = [];
  const result = tryDestroyWaylandFractionalChildren(
    "viewport",
    "fractional-scale",
    (child) => {
      attempted.push(child);
      throw new Error("viewport destroy failed");
    },
    (child) => attempted.push(child),
    (error) => failures.push(error),
  );
  assertEquals(attempted, ["viewport", "fractional-scale"]);
  assertEquals(result, { viewportDestroyed: false, fractionalScaleDestroyed: true });
  assertEquals(failures.length, 1);

  const owner = { name: "window" };
  const viewport = { name: "viewport proxy" };
  const fractionalScale = { name: "fractional proxy" };
  const callback = { name: "preferred callback" };
  const vtable = { name: "listener vtable" };
  const ownership = new WaylandFractionalSurfaceOwnership<
    typeof viewport,
    typeof callback,
    typeof vtable,
    typeof owner
  >(owner);
  ownership.installFractionalScaleProxy(fractionalScale);
  ownership.installPreferredCallback(callback);
  ownership.installVtable(vtable);
  ownership.installViewport(viewport);
  const retainedCallbacks: object[] = [];
  const retainedRoots: object[] = [];
  const failedOrder: string[] = [];
  const failed = ownership.cleanup({
    destroyViewport: (proxy) => {
      assert(proxy === viewport);
      failedOrder.push("destroy viewport");
      throw new Error("viewport destroy failed");
    },
    destroyFractionalScale: (proxy) => {
      assert(proxy === fractionalScale);
      failedOrder.push("destroy fractional-scale");
      throw new Error("fractional destroy failed");
    },
    closeCallback: () => failedOrder.push("unexpected close callback"),
    retainCallback: (retained) => retainedCallbacks.push(retained),
    releaseCallback: () => failedOrder.push("unexpected release callback"),
    retainOwnershipRoot: (root) => retainedRoots.push(root),
    releaseOwnershipRoot: () => failedOrder.push("unexpected release owner"),
    reportError: () => failedOrder.push("record error"),
  });
  assertEquals(failed, false);
  assertEquals(failedOrder, [
    "destroy viewport",
    "record error",
    "destroy fractional-scale",
    "record error",
  ]);
  assert(ownership.viewport === viewport);
  assert(ownership.fractionalScale === fractionalScale);
  assert(ownership.preferredCallback === callback);
  assert(ownership.vtable === vtable);
  assert(ownership.owner === owner);
  assertEquals(retainedCallbacks, [callback]);
  assertEquals(retainedRoots, [ownership]);

  const failedManagers = new WaylandFractionalScaleManagerState<object>();
  failedManagers.bind("fractional-scale", {}, 1);
  failedManagers.bind("viewporter", {}, 1);
  const failedLifecycle = new WaylandFractionalScaleLifecycle();
  const failedGeneration = failedLifecycle.begin(failedManagers.current!)!;
  failedLifecycle.activate(failedGeneration);
  failedLifecycle.disable(failedGeneration);
  assertEquals(failedLifecycle.begin(failedManagers.current!), undefined);
});

function assert(value: unknown, message = "Expected value to be truthy"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (deepEquals(actual, expected)) return;
  throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
}

function deepEquals(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  if (actualKeys.length !== expectedKeys.length) return false;
  return actualKeys.every((key) =>
    Object.hasOwn(expectedRecord, key) && deepEquals(actualRecord[key], expectedRecord[key])
  );
}
