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
import { CURSOR_SHAPE_MANAGER_V1_REQUESTS, WlOp } from "./ffi.ts";
import { createWaylandSurroundingTextState, TextInputV3Batch, TextInputV3SerialGate } from "./text_input.ts";
import { CompositionState, keyLocationForCode, normalizeImeCursorArea, validateImeCursorRange } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";
import { emitWaylandTextInputEdits } from "./text_input_controller.ts";
import type { WaylandWindow } from "./window.ts";
import {
  createDefaultCursorPixels,
  decodeWlArrayU32,
  DEFAULT_CURSOR_HEIGHT,
  DEFAULT_CURSOR_HOTSPOT_X,
  DEFAULT_CURSOR_HOTSPOT_Y,
  DEFAULT_CURSOR_WIDTH,
  hasFatalPollEvent,
  pointerCapabilityAction,
  POLLERR,
  POLLHUP,
  POLLIN,
  POLLNVAL,
  readWlArrayU32,
  waylandConnectionError,
} from "./protocol.ts";
import { createOpaqueBlackFrame } from "./shm_buffer.ts";
import { damageOpcodeForSurfaceVersion, frameMatchesConfiguration, WaylandConfigureState } from "./window.ts";
import { type WaylandGlobalInterface, WaylandGlobalRegistry } from "./global_registry.ts";
import {
  WaylandPointerAxis,
  WaylandPointerAxisSource,
  WaylandPointerFrameAccumulator,
  WaylandPointerPosition,
} from "./pointer.ts";
import type { KeyModifiers } from "../types.ts";

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
  const registry = new WaylandGlobalRegistry<number>(
    (offer) => {
      active.set(offer.interface, offer.name);
      return offer.name;
    },
    (global) => active.delete(global.interface),
  );

  registry.announce({ name: 12, interface: "wl_compositor", offeredVersion: 4 });
  registry.announce({ name: 13, interface: "wl_shm", offeredVersion: 1 });
  registry.announce({ name: 14, interface: "wl_compositor", offeredVersion: 4 });
  assertEquals([...active.entries()], [["wl_compositor", 12], ["wl_shm", 13]]);

  registry.remove(12);
  assertEquals(registry.active("wl_compositor")?.name, 14);
  assertEquals(active.get("wl_compositor"), 14);
});

Deno.test("cursor-shape manager metadata includes the version-1 tablet request", () => {
  assertEquals(CURSOR_SHAPE_MANAGER_V1_REQUESTS, [
    { name: "destroy", signature: "", objectTypes: [] },
    { name: "get_pointer", signature: "no", objectTypes: ["cursorShapeDevice", "wlPointer"] },
    { name: "get_tablet_tool_v2", signature: "no", objectTypes: ["cursorShapeDevice", "tabletToolV2"] },
  ]);
  assertEquals(WlOp.WP_CURSOR_SHAPE_MANAGER_GET_TABLET_TOOL_V2, 2);
});

Deno.test("Wayland core cursor fallback has a visible in-bounds hotspot", () => {
  const pixels = createDefaultCursorPixels();
  assertEquals(pixels.byteLength, DEFAULT_CURSOR_WIDTH * DEFAULT_CURSOR_HEIGHT * 4);
  assert(DEFAULT_CURSOR_HOTSPOT_X >= 0 && DEFAULT_CURSOR_HOTSPOT_X < DEFAULT_CURSOR_WIDTH);
  assert(DEFAULT_CURSOR_HOTSPOT_Y >= 0 && DEFAULT_CURSOR_HOTSPOT_Y < DEFAULT_CURSOR_HEIGHT);
  const hotspot = (DEFAULT_CURSOR_HOTSPOT_Y * DEFAULT_CURSOR_WIDTH + DEFAULT_CURSOR_HOTSPOT_X) * 4;
  assertEquals([...pixels.slice(hotspot, hotspot + 4)], [0, 0, 0, 255]);
});

Deno.test("Wayland surface damage uses only requests supported by the bound version", () => {
  assertEquals(damageOpcodeForSurfaceVersion(1), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(3), WlOp.SURFACE_DAMAGE);
  assertEquals(damageOpcodeForSurfaceVersion(4), WlOp.SURFACE_DAMAGE_BUFFER);
  assertEquals(damageOpcodeForSurfaceVersion(6), WlOp.SURFACE_DAMAGE_BUFFER);
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

Deno.test("Wayland poll errors and disconnects are terminal readiness", () => {
  assertEquals(hasFatalPollEvent(POLLIN), false);
  assertEquals(hasFatalPollEvent(POLLERR), true);
  assertEquals(hasFatalPollEvent(POLLHUP), true);
  assertEquals(hasFatalPollEvent(POLLNVAL), true);
  assertEquals(hasFatalPollEvent(POLLIN | POLLHUP), true);
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
    suspended: false,
    frameToken: 1,
  });

  state.stageToplevel(0, 900, false);
  assertEquals(state.complete(1).configuration, {
    serial: 1,
    width: 1200,
    height: 900,
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
