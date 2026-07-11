import {
  type ComposeAdapter,
  ComposeFeedResult,
  ComposeStatus,
  KeyRepeatController,
  resolveComposeLocale,
  toXkbKeycode,
  translateKey,
  translateWlKeyboardKey,
  WaylandEnterKeyBatch,
  waylandKeyEditDisposition,
  WaylandKeyTransitionState,
  type XkbKeyTranslator,
} from "./keyboard.ts";
import { CURSOR_SHAPE_MANAGER_V1_REQUESTS, WlOp, WlShmFormat, XDG_DECORATION_PROTOCOL_METADATA } from "./ffi.ts";
import { createWaylandSurroundingTextState, TextInputV3Batch, TextInputV3SerialGate } from "./text_input.ts";
import { CompositionState, keyLocationForCode, normalizeImeCursorArea, validateImeCursorRange } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";
import { emitWaylandTextInputEdits } from "./text_input_controller.ts";
import type { WaylandWindow } from "./window.ts";
import {
  BUFFER_EVENT_SIGNATURES,
  clampWaylandBindVersion,
  createDefaultCursorPixels,
  decodeWaylandInterfaceVersion,
  decodeWlArrayU32,
  DEFAULT_CURSOR_HEIGHT,
  DEFAULT_CURSOR_HOTSPOT_X,
  DEFAULT_CURSOR_HOTSPOT_Y,
  DEFAULT_CURSOR_WIDTH,
  hasFatalPollEvent,
  KEYBOARD_EVENT_SIGNATURES,
  libcSymbols,
  NativeInitializationCleanup,
  OUTPUT_EVENT_SIGNATURES,
  POINTER_EVENT_SIGNATURES,
  pointerCapabilityAction,
  POLLERR,
  POLLHUP,
  POLLIN,
  POLLNVAL,
  readWlArrayU32,
  REGISTRY_EVENT_SIGNATURES,
  resolveVtableCallbacks,
  SEAT_EVENT_SIGNATURES,
  SHM_EVENT_SIGNATURES,
  SURFACE_EVENT_SIGNATURES,
  TEXT_INPUT_V3_EVENT_SIGNATURES,
  waylandConnectionError,
  WaylandNoopCallbacks,
  XDG_SURFACE_EVENT_SIGNATURES,
  XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
  XDG_TOPLEVEL_EVENT_SIGNATURES,
  XDG_WM_BASE_EVENT_SIGNATURES,
} from "./protocol.ts";
import { createOpaqueBlackFrame, validateWaylandShmFrame, validateWaylandShmLayout } from "./shm_buffer.ts";
import { MISSING_ARGB8888_SHM_FORMAT, type WaylandShmFormatGeneration, WaylandShmFormatState } from "./shm_format.ts";
import {
  damageOpcodeForSurfaceVersion,
  DEFAULT_WAYLAND_APP_ID,
  frameMatchesConfiguration,
  setDefaultWaylandAppIdBeforeInitialCommit,
  tryDestroyWaylandSurfaceWithListeners,
  WaylandConfigureState,
} from "./window.ts";
import { isWaylandGlobalInterface, type WaylandGlobalInterface, WaylandGlobalRegistry } from "./global_registry.ts";
import {
  WaylandPointerAxis,
  WaylandPointerAxisSource,
  WaylandPointerFrameAccumulator,
  WaylandPointerPosition,
} from "./pointer.ts";
import { openRequiredWaylandDependency, type RequiredWaylandDependency, validateWaylandNativeLayout } from "./mod.ts";
import {
  setupServerSideDecorationBeforeInitialCommit,
  tryDestroyWaylandDecoration,
  WaylandDecorationLifecycle,
  WaylandDecorationManagerState,
  WaylandDecorationMode,
} from "./decoration.ts";
import {
  isValidWaylandScale,
  outputReleaseStrategy,
  planWaylandSurfaceFrame,
  WaylandConfigureAckState,
  WaylandOutputRegistry,
  WaylandOutputScaleState,
  WaylandSurfaceOutputScaleState,
} from "./output.ts";
import type { KeyModifiers } from "../types.ts";
import {
  WAYLAND_WINDOW_CLOSED_MESSAGE,
  WAYLAND_WINDOW_MUTATION_NAMES,
  WaylandWindowLifecycleGate,
  type WaylandWindowMutationName,
} from "./window_lifecycle.ts";

Deno.test("required Wayland dependency failures identify the support boundary", () => {
  const nativeError = new Error("native loader failed");
  const cases: ReadonlyArray<readonly [RequiredWaylandDependency, string]> = [
    [
      "libc",
      "winding Wayland requires glibc libc.so.6 with memfd_create because " +
      "Deno.dlopen resolves the whole libc FFI symbol descriptor",
    ],
    ["libdl", "winding Wayland requires glibc libdl.so.2"],
    ["wayland-client", "winding Wayland requires libwayland-client.so.0"],
    ["xkbcommon", "winding Wayland requires libxkbcommon.so.0"],
  ];

  for (const [dependency, message] of cases) {
    try {
      openRequiredWaylandDependency(dependency, () => {
        throw nativeError;
      });
    } catch (error) {
      assert(error instanceof Error);
      assertEquals(error.message, message);
      assert(error.cause === nativeError, `${dependency} must retain the native loader error as its cause`);
      continue;
    }
    throw new Error(`Expected ${dependency} loading to fail`);
  }

  const loaded = {};
  assert(openRequiredWaylandDependency("wayland-client", () => loaded) === loaded);
});

Deno.test("Wayland rejects native layouts its hand-packed bindings cannot represent", () => {
  validateWaylandNativeLayout("linux", "x86_64", true);
  validateWaylandNativeLayout("linux", "aarch64", true);

  const unsupported = [
    ["linux", "x86", true],
    ["linux", "riscv64", true],
    ["linux", "unknown", true],
    ["freebsd", "x86_64", true],
    ["linux", "x86_64", false],
  ] as const;
  for (const [os, arch, littleEndian] of unsupported) {
    assertThrowsMessage(
      () => validateWaylandNativeLayout(os, arch, littleEndian),
      "winding Wayland bindings require 64-bit little-endian Linux on x86-64 or AArch64",
    );
  }
});

Deno.test("Wayland core bind versions respect server, backend, and runtime metadata", () => {
  const iface = new Uint8Array(40) as Uint8Array<ArrayBuffer>;
  new DataView(iface.buffer).setInt32(8, 5, true);
  const offsets: number[] = [];
  const view = new DataView(iface.buffer);
  assertEquals(
    decodeWaylandInterfaceVersion((offset) => {
      offsets.push(offset);
      return view.getInt32(offset, true);
    }),
    5,
  );
  assertEquals(offsets, [8]);

  assertEquals(clampWaylandBindVersion(9, 6, 5), 5);
  assertEquals(clampWaylandBindVersion(4, 6, 5), 4);
  assertEquals(clampWaylandBindVersion(9, 4, 5), 4);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(clampWaylandBindVersion(invalid, 6, 6), 0);
    assertEquals(clampWaylandBindVersion(6, invalid, 6), 0);
    assertEquals(clampWaylandBindVersion(6, 6, invalid), 0);
  }

  const runtimeV5Surface = new WaylandSurfaceOutputScaleState(clampWaylandBindVersion(6, 6, 5));
  runtimeV5Surface.enter(Symbol("output"), 3);
  assertEquals(runtimeV5Surface.effectiveScale(), 3);
  const runtimeV6Surface = new WaylandSurfaceOutputScaleState(clampWaylandBindVersion(6, 6, 6));
  runtimeV6Surface.enter(Symbol("output"), 3);
  assertEquals(runtimeV6Surface.effectiveScale(), 1);
});

Deno.test("xdg-decoration metadata is complete through protocol version 2", () => {
  assertEquals(XDG_DECORATION_PROTOCOL_METADATA, {
    manager: {
      name: "zxdg_decoration_manager_v1",
      version: 2,
      requests: [
        { name: "destroy", signature: "", objectTypes: [] },
        {
          name: "get_toplevel_decoration",
          signature: "no",
          objectTypes: ["toplevelDecoration", "xdgToplevel"],
        },
      ],
      events: [],
    },
    toplevelDecoration: {
      name: "zxdg_toplevel_decoration_v1",
      version: 2,
      requests: [
        { name: "destroy", signature: "", objectTypes: [] },
        { name: "set_mode", signature: "u", objectTypes: [] },
        { name: "unset_mode", signature: "", objectTypes: [] },
      ],
      events: [{ name: "configure", signature: "u", objectTypes: [] }],
    },
  });
  assertEquals({
    managerDestroy: WlOp.ZXDG_DECORATION_MANAGER_DESTROY,
    getToplevelDecoration: WlOp.ZXDG_DECORATION_MANAGER_GET_TOPLEVEL_DECORATION,
    decorationDestroy: WlOp.ZXDG_TOPLEVEL_DECORATION_DESTROY,
    setMode: WlOp.ZXDG_TOPLEVEL_DECORATION_SET_MODE,
    unsetMode: WlOp.ZXDG_TOPLEVEL_DECORATION_UNSET_MODE,
  }, {
    managerDestroy: 0,
    getToplevelDecoration: 1,
    decorationDestroy: 0,
    setMode: 1,
    unsetMode: 2,
  });
  assertEquals(XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES, [["pointer", "pointer", "u32"]]);
  assertEquals(isWaylandGlobalInterface("zxdg_decoration_manager_v1"), true);
});

Deno.test("Wayland decoration generations outlive managers and reject stale configure", () => {
  const firstManager = {};
  const replacementManager = {};
  const managers = new WaylandDecorationManagerState<object>();
  const firstBinding = managers.bind(firstManager, 1);
  const decoration = new WaylandDecorationLifecycle();
  const firstDecoration = decoration.begin(firstBinding.generation, firstBinding.version);
  assert(firstDecoration !== undefined);

  assertEquals(managers.unbind(replacementManager), undefined);
  assert(managers.current === firstBinding);
  assert(managers.unbind(firstManager) === firstBinding);
  assertEquals(managers.current, undefined);
  const replacementBinding = managers.bind(replacementManager, 2);
  assert(replacementBinding.generation !== firstBinding.generation);

  assertEquals(decoration.managerGeneration, firstBinding.generation);
  assertEquals(decoration.begin(replacementBinding.generation, replacementBinding.version), undefined);
  assertEquals(decoration.finish(firstDecoration), true);
  const replacementDecoration = decoration.begin(replacementBinding.generation, replacementBinding.version);
  assert(replacementDecoration !== undefined);
  assertEquals(decoration.configure(firstDecoration, WaylandDecorationMode.serverSide), false);
  assertEquals(decoration.effectiveMode, undefined);
  assertEquals(decoration.configure(replacementDecoration, WaylandDecorationMode.serverSide), true);
  assertEquals(decoration.effectiveMode, WaylandDecorationMode.serverSide);
});

Deno.test("Wayland waits for decoration configure before its initial buffer", () => {
  const requests: string[] = [];
  const lifecycle = new WaylandDecorationLifecycle();
  const managerGeneration = Symbol("manager");
  let decorationGeneration: symbol | undefined;

  setupServerSideDecorationBeforeInitialCommit(
    (preferredMode) => {
      requests.push("create-decoration");
      decorationGeneration = lifecycle.begin(managerGeneration, 1);
      requests.push(`set-mode:${preferredMode}`);
    },
    () => {
      requests.push("surface-commit");
      lifecycle.markInitialSurfaceCommit();
    },
  );

  assert(decorationGeneration !== undefined);
  assertEquals(requests, ["create-decoration", "set-mode:2", "surface-commit"]);
  assertEquals(lifecycle.initialSurfaceCommitSent, true);
  assertEquals(lifecycle.bufferCommitSent, false);
  assertEquals(lifecycle.effectiveMode, undefined);
  assertEquals(lifecycle.canAttachInitialBuffer, false);
  assertEquals(lifecycle.configure(decorationGeneration, 99), false);
  assertEquals(lifecycle.canAttachInitialBuffer, false);
  assertEquals(lifecycle.configure(decorationGeneration, WaylandDecorationMode.clientSide), true);
  assertEquals(lifecycle.effectiveMode, WaylandDecorationMode.clientSide);
  assertEquals(lifecycle.canAttachInitialBuffer, true);
  requests.push("attach-buffer");
  lifecycle.markBufferCommit();
  assertEquals(lifecycle.bufferCommitSent, true);
  assertEquals(requests, ["create-decoration", "set-mode:2", "surface-commit", "attach-buffer"]);
});

Deno.test("Wayland decoration creation distinguishes a null commit from the first buffer", () => {
  const afterNullCommit = new WaylandDecorationLifecycle();
  afterNullCommit.markInitialSurfaceCommit();
  assertEquals(afterNullCommit.canAttachInitialBuffer, true);
  const duringInitialRoundtrip = afterNullCommit.begin(Symbol("late pre-buffer v1"), 1);
  assert(duringInitialRoundtrip !== undefined);
  assertEquals(afterNullCommit.awaitingInitialConfigure, true);
  assertEquals(afterNullCommit.finish(duringInitialRoundtrip), true);

  afterNullCommit.markBufferCommit();
  assertEquals(afterNullCommit.begin(Symbol("late post-buffer v1"), 1), undefined);
  const lateV2 = afterNullCommit.begin(Symbol("late post-buffer v2"), 2);
  assert(lateV2 !== undefined);
  assertEquals(afterNullCommit.canAttachInitialBuffer, true);

  const failed = new WaylandDecorationLifecycle();
  const failedGeneration = failed.begin(Symbol("failed manager"), 1);
  assert(failedGeneration !== undefined);
  assertEquals(failed.canAttachInitialBuffer, false);
  assertEquals(failed.finish(failedGeneration), true);
  failed.markInitialSurfaceCommit();
  assertEquals(failed.canAttachInitialBuffer, true);
});

Deno.test("Wayland decoration destruction retains callbacks and gates dependent objects", () => {
  const destructionError = new Error("decoration destroy failed");
  const failedOrder: string[] = [];
  const failedErrors: unknown[] = [];
  assertEquals(
    tryDestroyWaylandDecoration(
      () => {
        failedOrder.push("destroy-decoration");
        throw destructionError;
      },
      () => failedOrder.push("retain-callback"),
      (error) => failedErrors.push(error),
    ),
    false,
  );
  assertEquals(failedOrder, ["destroy-decoration", "retain-callback"]);
  assertEquals(failedErrors, [destructionError]);

  const abandonOrder: string[] = [];
  assertEquals(
    tryDestroyWaylandDecoration(
      () => abandonOrder.push("destroy-decoration"),
      () => abandonOrder.push("unexpected-retain"),
      () => abandonOrder.push("unexpected-error"),
    ),
    true,
  );
  abandonOrder.push("attach-initial-buffer");
  assertEquals(abandonOrder, ["destroy-decoration", "attach-initial-buffer"]);

  const closeOrder: string[] = [];
  const decorationDestroyed = tryDestroyWaylandDecoration(
    () => closeOrder.push("destroy-decoration"),
    () => closeOrder.push("unexpected-retain"),
    () => closeOrder.push("unexpected-error"),
  );
  if (decorationDestroyed) closeOrder.push("destroy-xdg-toplevel");
  assertEquals(closeOrder, ["destroy-decoration", "destroy-xdg-toplevel"]);
});

Deno.test("Wayland globals keep one owner and promote a deterministic replacement", () => {
  const actions: string[] = [];
  const registry = new WaylandGlobalRegistry<string>(
    (offer) => {
      const binding = `${offer.interface}@${offer.name}`;
      actions.push(`bind ${binding}`);
      return binding;
    },
    (global) => actions.push(`release ${global.binding}`),
  );

  registry.announce({ name: 9, interface: "wl_seat", offeredVersion: 5 });
  registry.announce({ name: 4, interface: "wl_seat", offeredVersion: 3 });
  registry.announce({ name: 7, interface: "wl_seat", offeredVersion: 4 });

  assertEquals(registry.active("wl_seat")?.name, 9);
  assertEquals(actions, ["bind wl_seat@9"]);

  registry.remove(4);
  assertEquals(registry.active("wl_seat")?.name, 9);
  assertEquals(actions, ["bind wl_seat@9"]);

  registry.remove(9);
  assertEquals(registry.active("wl_seat")?.name, 7);
  assertEquals(actions, ["bind wl_seat@9", "release wl_seat@9", "bind wl_seat@7"]);
});

Deno.test("Wayland global lifecycle supports late arrivals, failed binds, and independent interfaces", () => {
  const released: string[] = [];
  const attempts: number[] = [];
  const rejected = new Set([2]);
  const registry = new WaylandGlobalRegistry<string>(
    (offer) => {
      attempts.push(offer.name);
      return rejected.has(offer.name) ? null : `${offer.interface}@${offer.name}`;
    },
    (global) => released.push(global.binding),
  );

  registry.announce({ name: 2, interface: "wp_cursor_shape_manager_v1", offeredVersion: 1 });
  assertEquals(registry.active("wp_cursor_shape_manager_v1"), undefined);

  registry.announce({ name: 8, interface: "wp_cursor_shape_manager_v1", offeredVersion: 1 });
  registry.announce({ name: 3, interface: "zwp_text_input_manager_v3", offeredVersion: 1 });
  assertEquals(registry.active("wp_cursor_shape_manager_v1")?.name, 8);
  assertEquals(registry.active("zwp_text_input_manager_v3")?.name, 3);
  assertEquals(attempts, [2, 2, 8, 3]);

  registry.remove(8);
  assertEquals(registry.active("wp_cursor_shape_manager_v1"), undefined);
  assertEquals(released, ["wp_cursor_shape_manager_v1@8"]);

  rejected.delete(2);
  registry.announce({ name: 11, interface: "wp_cursor_shape_manager_v1", offeredVersion: 1 });
  registry.announce({ name: 10, interface: "wl_compositor", offeredVersion: 4 });
  assertEquals(registry.active("wp_cursor_shape_manager_v1")?.name, 2);
  assertEquals(registry.active("wl_compositor")?.name, 10);

  registry.close();
  assertEquals(released.sort(), [
    "wl_compositor@10",
    "wp_cursor_shape_manager_v1@2",
    "wp_cursor_shape_manager_v1@8",
    "zwp_text_input_manager_v3@3",
  ]);
});

Deno.test("Wayland global candidates are selected independently per interface", () => {
  const active = new Map<WaylandGlobalInterface, number>();
  const released: number[] = [];
  const registry = new WaylandGlobalRegistry<number>(
    (offer) => {
      active.set(offer.interface, offer.name);
      return offer.name;
    },
    (global) => {
      released.push(global.binding);
      active.delete(global.interface);
    },
  );

  registry.announce({ name: 12, interface: "wl_compositor", offeredVersion: 4 });
  registry.announce({ name: 13, interface: "wl_shm", offeredVersion: 1 });
  registry.announce({ name: 14, interface: "wl_compositor", offeredVersion: 4 });
  assertEquals([...active.entries()], [["wl_compositor", 12], ["wl_shm", 13]]);

  registry.remove(12);
  assertEquals(registry.active("wl_compositor")?.name, 14);
  assertEquals(active.get("wl_compositor"), 14);
  registry.close();
  assertEquals(released, [12, 14, 13]);
});

Deno.test("Wayland SHM format advertisements require ARGB8888", () => {
  const state = new WaylandShmFormatState();
  const generation = state.beginBinding();

  assertEquals(state.advertise(generation, WlShmFormat.XRGB8888), false);
  assertEquals(state.advertise(generation, 2 ** 32), false);
  assertEquals(state.hasArgb8888, false);
  assertThrowsMessage(() => state.requireArgb8888(), MISSING_ARGB8888_SHM_FORMAT);

  assertEquals(state.advertise(generation, WlShmFormat.ARGB8888), true);
  assertEquals(state.advertise(generation, WlShmFormat.ARGB8888), false);
  assertEquals(state.hasArgb8888, true);
  state.requireArgb8888();
});

Deno.test("Wayland SHM format generations follow global replacement and ignore stale callbacks", () => {
  interface Binding {
    readonly generation: WaylandShmFormatGeneration;
    closed: boolean;
  }

  const state = new WaylandShmFormatState();
  const bindings = new Map<number, Binding>();
  const registry = new WaylandGlobalRegistry<Binding>(
    (offer) => {
      const binding = { generation: state.beginBinding(), closed: false };
      bindings.set(offer.name, binding);
      return binding;
    },
    (global) => {
      global.binding.closed = true;
      state.releaseBinding(global.binding.generation);
    },
  );

  registry.announce({ name: 9, interface: "wl_shm", offeredVersion: 1 });
  registry.announce({ name: 4, interface: "wl_shm", offeredVersion: 1 });
  const first = bindings.get(9)!;
  state.advertise(first.generation, WlShmFormat.ARGB8888);
  assertEquals(state.hasArgb8888, true);

  registry.remove(9);
  const replacement = bindings.get(4)!;
  assertEquals(first.closed, true);
  assertEquals(state.hasArgb8888, false);

  state.advertise(first.generation, WlShmFormat.ARGB8888);
  assertEquals(state.hasArgb8888, false);
  state.advertise(replacement.generation, WlShmFormat.ARGB8888);
  assertEquals(state.hasArgb8888, true);
  state.releaseBinding(first.generation);
  assertEquals(state.hasArgb8888, true);

  registry.close();
  assertEquals(replacement.closed, true);
  assertEquals(state.hasArgb8888, false);
});

Deno.test("cursor-shape manager metadata includes the version-1 tablet request", () => {
  assertEquals(CURSOR_SHAPE_MANAGER_V1_REQUESTS, [
    { name: "destroy", signature: "", objectTypes: [] },
    { name: "get_pointer", signature: "no", objectTypes: ["cursorShapeDevice", "wlPointer"] },
    { name: "get_tablet_tool_v2", signature: "no", objectTypes: ["cursorShapeDevice", "tabletToolV2"] },
  ]);
  assertEquals(WlOp.WP_CURSOR_SHAPE_MANAGER_GET_TABLET_TOOL_V2, 2);
});

Deno.test("Wayland listener metadata preserves every protocol callback shape", () => {
  assertEquals({
    registry: REGISTRY_EVENT_SIGNATURES,
    shm: SHM_EVENT_SIGNATURES,
    buffer: BUFFER_EVENT_SIGNATURES,
    output: OUTPUT_EVENT_SIGNATURES,
    surface: SURFACE_EVENT_SIGNATURES,
    seat: SEAT_EVENT_SIGNATURES,
    pointer: POINTER_EVENT_SIGNATURES,
    keyboard: KEYBOARD_EVENT_SIGNATURES,
    xdgWmBase: XDG_WM_BASE_EVENT_SIGNATURES,
    xdgSurface: XDG_SURFACE_EVENT_SIGNATURES,
    xdgToplevel: XDG_TOPLEVEL_EVENT_SIGNATURES,
    xdgToplevelDecoration: XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
    textInputV3: TEXT_INPUT_V3_EVENT_SIGNATURES,
  }, {
    registry: [
      ["pointer", "pointer", "u32", "pointer", "u32"],
      ["pointer", "pointer", "u32"],
    ],
    shm: [["pointer", "pointer", "u32"]],
    buffer: [["pointer", "pointer"]],
    output: [
      ["pointer", "pointer", "i32", "i32", "i32", "i32", "i32", "pointer", "pointer", "i32"],
      ["pointer", "pointer", "u32", "i32", "i32", "i32"],
      ["pointer", "pointer"],
      ["pointer", "pointer", "i32"],
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "pointer"],
    ],
    surface: [
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "i32"],
      ["pointer", "pointer", "u32"],
    ],
    seat: [
      ["pointer", "pointer", "u32"],
      ["pointer", "pointer", "pointer"],
    ],
    pointer: [
      ["pointer", "pointer", "u32", "pointer", "i32", "i32"],
      ["pointer", "pointer", "u32", "pointer"],
      ["pointer", "pointer", "u32", "i32", "i32"],
      ["pointer", "pointer", "u32", "u32", "u32", "u32"],
      ["pointer", "pointer", "u32", "u32", "i32"],
      ["pointer", "pointer"],
      ["pointer", "pointer", "u32"],
      ["pointer", "pointer", "u32", "u32"],
      ["pointer", "pointer", "u32", "i32"],
      ["pointer", "pointer", "u32", "i32"],
      ["pointer", "pointer", "u32", "u32"],
    ],
    keyboard: [
      ["pointer", "pointer", "u32", "i32", "u32"],
      ["pointer", "pointer", "u32", "pointer", "pointer"],
      ["pointer", "pointer", "u32", "pointer"],
      ["pointer", "pointer", "u32", "u32", "u32", "u32"],
      ["pointer", "pointer", "u32", "u32", "u32", "u32", "u32"],
      ["pointer", "pointer", "i32", "i32"],
    ],
    xdgWmBase: [["pointer", "pointer", "u32"]],
    xdgSurface: [["pointer", "pointer", "u32"]],
    xdgToplevel: [
      ["pointer", "pointer", "i32", "i32", "pointer"],
      ["pointer", "pointer"],
      ["pointer", "pointer", "i32", "i32"],
      ["pointer", "pointer", "pointer"],
    ],
    xdgToplevelDecoration: [["pointer", "pointer", "u32"]],
    textInputV3: [
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "pointer", "i32", "i32"],
      ["pointer", "pointer", "pointer"],
      ["pointer", "pointer", "u32", "u32"],
      ["pointer", "pointer", "u32"],
    ],
  });
});

Deno.test("Wayland vtables fill only unused slots with their exact signature", () => {
  const provider = {
    callback: (parameters: readonly string[]) => `noop:${parameters.join(",")}`,
  };
  const pointerHandlers = POINTER_EVENT_SIGNATURES.slice(0, 9).map((_signature, index) => `pointer:${index}`);
  assertEquals(resolveVtableCallbacks(pointerHandlers, POINTER_EVENT_SIGNATURES, provider), [
    ...pointerHandlers,
    "noop:pointer,pointer,u32,i32",
    "noop:pointer,pointer,u32,u32",
  ]);

  const toplevelHandlers = ["configure", "close"];
  assertEquals(resolveVtableCallbacks(toplevelHandlers, XDG_TOPLEVEL_EVENT_SIGNATURES, provider), [
    "configure",
    "close",
    "noop:pointer,pointer,i32,i32",
    "noop:pointer,pointer,pointer",
  ]);

  for (
    const signatures of [
      REGISTRY_EVENT_SIGNATURES,
      SHM_EVENT_SIGNATURES,
      BUFFER_EVENT_SIGNATURES,
      OUTPUT_EVENT_SIGNATURES,
      SURFACE_EVENT_SIGNATURES,
      SEAT_EVENT_SIGNATURES,
      KEYBOARD_EVENT_SIGNATURES,
      XDG_WM_BASE_EVENT_SIGNATURES,
      XDG_SURFACE_EVENT_SIGNATURES,
      XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
      TEXT_INPUT_V3_EVENT_SIGNATURES,
    ]
  ) {
    const handlers = signatures.map((_signature, index) => `handler:${index}`);
    assertEquals(resolveVtableCallbacks(handlers, signatures, provider), handlers);
  }
});

Deno.test("exact Wayland no-op callbacks share signatures and close in reverse", () => {
  const created: string[] = [];
  const closed: string[] = [];
  const noops = new WaylandNoopCallbacks((parameters) => {
    const signature = parameters.join(",");
    created.push(signature);
    return {
      pointer: null as unknown as Deno.PointerObject,
      close: () => closed.push(signature),
    };
  });

  const first = noops.callback(["pointer", "pointer", "i32", "i32"]);
  assert(first === noops.callback(["pointer", "pointer", "i32", "i32"]));
  noops.callback(["pointer", "pointer", "pointer"]);
  assertEquals(created, ["pointer,pointer,i32,i32", "pointer,pointer,pointer"]);
  noops.close();
  assertEquals(closed, ["pointer,pointer,pointer", "pointer,pointer,i32,i32"]);
  assertThrowsMessage(() => noops.callback(["pointer", "pointer"]), "no-op callbacks are closed");
});

Deno.test("Wayland core cursor fallback has a visible in-bounds hotspot", () => {
  const pixels = createDefaultCursorPixels();
  assertEquals(pixels.byteLength, DEFAULT_CURSOR_WIDTH * DEFAULT_CURSOR_HEIGHT * 4);
  assert(DEFAULT_CURSOR_HOTSPOT_X >= 0 && DEFAULT_CURSOR_HOTSPOT_X < DEFAULT_CURSOR_WIDTH);
  assert(DEFAULT_CURSOR_HOTSPOT_Y >= 0 && DEFAULT_CURSOR_HOTSPOT_Y < DEFAULT_CURSOR_HEIGHT);
  const hotspot = (DEFAULT_CURSOR_HOTSPOT_Y * DEFAULT_CURSOR_WIDTH + DEFAULT_CURSOR_HOTSPOT_X) * 4;
  assertEquals([...pixels.slice(hotspot, hotspot + 4)], [0, 0, 0, 255]);
});

Deno.test("Wayland sends its stable default app ID before the initial surface commit", () => {
  const requests: string[] = [];
  setDefaultWaylandAppIdBeforeInitialCommit(
    (appId) => requests.push(`app-id:${appId}`),
    () => requests.push("surface-commit"),
  );

  assertEquals(DEFAULT_WAYLAND_APP_ID, "winding");
  assertEquals(WlOp.XDG_TOPLEVEL_SET_APP_ID, 3);
  assertEquals(requests, ["app-id:winding", "surface-commit"]);
});

Deno.test("Wayland surface damage uses only requests supported by the bound version", () => {
  assertEquals(damageOpcodeForSurfaceVersion(1), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(3), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(4), WlOp.SURFACE_DAMAGE_BUFFER);
  assertEquals(damageOpcodeForSurfaceVersion(6), WlOp.SURFACE_DAMAGE_BUFFER);
});

Deno.test("Wayland output globals are owned independently across removal and replacement", () => {
  let nextBinding = 0;
  const released: Array<{ name: number; offeredVersion: number; binding: number }> = [];
  const outputs = new WaylandOutputRegistry(
    (_name, offeredVersion) => offeredVersion < 1 ? null : ++nextBinding,
    (output) => released.push(output),
  );

  const first = outputs.announce(10, 4)!;
  const second = outputs.announce(20, 2)!;
  assert(outputs.announce(10, 99) === first);
  assertEquals(outputs.announce(30, 0), undefined);

  outputs.remove(10);
  outputs.remove(10);
  const replacement = outputs.announce(10, 3)!;
  assert(replacement.binding !== first.binding);
  assert(outputs.get(10) === replacement);
  assert(outputs.get(20) === second);

  outputs.close();
  assertEquals(released, [
    first,
    replacement,
    second,
  ]);
});

Deno.test("Wayland output scale changes are versioned, validated, and batched by done", () => {
  const v1Generation = Symbol("v1 output");
  const v1 = new WaylandOutputScaleState(v1Generation, 1);
  assertEquals(v1.stage(v1Generation, 2), false);
  assertEquals(v1.done(v1Generation), undefined);
  assertEquals(v1.scale, 1);

  const generation = Symbol("current output");
  const staleGeneration = Symbol("removed output");
  const output = new WaylandOutputScaleState(generation, 4);
  assertEquals(output.stage(staleGeneration, 2), false);
  assertEquals(output.stage(generation, 0), false);
  assertEquals(output.stage(generation, 2), true);
  assertEquals(output.scale, 1);
  assertEquals(output.stage(generation, 3), true);
  assertEquals(output.done(staleGeneration), undefined);
  assertEquals(output.done(generation), 3);
  assertEquals(output.scale, 3);
  assertEquals(output.done(generation), undefined);
  assertEquals(output.stage(generation, 3), true);
  assertEquals(output.done(generation), undefined);

  assertEquals(isValidWaylandScale(1), true);
  assertEquals(isValidWaylandScale(0x7fff_ffff), true);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x8000_0000]) {
    assertEquals(isValidWaylandScale(invalid), false);
  }
  assertEquals(outputReleaseStrategy(1), "proxy-destroy");
  assertEquals(outputReleaseStrategy(2), "proxy-destroy");
  assertEquals(outputReleaseStrategy(3), "release");
  assertEquals(outputReleaseStrategy(4), "release");
});

Deno.test("Wayland surfaces select scales from their supported core protocol generation", () => {
  const first = Symbol("first output");
  const second = Symbol("second output");
  const removed = Symbol("removed output");

  const legacy = new WaylandSurfaceOutputScaleState(2);
  assertEquals(legacy.enter(first, 3), true);
  assertEquals(legacy.effectiveScale(), 1);
  assertEquals(legacy.prefer(2), false);

  const fallback = new WaylandSurfaceOutputScaleState(5);
  assertEquals(fallback.enter(first, 2), true);
  assertEquals(fallback.enter(first, 2), false);
  assertEquals(fallback.enter(second, 3), true);
  assertEquals(fallback.effectiveScale(), 3);
  assertEquals(fallback.update(first, 4), true);
  assertEquals(fallback.update(removed, 5), false);
  assertEquals(fallback.effectiveScale(), 4);
  assertEquals(fallback.effectiveScale((scale) => scale < 4), 3);
  assertEquals(fallback.leave(second), true);
  assertEquals(fallback.leave(second), false);
  assertEquals(fallback.effectiveScale(), 4);
  assertEquals(fallback.leave(first), true);
  assertEquals(fallback.effectiveScale(), 1);

  const preferred = new WaylandSurfaceOutputScaleState(6);
  preferred.enter(first, 4);
  assertEquals(preferred.effectiveScale(), 1);
  assertEquals(preferred.prefer(2), true);
  assertEquals(preferred.prefer(2), false);
  assertEquals(preferred.prefer(0), false);
  assertEquals(preferred.effectiveScale(), 2);
  assertEquals(preferred.effectiveScale((scale) => scale !== 2), 1);
});

Deno.test("Wayland scale selection falls back before SHM dimensions overflow", () => {
  const output = Symbol("large output");
  const surface = new WaylandSurfaceOutputScaleState(5);
  surface.enter(output, 2);

  const canAllocate = (scale: number): boolean => {
    try {
      validateWaylandShmLayout(20_000 * scale, 20_000 * scale);
      return true;
    } catch {
      return false;
    }
  };
  assertEquals(canAllocate(1), true);
  assertEquals(canAllocate(2), false);
  assertEquals(surface.effectiveScale(canAllocate), 1);
});

Deno.test("Wayland integer scaling preserves logical size and invalidates stale frames", () => {
  const state = new WaylandConfigureState(640, 480);
  state.stageToplevel(800, 600, false);
  const logical = state.complete(42).configuration;
  const scaled = state.applyScale(logical, 2, true);

  assertEquals(scaled, {
    serial: 42,
    width: 800,
    height: 600,
    framebufferWidth: 1600,
    framebufferHeight: 1200,
    devicePixelRatio: 2,
    suspended: false,
    frameToken: 2,
  });
  assert(state.applyScale(scaled, 2, true) === scaled);
  assertEquals(frameMatchesConfiguration(scaled, 800, 600, 2), false);
  assertEquals(frameMatchesConfiguration(scaled, 1600, 1200, 1), false);
  assertEquals(frameMatchesConfiguration(scaled, 1600, 1200, 2), true);
  assertEquals(frameMatchesConfiguration(scaled, 1600, 1200, undefined), true);

  state.stageToplevel(900, 700, false);
  assertEquals(state.complete(43).configuration.frameToken, 3);
});

Deno.test("Wayland configure serials are acknowledged once despite scale-only generations", () => {
  const acknowledgements: number[] = [];
  const state = new WaylandConfigureAckState();
  assertEquals(state.ack(17, (serial) => acknowledgements.push(serial)), true);
  assertEquals(state.ack(17, (serial) => acknowledgements.push(serial)), false);
  assertEquals(state.ack(0x1_0000_0011, (serial) => acknowledgements.push(serial)), false);
  assertEquals(acknowledgements, [17]);

  assertThrowsMessage(
    () =>
      state.ack(18, () => {
        throw new Error("native send failed");
      }),
    "native send failed",
  );
  assertEquals(state.ack(18, (serial) => acknowledgements.push(serial)), true);
  assertEquals(acknowledgements, [17, 18]);
});

Deno.test("Wayland frame requests scale before attach and damage in supported coordinates", () => {
  assertEquals(planWaylandSurfaceFrame(4, 2, 800, 600, 1600, 1200), [
    { kind: "set-buffer-scale", scale: 2 },
    { kind: "attach" },
    { kind: "damage-buffer", width: 1600, height: 1200 },
    { kind: "commit" },
  ]);
  assertEquals(planWaylandSurfaceFrame(3, 2, 800, 600, 1600, 1200), [
    { kind: "set-buffer-scale", scale: 2 },
    { kind: "attach" },
    { kind: "damage-surface", width: 800, height: 600 },
    { kind: "commit" },
  ]);
  assertEquals(planWaylandSurfaceFrame(2, 2, 800, 600, 800, 600), [
    { kind: "attach" },
    { kind: "damage-surface", width: 800, height: 600 },
    { kind: "commit" },
  ]);
  assertEquals(planWaylandSurfaceFrame(6, 0, 800, 600, 800, 600), [
    { kind: "set-buffer-scale", scale: 1 },
    { kind: "attach" },
    { kind: "damage-buffer", width: 800, height: 600 },
    { kind: "commit" },
  ]);
  assertEquals(WlOp.SURFACE_SET_BUFFER_SCALE, 8);
  assertEquals(WlOp.SURFACE_DAMAGE_BUFFER, 9);
  assertEquals(WlOp.OUTPUT_RELEASE, 0);
});

Deno.test("failed Wayland surface destruction retains proxy listener ownership in order", () => {
  const proxy = { name: "wl_surface" };
  const vtable = { name: "surface listener vtable" };
  const owner = { closed: true, proxy, vtable };
  const callbacks = ["enter", "leave", "preferred-scale"];
  const actions: string[] = [];
  const retainedCallbacks: string[] = [];
  const retainedOwners: typeof owner[] = [];
  const destroyError = new Error("surface destroy failed");
  const errors: unknown[] = [];

  assertEquals(
    tryDestroyWaylandSurfaceWithListeners(
      proxy,
      callbacks,
      owner,
      (candidate) => {
        assert(candidate === owner.proxy);
        actions.push("destroy");
        throw destroyError;
      },
      (callback) => {
        actions.push(`retain-callback:${callback}`);
        retainedCallbacks.push(callback);
      },
      (candidate) => {
        actions.push("retain-owner");
        retainedOwners.push(candidate);
      },
      (error) => {
        actions.push("report-error");
        errors.push(error);
      },
    ),
    false,
  );
  assertEquals(actions, [
    "destroy",
    "retain-callback:enter",
    "retain-callback:leave",
    "retain-callback:preferred-scale",
    "retain-owner",
    "report-error",
  ]);
  assertEquals(retainedCallbacks, callbacks);
  assertEquals(retainedOwners, [owner]);
  assert(retainedOwners[0].proxy === proxy);
  assert(retainedOwners[0].vtable === vtable);
  assertEquals(errors, [destroyError]);

  const successActions: string[] = [];
  assertEquals(
    tryDestroyWaylandSurfaceWithListeners(
      proxy,
      callbacks,
      owner,
      () => successActions.push("destroy"),
      () => successActions.push("retain-callback"),
      () => successActions.push("retain-owner"),
      () => successActions.push("report-error"),
    ),
    true,
  );
  assertEquals(successActions, ["destroy"]);
});

Deno.test("Wayland window mutations share one authoritative post-close boundary", () => {
  const lifecycle = new WaylandWindowLifecycleGate();
  const constructorOperations: WaylandWindowMutationName[] = [];
  lifecycle.mutate("setTitle", () => constructorOperations.push("setTitle"));
  lifecycle.mutate("blit", () => constructorOperations.push("blit"));
  assertEquals(constructorOperations, ["setTitle", "blit"]);

  const calls: WaylandWindowMutationName[] = [];
  const invalidInput = new Error("invalid input must not win after close");
  const operations = {
    setTitle: () => {
      calls.push("setTitle");
      throw invalidInput;
    },
    blit: () => {
      calls.push("blit");
      throw invalidInput;
    },
    setImeEnabled: () => {
      calls.push("setImeEnabled");
      throw invalidInput;
    },
    setImeSurroundingText: () => {
      calls.push("setImeSurroundingText");
      throw invalidInput;
    },
    setImeCursorArea: () => {
      calls.push("setImeCursorArea");
      throw invalidInput;
    },
  } satisfies Record<WaylandWindowMutationName, () => never>;

  assertEquals(lifecycle.close(() => {}), true);
  for (const name of WAYLAND_WINDOW_MUTATION_NAMES) {
    try {
      lifecycle.mutate(name, operations[name]);
    } catch (error) {
      assert(error instanceof Error);
      assertEquals(error.message, WAYLAND_WINDOW_CLOSED_MESSAGE);
      continue;
    }
    throw new Error(`${name} accepted a closed Wayland window`);
  }
  assertEquals(calls, []);
});

Deno.test("Wayland close stays terminal and idempotent across cleanup failure", () => {
  const lifecycle = new WaylandWindowLifecycleGate();
  const cleanupError = new Error("cleanup failed");
  let cleanupCalls = 0;
  let guardedCalls = 0;

  try {
    lifecycle.close(() => {
      cleanupCalls++;
      assertThrowsMessage(
        () =>
          lifecycle.mutate("setTitle", () => {
            guardedCalls++;
          }),
        WAYLAND_WINDOW_CLOSED_MESSAGE,
      );
      throw cleanupError;
    });
  } catch (error) {
    assert(error === cleanupError);
  }

  // The library closes windows through the same idempotent close path. A
  // second owner must neither retry failed cleanup nor reopen the mutation gate.
  assertEquals(lifecycle.close(() => cleanupCalls++), false);
  assertThrowsMessage(
    () =>
      lifecycle.mutate("blit", () => {
        guardedCalls++;
      }),
    WAYLAND_WINDOW_CLOSED_MESSAGE,
  );
  assertEquals(cleanupCalls, 1);
  assertEquals(guardedCalls, 0);
});

Deno.test("Wayland initial window frames are opaque black", () => {
  assertEquals([...createOpaqueBlackFrame(2, 2)], [
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
  ]);
});

Deno.test("Wayland SHM layouts stay within every signed 32-bit protocol field", () => {
  const int32Max = 0x7fff_ffff;
  const largestStrideWidth = Math.floor(int32Max / 4);
  assertEquals(validateWaylandShmLayout(largestStrideWidth, 1), {
    width: largestStrideWidth,
    height: 1,
    stride: int32Max - 3,
    size: int32Max - 3,
  });
  assertThrowsMessage(
    () => validateWaylandShmLayout(largestStrideWidth + 1, 1),
    "winding Wayland SHM stride exceeds the positive signed 32-bit protocol range",
  );

  const largestOnePixelRowCount = Math.floor(int32Max / 4);
  assertEquals(validateWaylandShmLayout(1, largestOnePixelRowCount), {
    width: 1,
    height: largestOnePixelRowCount,
    stride: 4,
    size: int32Max - 3,
  });
  assertThrowsMessage(
    () => validateWaylandShmLayout(1, largestOnePixelRowCount + 1),
    "winding Wayland SHM pool size exceeds the positive signed 32-bit protocol range",
  );
  assertThrowsMessage(
    () => validateWaylandShmLayout(int32Max + 1, 1),
    "winding Wayland SHM width exceeds the positive signed 32-bit protocol range",
  );
  assertThrowsMessage(
    () => validateWaylandShmLayout(1, int32Max + 1),
    "winding Wayland SHM height exceeds the positive signed 32-bit protocol range",
  );
});

Deno.test("Wayland SHM layouts reject non-integral and unsafe dimensions", () => {
  const invalid = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53];
  for (const width of invalid) {
    assertThrowsMessage(
      () => validateWaylandShmLayout(width, 1),
      "winding Wayland SHM width must be a positive safe integer",
    );
  }
  for (const height of invalid) {
    assertThrowsMessage(
      () => validateWaylandShmLayout(1, height),
      "winding Wayland SHM height must be a positive safe integer",
    );
  }
});

Deno.test("Wayland SHM frames require exact complete RGBA storage", () => {
  assertEquals(validateWaylandShmFrame(2, 2, 16), { width: 2, height: 2, stride: 8, size: 16 });
  for (const byteLength of [12, 15, 17, 20]) {
    assertThrowsMessage(
      () => validateWaylandShmFrame(2, 2, byteLength),
      `winding Wayland blit needs exactly 16 RGBA bytes, received ${byteLength}`,
    );
  }
});

Deno.test("Wayland connection errors retain protocol object details", () => {
  assertEquals(
    waylandConnectionError("dispatching display events", 71, "xdg_surface", 42, 3).message,
    "winding Wayland connection failed during dispatching display events: " +
      "xdg_surface@42 reported protocol error 3 (display error 71)",
  );
  assertEquals(
    waylandConnectionError("reading display events", 0).message,
    "winding Wayland connection closed during reading display events",
  );
});

Deno.test("Wayland initialization cleanup preserves the primary error and unwinds in reverse", () => {
  const primary = new Error("initialization failed");
  const clean = new NativeInitializationCleanup();
  clean.defer(() => {});
  try {
    clean.fail(primary, "unreachable aggregate");
  } catch (error) {
    assert(error === primary, "cleanup without failures must rethrow the original error object");
  }

  const order: string[] = [];
  const firstCleanupError = new Error("first cleanup failed");
  const lastCleanupError = new Error("last cleanup failed");
  const failing = new NativeInitializationCleanup();
  failing.defer(() => {
    order.push("first acquired");
    throw firstCleanupError;
  });
  failing.defer(() => order.push("second acquired"));
  failing.defer(() => {
    order.push("last acquired");
    throw lastCleanupError;
  });

  try {
    failing.fail(primary, "winding initialization unwind failed");
  } catch (error) {
    assert(error instanceof AggregateError);
    assertEquals(error.message, "winding initialization unwind failed");
    assert(error.errors[0] === primary);
    assert(error.errors[1] === lastCleanupError);
    assert(error.errors[2] === firstCleanupError);
  }
  assertEquals(order, ["last acquired", "second acquired", "first acquired"]);
});

Deno.test("Wayland poll errors and disconnects are terminal readiness", () => {
  assertEquals(hasFatalPollEvent(POLLIN), false);
  assertEquals(hasFatalPollEvent(POLLERR), true);
  assertEquals(hasFatalPollEvent(POLLHUP), true);
  assertEquals(hasFatalPollEvent(POLLNVAL), true);
  assertEquals(hasFatalPollEvent(POLLIN | POLLHUP), true);
});

Deno.test("Wayland poll declares pointer-width nfds_t", () => {
  assertEquals(libcSymbols.poll, {
    parameters: ["buffer", "usize", "i32"],
    result: "i32",
  });
});

Deno.test("wl_array uint32 decoding is aligned, bounded, and null-safe", () => {
  const values = [42, 54, 30];
  const read = (offset: number) => values[offset / Uint32Array.BYTES_PER_ELEMENT];
  assertEquals(decodeWlArrayU32(12n, 1n, read), values);
  assertEquals(readWlArrayU32(null), []);
  assertEquals(decodeWlArrayU32(3n, 1n, read), []);
  assertEquals(decodeWlArrayU32(BigInt((4096 + 1) * Uint32Array.BYTES_PER_ELEMENT), 1n, read), []);
  assertEquals(decodeWlArrayU32(4n, 0n, read), []);
});

Deno.test("keyboard enter batches intervening transitions until modifiers arrive", () => {
  const batch = new WaylandEnterKeyBatch();
  batch.begin([42, 30]);
  assertEquals(batch.awaitingModifiers, true);
  assertEquals(batch.defer({ rawKeycode: 42, pressed: false }), true);
  assertEquals(batch.defer({ rawKeycode: 31, pressed: true }), true);
  assertEquals(batch.complete(), {
    heldKeys: [42, 30],
    deferredTransitions: [
      { rawKeycode: 42, pressed: false },
      { rawKeycode: 31, pressed: true },
    ],
  });
  assertEquals(batch.awaitingModifiers, false);
  assertEquals(batch.complete(), undefined);
  assertEquals(batch.defer({ rawKeycode: 32, pressed: true }), false);

  batch.begin([54]);
  batch.defer({ rawKeycode: 54, pressed: false });
  batch.reset();
  assertEquals(batch.complete(), undefined);
});

Deno.test("held enter keys retain their logical identity without synthetic presses", () => {
  const state = new WaylandKeyTransitionState();
  let layoutKey = "a";
  state.confirmModifiers(keyModifiers());
  state.seedHeldKeys([30], () => layoutKey);

  assertEquals(state.pressedKeyCount, 1);
  layoutKey = "q";
  assertEquals(state.resolve(30, "repeat", layoutKey).key, "a");
  assertEquals(state.resolve(30, "release", layoutKey).key, "a");
  assertEquals(state.pressedKeyCount, 0);
});

Deno.test("keyboard focus generation reset drops held and provisional state", () => {
  const state = new WaylandKeyTransitionState();
  state.confirmModifiers(keyModifiers());
  state.seedHeldKeys([42, 30], (rawKeycode) => rawKeycode === 42 ? "Shift" : "a");
  assertEquals(state.resolve(54, "press", "Shift").modifiers.shiftKey, true);

  state.reset();
  assertEquals(state.pressedKeyCount, 0);
  assertEquals(state.modifiers, keyModifiers());
  assertEquals(state.resolve(30, "release", "q").key, "q");
});

Deno.test("left and right modifier transitions use post-transition group state", () => {
  const cases = [
    { key: "Shift", field: "shiftKey" },
    { key: "Control", field: "ctrlKey" },
    { key: "Alt", field: "altKey" },
    { key: "Meta", field: "metaKey" },
  ] as const;

  for (const { key, field } of cases) {
    const state = new WaylandKeyTransitionState();
    state.confirmModifiers(keyModifiers());

    assertEquals(state.resolve(10, "press", key).modifiers[field], true);
    state.confirmModifiers(keyModifiers({ [field]: true }));
    assertEquals(state.resolve(11, "press", key).modifiers[field], true);

    const firstRelease = state.resolve(10, "release", "layout changed");
    assertEquals(firstRelease.key, key);
    assertEquals(firstRelease.modifiers[field], true);
    const finalRelease = state.resolve(11, "release", "layout changed");
    assertEquals(finalRelease.key, key);
    assertEquals(finalRelease.modifiers[field], false);
  }
});

Deno.test("CapsLock toggles on keydown only and AltGraph disables the accelerator", () => {
  const caps = new WaylandKeyTransitionState();
  caps.confirmModifiers(keyModifiers());
  assertEquals(caps.resolve(58, "press", "CapsLock").modifiers.capsLock, true);
  assertEquals(caps.resolve(58, "repeat", "CapsLock").modifiers.capsLock, true);
  caps.confirmModifiers(keyModifiers({ capsLock: true }));
  assertEquals(caps.resolve(58, "release", "layout changed").modifiers.capsLock, true);
  assertEquals(caps.resolve(58, "press", "CapsLock").modifiers.capsLock, false);

  const altGraph = new WaylandKeyTransitionState();
  altGraph.confirmModifiers(keyModifiers({ ctrlKey: true, accelKey: true }));
  const transition = altGraph.resolve(100, "press", "AltGraph").modifiers;
  assertEquals(transition.ctrlKey, true);
  assertEquals(transition.altGraphKey, true);
  assertEquals(transition.accelKey, false);
});

Deno.test("Wayland pointer capability transitions are symmetric", () => {
  assertEquals(pointerCapabilityAction(true, false), "acquire");
  assertEquals(pointerCapabilityAction(false, true), "release");
  assertEquals(pointerCapabilityAction(true, true), undefined);
  assertEquals(pointerCapabilityAction(false, false), undefined);
});

Deno.test("pointer v5 frames coalesce exact diagonal scroll vectors", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(5);

  assertEquals(frame.axis(10, WaylandPointerAxis.vertical, 2560), undefined);
  assertEquals(frame.axis(11, WaylandPointerAxis.horizontal, -384), undefined);
  assertEquals(frame.frame(), {
    time: 11,
    deltaX: -1.5,
    deltaY: 10,
    deltaMode: 0,
  });
  assertEquals(frame.frame(), undefined);
});

Deno.test("Wayland fixed-point halves retain precision and sign symmetry", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(5);
  frame.axis(1, WaylandPointerAxis.vertical, 128);
  frame.axis(2, WaylandPointerAxis.horizontal, -128);

  assertEquals(frame.frame(), {
    time: 2,
    deltaX: -0.5,
    deltaY: 0.5,
    deltaMode: 0,
  });
});

Deno.test("discrete wheel frames use browser line units", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(5);

  // source and discrete ordering is deliberately independent of axis ordering.
  frame.axisDiscrete(WaylandPointerAxis.horizontal, -1);
  frame.axisSource(WaylandPointerAxisSource.wheel);
  frame.axisDiscrete(WaylandPointerAxis.vertical, 2);
  frame.axis(20, WaylandPointerAxis.vertical, 5120);
  frame.axis(20, WaylandPointerAxis.horizontal, -2560);
  assertEquals(frame.frame(), {
    time: 20,
    deltaX: -1,
    deltaY: 2,
    deltaMode: 1,
  });
});

Deno.test("smooth finger and continuous frames keep exact pixel units", () => {
  for (const source of [WaylandPointerAxisSource.finger, WaylandPointerAxisSource.continuous]) {
    const frame = new WaylandPointerFrameAccumulator();
    frame.beginGeneration(5);
    frame.axisDiscrete(WaylandPointerAxis.vertical, 1);
    frame.axisSource(source);
    frame.axis(30, WaylandPointerAxis.vertical, 128);
    assertEquals(frame.frame(), {
      time: 30,
      deltaX: 0,
      deltaY: 0.5,
      deltaMode: 0,
    });
  }
});

Deno.test("axis stop clears only the stopped direction", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(5);
  frame.axisDiscrete(WaylandPointerAxis.vertical, 1);
  frame.axis(40, WaylandPointerAxis.vertical, 256);
  frame.axis(41, WaylandPointerAxis.horizontal, -128);
  frame.axisStop(42, WaylandPointerAxis.vertical);

  assertEquals(frame.frame(), {
    time: 42,
    deltaX: -0.5,
    deltaY: 0,
    deltaMode: 0,
  });
  frame.axis(43, WaylandPointerAxis.vertical, 256);
  frame.axisStop(44, WaylandPointerAxis.vertical);
  assertEquals(frame.frame(), undefined);

  // A later axis event starts a new motion sequence after the stop.
  frame.axisStop(45, WaylandPointerAxis.vertical);
  frame.axis(45, WaylandPointerAxis.vertical, 256);
  assertEquals(frame.frame(), {
    time: 45,
    deltaX: 0,
    deltaY: 1,
    deltaMode: 0,
  });
});

Deno.test("pointer frames and generations do not leak old scroll metadata", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(5);
  frame.axisSource(WaylandPointerAxisSource.wheel);
  frame.axisDiscrete(WaylandPointerAxis.vertical, 1);
  frame.axis(50, WaylandPointerAxis.vertical, 2560);
  assertEquals(frame.frame()?.deltaMode, 1);

  frame.axis(51, WaylandPointerAxis.vertical, 128);
  assertEquals(frame.frame(), {
    time: 51,
    deltaX: 0,
    deltaY: 0.5,
    deltaMode: 0,
  });

  frame.axis(52, WaylandPointerAxis.vertical, 256);
  frame.beginGeneration(4);
  assertEquals(frame.frame(), undefined);
  assertEquals(frame.axis(53, WaylandPointerAxis.vertical, 128), {
    time: 53,
    deltaX: 0,
    deltaY: 0.5,
    deltaMode: 0,
  });
});

Deno.test("legacy pointer axes dispatch immediately without rounding", () => {
  const frame = new WaylandPointerFrameAccumulator();
  frame.beginGeneration(4);

  assertEquals(frame.axis(60, WaylandPointerAxis.vertical, 128), {
    time: 60,
    deltaX: 0,
    deltaY: 0.5,
    deltaMode: 0,
  });
  assertEquals(frame.axis(61, WaylandPointerAxis.horizontal, -128), {
    time: 61,
    deltaX: -0.5,
    deltaY: 0,
    deltaMode: 0,
  });
  assertEquals(frame.frame(), undefined);
});

Deno.test("enter coordinates seed snapshots before the first motion", () => {
  const position = new WaylandPointerPosition();
  position.updateFixed(384, -128);

  assertEquals({ x: position.x, y: position.y }, { x: 1.5, y: -0.5 });
});

Deno.test("Wayland configurations latch role state and serial as one generation", () => {
  const state = new WaylandConfigureState(640, 480);
  state.stageToplevel(800, 600, false);
  const first = state.complete(17);
  state.stageToplevel(1920, 1080, true);
  const second = state.complete(18);

  assertEquals(first, {
    configuration: {
      serial: 17,
      width: 800,
      height: 600,
      framebufferWidth: 800,
      framebufferHeight: 600,
      devicePixelRatio: 1,
      suspended: false,
      frameToken: 1,
    },
    visibilityChanged: false,
  });
  assertEquals(second, {
    configuration: {
      serial: 18,
      width: 1920,
      height: 1080,
      framebufferWidth: 1920,
      framebufferHeight: 1080,
      devicePixelRatio: 1,
      suspended: true,
      frameToken: 2,
    },
    visibilityChanged: true,
  });
  assertEquals(frameMatchesConfiguration(second.configuration, 800, 600, 1), false);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, 1), false);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, 2), true);
  assertEquals(frameMatchesConfiguration(second.configuration, 1920, 1080, undefined), true);
});

Deno.test("zero configure dimensions retain each client-selected axis independently", () => {
  const state = new WaylandConfigureState(640, 480);
  state.stageToplevel(1200, 0, false);
  assertEquals(state.complete(0).configuration, {
    serial: 0,
    width: 1200,
    height: 480,
    framebufferWidth: 1200,
    framebufferHeight: 480,
    devicePixelRatio: 1,
    suspended: false,
    frameToken: 1,
  });

  state.stageToplevel(0, 900, false);
  assertEquals(state.complete(1).configuration, {
    serial: 1,
    width: 1200,
    height: 900,
    framebufferWidth: 1200,
    framebufferHeight: 900,
    devicePixelRatio: 1,
    suspended: false,
    frameToken: 2,
  });
});

Deno.test("Compose locale resolution follows the locale precedence and ignores empty values", () => {
  const environment = new Map([
    ["LC_ALL", ""],
    ["LC_CTYPE", "de_DE.UTF-8"],
    ["LANG", "en_US.UTF-8"],
  ]);

  assertEquals(resolveComposeLocale((name) => environment.get(name)), "de_DE.UTF-8");
  environment.set("LC_ALL", "pl_PL.UTF-8");
  assertEquals(resolveComposeLocale((name) => environment.get(name)), "pl_PL.UTF-8");
});

Deno.test("Compose locale resolution tolerates inaccessible variables and falls back to C", () => {
  assertEquals(
    resolveComposeLocale((name) => {
      if (name === "LC_ALL") throw new Error("permission denied");
      return name === "LANG" ? "fr_FR.UTF-8" : undefined;
    }),
    "fr_FR.UTF-8",
  );
  assertEquals(resolveComposeLocale(() => undefined), "C");
});

Deno.test("Wayland raw keycodes remain separate from xkb keycodes", () => {
  assertEquals(toXkbKeycode(0), 8);
  assertEquals(toXkbKeycode(16), 24);

  let receivedKeycode = -1;
  const translator = translatorFor({
    keysym: 0x71,
    keyText: "q",
    text: "q",
    onKeycode: (keycode) => receivedKeycode = keycode,
  });
  const translated = translateKey(16, "press", translator);

  assertEquals(receivedKeycode, 24);
  assertEquals(translated, {
    rawKeycode: 16,
    xkbKeycode: 24,
    keysym: 0x71,
    key: "q",
    text: "q",
    isComposing: false,
  });
});

Deno.test("key locations distinguish modifiers and numpad keys from arrows", () => {
  assertEquals(keyLocationForCode("ShiftLeft"), 1);
  assertEquals(keyLocationForCode("AltRight"), 2);
  assertEquals(keyLocationForCode("Numpad1"), 3);
  assertEquals(keyLocationForCode("NumpadParenLeft"), 3);
  assertEquals(keyLocationForCode("ArrowLeft"), 0);
  assertEquals(keyLocationForCode("ArrowRight"), 0);
  assertEquals(keyLocationForCode("KeyA"), 0);
});

Deno.test("key release resolves a logical key without generating text or feeding Compose", () => {
  let textLookups = 0;
  const translator = translatorFor({
    keysym: 0xff51,
    keyText: "",
    text: "ignored",
    onTextLookup: () => textLookups++,
  });
  const compose = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.NOTHING, "ignored");

  assertEquals(translateKey(105, "release", translator, compose), {
    rawKeycode: 105,
    xkbKeycode: 113,
    keysym: 0xff51,
    key: "ArrowLeft",
    isComposing: false,
  });
  assertEquals(textLookups, 0);
  assertEquals(compose.feedCount, 0);
});

Deno.test("Compose translation handles composing, composed, cancelled, and ignored feeds", () => {
  const translator = translatorFor({ keysym: 0x65, keyText: "e", text: "e" });

  const composing = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.COMPOSING, "");
  assertEquals(translateKey(18, "press", translator, composing), {
    rawKeycode: 18,
    xkbKeycode: 26,
    keysym: 0x65,
    key: "e",
    isComposing: true,
  });
  assertEquals(composing.resetCount, 0);

  const composed = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.COMPOSED, "é");
  assertEquals(translateKey(18, "press", translator, composed), {
    rawKeycode: 18,
    xkbKeycode: 26,
    keysym: 0x65,
    key: "é",
    text: "é",
    isComposing: false,
  });
  assertEquals(composed.resetCount, 1);

  const cancelled = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.CANCELLED, "unused");
  assertEquals(translateKey(18, "press", translator, cancelled).text, undefined);
  assertEquals(cancelled.resetCount, 1);

  const ignored = new FakeCompose(ComposeFeedResult.IGNORED, ComposeStatus.COMPOSING, "unused");
  const ignoredResult = translateKey(18, "press", translator, ignored);
  assertEquals(ignoredResult.text, undefined);
  assertEquals(ignoredResult.isComposing, true);
  assertEquals(ignored.resetCount, 0);
});

Deno.test("Compose NOTHING falls back to the active xkb layout text", () => {
  const translator = translatorFor({ keysym: 0x010020ac, keyText: "€", text: "€" });
  const compose = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.NOTHING, "");

  const result = translateKey(18, "repeat", translator, compose);
  assertEquals(result.key, "€");
  assertEquals(result.text, "€");
  assertEquals(result.isComposing, false);
});

Deno.test("ordinary wl_keyboard events remain the local Compose fallback path", () => {
  const translator = translatorFor({ keysym: 0x65, keyText: "e", text: "e" });
  const compose = new FakeCompose(ComposeFeedResult.ACCEPTED, ComposeStatus.COMPOSED, "é");

  assertEquals(translateWlKeyboardKey(18, "press", translator, compose), {
    rawKeycode: 18,
    xkbKeycode: 26,
    keysym: 0x65,
    key: "é",
    text: "é",
    isComposing: false,
  });
  assertEquals(compose.feedCount, 1);
});

Deno.test("xkb control strings stay named keys and are not committed as text", () => {
  const controls = [
    { keysym: 0xff08, keyText: "\b", text: "\b", key: "Backspace" },
    { keysym: 0xff09, keyText: "\t", text: "\t", key: "Tab" },
    { keysym: 0xff0d, keyText: "\r", text: "\r", key: "Enter" },
  ];

  for (const control of controls) {
    const result = translateKey(1, "press", translatorFor(control));
    assertEquals(result.key, control.key);
    assertEquals(result.text, undefined);
  }
});

Deno.test("Wayland edit ownership leaves delivered shortcuts to key defaults", () => {
  const plain = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
  assertEquals(waylandKeyEditDisposition("a", "a", false, plain), "text-input");
  assertEquals(waylandKeyEditDisposition("ArrowLeft", undefined, false, plain), "key-default");
  assertEquals(
    waylandKeyEditDisposition("a", "a", false, { ...plain, altKey: true }),
    "key-default",
  );
  assertEquals(
    waylandKeyEditDisposition("c", undefined, false, { ...plain, ctrlKey: true, accelKey: true }),
    "key-default",
  );
  assertEquals(
    waylandKeyEditDisposition("@", "@", false, {
      ...plain,
      ctrlKey: true,
      altKey: true,
      altGraphKey: true,
    }),
    "text-input",
  );
  assertEquals(waylandKeyEditDisposition("Dead", undefined, false, plain), "text-input");
});

Deno.test("logical keysym mapping covers printable, named, dead, function, and keypad keys", () => {
  assertEquals(logicalKeyFromKeysym(0x010020ac, "€"), "€");
  assertEquals(logicalKeyFromKeysym(0x0101f642), "🙂");
  assertEquals(logicalKeyFromKeysym(0xff08), "Backspace");
  assertEquals(logicalKeyFromKeysym(0xffca), "F13");
  assertEquals(logicalKeyFromKeysym(0xffb7), "7");
  assertEquals(logicalKeyFromKeysym(0xfe51), "Dead");
  assertEquals(logicalKeyFromKeysym(0xfe03), "AltGraph");
  assertEquals(logicalKeyFromKeysym(0x1234, "\n"), "Unidentified");
  assertEquals(logicalKeyFromKeysym(0x1234), "Unidentified");
});

Deno.test("preedit cursor ranges use UTF-8 byte boundaries", () => {
  assertEquals(validateImeCursorRange("plain", 1, 4), [1, 4]);
  assertEquals(validateImeCursorRange("é日", 2, 5), [2, 5]);
  assertEquals(validateImeCursorRange("é日", 1, 5), null);
  assertEquals(validateImeCursorRange("é日", 2, 4), null);
  assertEquals(validateImeCursorRange("é日", 5, 6), null);
  assertEquals(validateImeCursorRange("text", -1, -1), null);
  assertEquals(validateImeCursorRange("text", 3, 2), null);
  assertEquals(validateImeCursorRange("", 0, 0), [0, 0]);
});

Deno.test("cursor rectangles are outward-rounded and clamped to Wayland ints", () => {
  assertEquals(normalizeImeCursorArea(10.25, 20.75, 3.1, 4.1), {
    x: 10,
    y: 20,
    width: 4,
    height: 5,
  });
  assertEquals(normalizeImeCursorArea(10.25, 20.75, -3, 0), {
    x: 10,
    y: 20,
    width: 0,
    height: 0,
  });
  assertEquals(normalizeImeCursorArea(-1e20, -1e20, 2e20, 2e20), {
    x: -0x80000000,
    y: -0x80000000,
    width: 0x7fffffff,
    height: 0x7fffffff,
  });
  assertEquals(normalizeImeCursorArea(Number.NaN, 0, 1, 1), undefined);
});

Deno.test("text-input done flushes edits in protocol order and reports serial matches", () => {
  const batch = new TextInputV3Batch();
  assertEquals(batch.recordClientCommit(), 1);
  batch.setPreedit("éx", 2, 3);

  assertEquals(batch.done(1), {
    serial: 1,
    serialMatches: true,
    edits: [{ type: "preedit", text: "éx", cursorRange: [2, 3] }],
  });
  assert(batch.hasVisiblePreedit);

  batch.setDeleteSurrounding(4, 2);
  batch.setCommit("好");
  batch.setPreedit("next", 1, 3);
  assertEquals(batch.done(0), {
    serial: 0,
    serialMatches: false,
    edits: [
      { type: "preedit", text: "", cursorRange: null },
      { type: "deleteSurrounding", beforeBytes: 4, afterBytes: 2 },
      { type: "commit", text: "好" },
      { type: "preedit", text: "next", cursorRange: [1, 3] },
    ],
  });
});

Deno.test("stale text-input done applies edits while coalescing state until a matching serial", () => {
  const gate = new TextInputV3SerialGate();
  let latestState = { surrounding: "initial", cursorX: 1 };
  const sentStates: Array<typeof latestState> = [];
  const appliedEdits: string[] = [];
  let commits = 0;
  const sendLatestState = () => {
    sentStates.push({ ...latestState });
    commits++;
  };

  assert(gate.sendState(sendLatestState));
  assert(!gate.handleDone(false, () => appliedEdits.push("stale edit")));

  latestState = { surrounding: "first update", cursorX: 5 };
  assert(!gate.sendState(sendLatestState));
  latestState = { surrounding: "latest update", cursorX: 9 };
  assert(!gate.sendState(sendLatestState));
  assertEquals(commits, 1);

  assert(gate.handleDone(
    true,
    () => {
      appliedEdits.push("matching edit");
      latestState = { surrounding: "after matching edit", cursorX: 12 };
      assert(!gate.sendState(sendLatestState));
    },
  ));

  // Recovery waits until the application has consumed every event from the matching done batch.
  assertEquals(commits, 1);
  assert(gate.finishRecovery(sendLatestState));

  assertEquals(appliedEdits, ["stale edit", "matching edit"]);
  assertEquals(sentStates, [
    { surrounding: "initial", cursorX: 1 },
    { surrounding: "after matching edit", cursorX: 12 },
  ]);
  assertEquals(commits, 2);
  assert(!gate.finishRecovery(sendLatestState));
  assertEquals(commits, 2);
  assertEquals(gate.awaitingMatchingDone, false);
});

Deno.test("text-input serial gating resets at activation, focus, and teardown boundaries", () => {
  for (const boundary of ["activation", "focus", "teardown"]) {
    const gate = new TextInputV3SerialGate();
    gate.handleDone(false, () => undefined);
    assert(gate.awaitingMatchingDone, `${boundary} setup should be gated`);

    gate.reset();
    gate.handleDone(false, () => undefined);
    assert(gate.handleDone(true, () => undefined), `${boundary} setup should schedule recovery`);
    gate.reset();
    assert(
      !gate.finishRecovery(() => {
        throw new Error(`${boundary} must cancel deferred recovery`);
      }),
    );
    let sends = 0;
    assert(gate.sendState(() => sends++), `${boundary} should permit fresh state`);
    assertEquals(sends, 1);
  }
});

Deno.test("replacing a text-input proxy resets its protocol-local commit serial", () => {
  const batch = new TextInputV3Batch();
  assertEquals(batch.recordClientCommit(), 1);
  batch.setPreedit("visible", 0, 7);
  batch.done(1);
  assertEquals(batch.recordClientCommit(), 2);
  batch.setCommit("must not cross proxies");

  assertEquals(batch.resetProtocolState(), [{ type: "preedit", text: "", cursorRange: null }]);
  assertEquals(batch.clientCommitSerial, 0);
  assertEquals(batch.done(0).edits, []);
});

Deno.test("text-input pending fields reset and reverse cursor endpoints are normalized", () => {
  const batch = new TextInputV3Batch();
  batch.setDeleteSurrounding(-10, Number.POSITIVE_INFINITY);
  batch.setPreedit("é日", 5, 2);

  assertEquals(batch.done(0).edits, [
    { type: "preedit", text: "é日", cursorRange: [2, 5] },
  ]);
  assertEquals(batch.done(0).edits, [
    { type: "preedit", text: "", cursorRange: null },
  ]);
  assertEquals(batch.hasVisiblePreedit, false);
});

Deno.test("text-input preserves exact nonempty native commit strings", () => {
  const batch = new TextInputV3Batch();
  batch.setPreedit("visible", 0, 7);
  batch.done(0);
  batch.setCommit("line one\nline two\u0003");

  // The commit itself atomically removes old preedit in the public API.
  assertEquals(batch.done(0).edits, [{ type: "commit", text: "line one\nline two\u0003" }]);
});

Deno.test("native text-input edits reset pending local Compose before emission", () => {
  const order: string[] = [];
  const window = { composition: new CompositionState() } as unknown as WaylandWindow;

  emitWaylandTextInputEdits(
    {
      resetLocalCompose: () => order.push("reset-compose"),
      pushEvent: (event) => order.push(`${event.type}/${event.type === "ime" ? event.kind : ""}`),
    },
    window,
    [{ type: "commit", text: "native" }],
  );
  assertEquals(order, ["reset-compose", "ime/commit"]);

  emitWaylandTextInputEdits(
    {
      resetLocalCompose: () => order.push("unexpected-reset"),
      pushEvent: () => order.push("unexpected-event"),
    },
    window,
    [],
  );
  assertEquals(order, ["reset-compose", "ime/commit"]);
});

Deno.test("bare, delete-only, null, and empty batches all clear old preedit", () => {
  const batch = new TextInputV3Batch();
  const showPreedit = () => {
    batch.setPreedit("visible", 0, 7);
    batch.done(0);
  };

  showPreedit();
  assertEquals(batch.done(0).edits, [{ type: "preedit", text: "", cursorRange: null }]);

  showPreedit();
  batch.setDeleteSurrounding(2, 1);
  assertEquals(batch.done(0).edits, [
    { type: "preedit", text: "", cursorRange: null },
    { type: "deleteSurrounding", beforeBytes: 2, afterBytes: 1 },
  ]);

  showPreedit();
  batch.setCommit(null);
  assertEquals(batch.done(0).edits, [{ type: "preedit", text: "", cursorRange: null }]);

  showPreedit();
  batch.setCommit("");
  assertEquals(batch.done(0).edits, [{ type: "preedit", text: "", cursorRange: null }]);
  assertEquals(batch.hasVisiblePreedit, false);
});

Deno.test("Wayland surrounding text validates UTF-8 ranges and preserves selection direction", () => {
  assertEquals(createWaylandSurroundingTextState("A🙂BC", 1, 5), {
    text: "A🙂BC",
    selectionStartBytes: 1,
    selectionEndBytes: 5,
    wireText: "A🙂BC",
    cursorBytes: 5,
    anchorBytes: 1,
  });
  assertThrowsMessage(
    () => createWaylandSurroundingTextState("é", 1, 2),
    "invalid UTF-8 surrounding-text selection",
  );
  assertThrowsMessage(
    () => createWaylandSurroundingTextState("text", 3, 2),
    "invalid UTF-8 surrounding-text selection",
  );
  assertThrowsMessage(
    () => createWaylandSurroundingTextState("before\0after", 6, 6),
    "surrounding text cannot contain NUL",
  );
});

Deno.test("Wayland surrounding text slices long context on UTF-8 boundaries", () => {
  const text = `${"a".repeat(3000)}é${"b".repeat(3000)}`;
  const state = createWaylandSurroundingTextState(text, 3000, 3002);
  const wireBytes = new TextEncoder().encode(state.wireText);
  assert(wireBytes.byteLength <= 4000);
  assertEquals(state.cursorBytes - state.anchorBytes, 2);
  assertEquals(
    new TextDecoder().decode(wireBytes.slice(state.anchorBytes, state.cursorBytes)),
    "é",
  );
  assertThrowsMessage(
    () => createWaylandSurroundingTextState("a".repeat(4001), 0, 4001),
    "selection exceeds the 4000-byte protocol limit",
  );
});

Deno.test("resetEdits clears both visible and uncommitted text-input state", () => {
  const batch = new TextInputV3Batch();
  batch.setPreedit("visible", 0, 0);
  batch.done(0);
  batch.setCommit("must not leak");

  assertEquals(batch.resetEdits(), [{ type: "preedit", text: "", cursorRange: null }]);
  assertEquals(batch.done(0).edits, []);
});

Deno.test("key repeat honors delay and rate while skipping missed catch-up events", () => {
  let now = 0;
  const repeat = new KeyRepeatController(() => now);
  repeat.setRepeatInfo(25, 400);
  repeat.press(30, true);

  now = 399;
  assertEquals(repeat.poll(), undefined);
  now = 400;
  assertEquals(repeat.poll(), 30);
  assertEquals(repeat.nextDeadline, 440);
  assertEquals(repeat.poll(), undefined);

  now = 600;
  assertEquals(repeat.poll(), 30);
  assertEquals(repeat.nextDeadline, 640);
  assertEquals(repeat.poll(), undefined);
});

Deno.test("repeat returns the raw key for translation under the latest xkb state", () => {
  let now = 0;
  let text = "a";
  const repeat = new KeyRepeatController(() => now);
  const translator: XkbKeyTranslator = {
    keysymForKeycode: () => text.codePointAt(0)!,
    utf8ForKeycode: () => text,
    utf8ForKeysym: () => text,
  };
  repeat.setRepeatInfo(10, 0);
  repeat.press(30, true);

  const firstKeycode = repeat.poll();
  assertEquals(firstKeycode, 30);
  assertEquals(translateKey(firstKeycode!, "repeat", translator).text, "a");

  text = "A";
  now = 100;
  const secondKeycode = repeat.poll();
  assertEquals(secondKeycode, 30);
  assertEquals(translateKey(secondKeycode!, "repeat", translator).text, "A");
});

Deno.test("key repeat replaces repeatable keys and cancels only on matching release", () => {
  const now = 10;
  const repeat = new KeyRepeatController(() => now);
  repeat.setRepeatInfo(10, 100);
  repeat.press(20, true);
  repeat.press(21, false);
  assertEquals(repeat.activeKeycode, 20);

  repeat.release(21);
  assertEquals(repeat.activeKeycode, 20);
  repeat.press(22, true);
  assertEquals(repeat.activeKeycode, 22);
  assertEquals(repeat.nextDeadline, 110);

  repeat.release(22);
  assertEquals(repeat.activeKeycode, undefined);
  assertEquals(repeat.nextDeadline, undefined);
});

Deno.test("non-positive repeat rates disable an active repeat", () => {
  const repeat = new KeyRepeatController(() => 0);
  repeat.setRepeatInfo(30, 200);
  repeat.press(12, true);
  repeat.setRepeatInfo(0, 200);

  assertEquals(repeat.activeKeycode, undefined);
  assertEquals(repeat.poll(), undefined);
});

interface TranslatorOptions {
  keysym: number;
  keyText: string;
  text: string;
  onKeycode?: (keycode: number) => void;
  onTextLookup?: () => void;
}

function translatorFor(options: TranslatorOptions): XkbKeyTranslator {
  return {
    keysymForKeycode(keycode) {
      options.onKeycode?.(keycode);
      return options.keysym;
    },
    utf8ForKeycode() {
      options.onTextLookup?.();
      return options.text;
    },
    utf8ForKeysym() {
      return options.keyText;
    },
  };
}

class FakeCompose implements ComposeAdapter {
  feedCount = 0;
  resetCount = 0;

  constructor(
    readonly feedResult: number,
    readonly composeStatus: number,
    readonly composedText: string,
  ) {}

  feed(): number {
    this.feedCount++;
    return this.feedResult;
  }

  status(): number {
    return this.composeStatus;
  }

  utf8(): string {
    return this.composedText;
  }

  reset(): void {
    this.resetCount++;
  }
}

function keyModifiers(overrides: Partial<KeyModifiers> = {}): KeyModifiers {
  const ctrlKey = overrides.ctrlKey ?? false;
  const altGraphKey = overrides.altGraphKey ?? false;
  return {
    shiftKey: false,
    ctrlKey,
    altKey: false,
    metaKey: false,
    accelKey: ctrlKey && !altGraphKey,
    capsLock: false,
    altGraphKey,
    ...overrides,
  };
}

function assert(value: unknown, message = "Expected value to be truthy"): asserts value {
  if (!value) throw new Error(message);
}

function assertThrowsMessage(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(`Expected an error containing ${JSON.stringify(expected)}`);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (deepEquals(actual, expected)) return;
  throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
}

function deepEquals(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) {
    return false;
  }

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
