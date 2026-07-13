import { assert, assertEquals, assertFalse, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { QuoxEvent } from "./event.ts";
import type { DomDispatchEventType } from "./renderer_port.ts";
import { QuoxEventTarget } from "./event_target.ts";
import { setElementFunctionProp } from "./handlers.ts";
import { documentHasActiveDispatch, releaseStoppedRenderer } from "./internals.ts";
import type { QuoxElement } from "./node.ts";
import {
  QuoxCompositionEvent,
  QuoxDOMInputEvent,
  QuoxDOMKeyboardEvent,
  QuoxFocusEvent,
  QuoxMouseEvent,
  QuoxPointerEvent,
  QuoxWheelEvent,
} from "./ui_event.ts";

type EventSpec = {
  type: DomDispatchEventType;
  target: number;
  path: number[];
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
  timeStamp?: number;
  payload?: unknown;
};

type FramePlan = {
  events: EventSpec[];
  redrawRequested: boolean;
  resumeValue?: unknown;
};

function mousePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientX: 11.25,
    clientY: -2.5,
    pageX: 14.75,
    pageY: 4,
    screenX: 0,
    screenY: 0,
    offsetX: 1.5,
    offsetY: 2.25,
    movementX: 0,
    movementY: 0,
    button: 0,
    buttons: 1,
    detail: 2,
    shiftKey: true,
    ctrlKey: false,
    altKey: true,
    metaKey: false,
    capsLock: true,
    altGraphKey: true,
    fnKey: true,
    numLock: true,
    scrollLock: true,
    relatedTarget: null,
    ...overrides,
  };
}

function pointerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mousePayload(),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
    tangentialPressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    altitudeAngle: Math.PI / 2,
    azimuthAngle: 0,
    persistentDeviceId: 0,
    ...overrides,
  };
}

function wheelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mousePayload({ detail: 0 }),
    deltaX: 1.25,
    deltaY: -2.5,
    deltaZ: 0.125,
    deltaMode: 1,
    ...overrides,
  };
}

function keyboardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "A",
    code: "KeyA",
    location: 2,
    repeat: true,
    isComposing: false,
    keyCode: 65,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: true,
    capsLock: true,
    altGraphKey: false,
    fnKey: true,
    numLock: false,
    scrollLock: true,
    ...overrides,
  };
}

function payloadForType(type: DomDispatchEventType): Record<string, unknown> | undefined {
  switch (type) {
    case "pointermove":
    case "pointerdown":
    case "pointerup":
    case "pointercancel":
    case "pointerenter":
    case "pointerleave":
    case "pointerover":
    case "pointerout":
    case "click":
    case "auxclick":
    case "contextmenu":
      return pointerPayload();
    case "mousemove":
    case "mousedown":
    case "mouseup":
    case "mouseenter":
    case "mouseleave":
    case "mouseover":
    case "mouseout":
    case "dblclick":
      return mousePayload();
    case "wheel":
      return wheelPayload();
    case "keypress":
    case "keydown":
    case "keyup":
      return keyboardPayload();
    case "beforeinput":
    case "input":
      return { data: null, inputType: "", isComposing: false };
    case "compositionstart":
    case "compositionupdate":
    case "compositionend":
      return { data: "" };
    case "focus":
    case "blur":
    case "focusin":
    case "focusout":
      return { relatedTarget: null };
    case "scroll":
      return undefined;
  }
}

class FakeDispatchRenderer {
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  readonly #nodeKinds = new Map<number, number>();
  readonly #plans: FramePlan[] = [];
  readonly #pending = new Map<number, unknown[]>();
  readonly syntheticEventPaths = new Map<number, Uint32Array>();
  readonly #scrollOffsets = new Map<number, { left: number; top: number }>();
  #nextNodeId = 1;
  #nextFrameId = 1;
  #nextEventId = 1;
  initialValue: unknown | undefined;
  invalidatedByInnerHtml = new Uint32Array();
  nodeKindError: unknown;
  resumeError: unknown;
  abortError: unknown;
  abortRedrawRequested = false;
  documentElementHandle = 0;

  title(): string {
    return "";
  }

  create_element(_tagName: string): number {
    const id = this.#nextNodeId++;
    this.#nodeKinds.set(id, 1);
    return id;
  }

  create_text_node(_text: string): number {
    const id = this.#nextNodeId++;
    this.#nodeKinds.set(id, 3);
    return id;
  }

  document_element(): number {
    return this.documentElementHandle;
  }

  node_kind(nodeHandle: number): number {
    if (this.nodeKindError !== undefined) throw this.nodeKindError;
    const kind = this.#nodeKinds.get(nodeHandle);
    if (kind === undefined) throw new RangeError(`unknown fake node ${nodeHandle}`);
    return kind;
  }

  synthetic_event_path(nodeHandle: number): Uint32Array {
    return this.syntheticEventPaths.get(nodeHandle) ?? Uint32Array.of(nodeHandle);
  }

  set_inner_html(_nodeHandle: number, _html: string): Uint32Array {
    return this.invalidatedByInnerHtml;
  }

  element_scroll_left(nodeHandle: number): number {
    return this.#scrollOffsets.get(nodeHandle)?.left ?? 0;
  }

  element_scroll_top(nodeHandle: number): number {
    return this.#scrollOffsets.get(nodeHandle)?.top ?? 0;
  }

  set_element_scroll_left(nodeHandle: number, value: number): boolean {
    const current = this.#scrollOffsets.get(nodeHandle) ?? { left: 0, top: 0 };
    if (current.left === value) return false;
    this.#scrollOffsets.set(nodeHandle, { left: value, top: current.top });
    return true;
  }

  set_element_scroll_top(nodeHandle: number, value: number): boolean {
    const current = this.#scrollOffsets.get(nodeHandle) ?? { left: 0, top: 0 };
    if (current.top === value) return false;
    this.#scrollOffsets.set(nodeHandle, { left: current.left, top: value });
    return true;
  }

  queueFrame(events: EventSpec[], redrawRequested = false, resumeValue?: unknown): void {
    this.#plans.push({ events, redrawRequested, resumeValue });
  }

  begin_pointer_move(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_move", args);
  }

  begin_stationary_pointer_refresh(...args: unknown[]): unknown {
    return this.#begin("begin_stationary_pointer_refresh", args);
  }

  begin_pointer_cancel(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_cancel", args);
  }

  begin_pointer_enter(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_enter", args);
  }

  begin_pointer_leave(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_leave", args);
  }

  begin_pointer_down(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_down", args);
  }

  begin_pointer_up(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_up", args);
  }

  begin_wheel(...args: unknown[]): unknown {
    return this.#begin("begin_wheel", args);
  }

  begin_key_event(...args: unknown[]): unknown {
    return this.#begin("begin_key_event", args);
  }

  begin_focus(...args: unknown[]): unknown {
    return this.#begin("begin_focus", args);
  }

  begin_blur(...args: unknown[]): unknown {
    return this.#begin("begin_blur", args);
  }

  begin_apple_standard_keybinding(...args: unknown[]): unknown {
    return this.#begin("begin_apple_standard_keybinding", args);
  }

  begin_ime_enabled(...args: unknown[]): unknown {
    return this.#begin("begin_ime_enabled", args);
  }

  begin_ime_disabled(...args: unknown[]): unknown {
    return this.#begin("begin_ime_disabled", args);
  }

  begin_ime_preedit(...args: unknown[]): unknown {
    return this.#begin("begin_ime_preedit", args);
  }

  begin_ime_commit(...args: unknown[]): unknown {
    return this.#begin("begin_ime_commit", args);
  }

  begin_ime_delete_surrounding(...args: unknown[]): unknown {
    return this.#begin("begin_ime_delete_surrounding", args);
  }

  resume_dom_dispatch(frameId: number, eventId: number, defaultPrevented: boolean): unknown {
    this.calls.push(["resume", frameId, eventId, defaultPrevented]);
    if (this.resumeError !== undefined) throw this.resumeError;
    const remaining = this.#pending.get(frameId);
    if (remaining === undefined || remaining.length === 0) throw new Error("fake frame is not pending");
    const step = remaining.shift();
    if (remaining.length === 0) this.#pending.delete(frameId);
    return step;
  }

  abort_dom_dispatch(frameId: number): boolean {
    this.calls.push(["abort", frameId]);
    this.#pending.delete(frameId);
    if (this.abortError !== undefined) throw this.abortError;
    return this.abortRedrawRequested;
  }

  #begin(method: string, args: unknown[]): unknown {
    if (this.initialValue !== undefined) {
      const value = this.initialValue;
      this.initialValue = undefined;
      const frameId = Reflect.get(value as object, "frameId");
      this.calls.push([method, frameId, ...args]);
      return value;
    }

    const frameId = this.#nextFrameId++;
    this.calls.push([method, frameId, ...args]);
    const plan = this.#plans.shift() ?? { events: [], redrawRequested: false };
    const steps = plan.events.map((event) => {
      const step: Record<string, unknown> = {
        kind: "event",
        frameId,
        eventId: this.#nextEventId++,
        type: event.type,
        target: event.target,
        path: event.path,
        bubbles: event.bubbles ?? true,
        cancelable: event.cancelable ?? true,
        composed: event.composed ?? true,
        timeStamp: event.timeStamp ?? 1,
      };
      const payload = event.payload ?? payloadForType(event.type);
      if (payload !== undefined) step.payload = payload;
      return step;
    });
    steps.push(
      (plan.resumeValue ?? {
        kind: "complete",
        frameId,
        redrawRequested: plan.redrawRequested,
      }) as never,
    );
    const first = steps.shift();
    if (steps.length > 0) this.#pending.set(frameId, steps);
    return first;
  }
}

function createHarness(onDispatchIdle: () => void = () => undefined): {
  document: QuoxDocument;
  renderer: FakeDispatchRenderer;
  window: QuoxEventTarget;
  renders: string[];
  syncs: string[];
} {
  const renderer = new FakeDispatchRenderer();
  const window = new QuoxEventTarget();
  const renders: string[] = [];
  const syncs: string[] = [];
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => renders.push("render"),
    () => undefined,
    undefined,
    () => syncs.push("sync"),
    window,
    onDispatchIdle,
  );
  return { document, renderer, window, renders, syncs };
}

Deno.test("stationary pointer refresh pumps boundary listeners without scheduling itself forever", () => {
  const { document, renderer, renders, syncs } = createHarness();
  const oldTarget = document.createElement("div");
  const newTarget = document.createElement("button");
  const calls: string[] = [];

  oldTarget.addEventListener("pointerout", () => {
    calls.push("out");
    newTarget.innerHTML = "listener mutation";
  });
  newTarget.addEventListener("pointerover", () => calls.push("over"));
  renderer.queueFrame([
    {
      type: "pointerout",
      target: oldTarget.nodeId,
      path: [oldTarget.nodeId],
      payload: pointerPayload({ relatedTarget: newTarget.nodeId }),
    },
    {
      type: "pointerover",
      target: newTarget.nodeId,
      path: [newTarget.nodeId],
      payload: pointerPayload({ relatedTarget: oldTarget.nodeId }),
    },
  ], true);

  document.refreshStationaryPointer();
  assertEquals(calls, ["out", "over"]);
  assertEquals(
    renderer.calls.filter(([method]) => method === "begin_stationary_pointer_refresh").length,
    1,
  );
  // The listener mutation schedules a follow-up layout refresh. The renderer's own hover redraw
  // is consumed by the render already in progress and does not add a second request.
  assertEquals(renders, ["render"]);
  assertEquals(syncs, ["sync"]);

  // The next pre-render refresh has no transition and requests no redraw. In particular, the
  // refresh completion does not recursively begin another frame.
  document.refreshStationaryPointer();
  assertEquals(
    renderer.calls.filter(([method]) => method === "begin_stationary_pointer_refresh").length,
    2,
  );
  assertEquals(renders, ["render"]);
  assertEquals(syncs, ["sync", "sync"]);
});

Deno.test("element focus and blur pump browser focus events through staged dispatch", () => {
  const { document, renderer, renders, syncs } = createHarness();
  const old = document.createElement("input");
  const next = document.createElement("button");
  const calls: string[] = [];

  old.addEventListener("blur", (event) => {
    calls.push("blur");
    assert(event instanceof QuoxFocusEvent);
    assertStrictEquals(event.relatedTarget, next);
  });
  old.addEventListener("focusout", (event) => {
    calls.push("focusout");
    assertStrictEquals((event as QuoxFocusEvent).relatedTarget, next);
  });
  next.addEventListener("focus", (event) => {
    calls.push("focus");
    assertStrictEquals((event as QuoxFocusEvent).relatedTarget, old);
  });
  next.addEventListener("focusin", (event) => {
    calls.push("focusin");
    assertStrictEquals((event as QuoxFocusEvent).relatedTarget, old);
  });

  renderer.queueFrame([
    {
      type: "blur",
      target: old.nodeId,
      path: [old.nodeId],
      bubbles: false,
      cancelable: false,
      payload: { relatedTarget: next.nodeId },
    },
    {
      type: "focusout",
      target: old.nodeId,
      path: [old.nodeId],
      cancelable: false,
      payload: { relatedTarget: next.nodeId },
    },
    {
      type: "focus",
      target: next.nodeId,
      path: [next.nodeId],
      bubbles: false,
      cancelable: false,
      payload: { relatedTarget: old.nodeId },
    },
    {
      type: "focusin",
      target: next.nodeId,
      path: [next.nodeId],
      cancelable: false,
      payload: { relatedTarget: old.nodeId },
    },
  ], true);
  next.focus();

  assertEquals(calls, ["blur", "focusout", "focus", "focusin"]);
  assertEquals(
    renderer.calls.find(([method]) => method === "begin_focus")?.slice(2),
    [next.nodeId],
  );
  assertEquals(renders, ["render"]);
  assertEquals(syncs, ["sync"]);

  calls.length = 0;
  renderer.queueFrame([
    {
      type: "blur",
      target: next.nodeId,
      path: [next.nodeId],
      bubbles: false,
      cancelable: false,
      payload: { relatedTarget: null },
    },
    {
      type: "focusout",
      target: next.nodeId,
      path: [next.nodeId],
      cancelable: false,
      payload: { relatedTarget: null },
    },
  ]);
  next.blur();
  assertEquals(
    renderer.calls.find(([method]) => method === "begin_blur")?.slice(2),
    [next.nodeId],
  );
  assertEquals(syncs, ["sync", "sync"]);
});

Deno.test("focus methods may open nested frames from a loss listener", () => {
  const order: string[] = [];
  const renderer = new FakeDispatchRenderer();
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => undefined,
    undefined,
    () => order.push("sync"),
  );
  const old = document.createElement("button");
  const outer = document.createElement("button");
  const inner = document.createElement("input");

  renderer.queueFrame([
    {
      type: "blur",
      target: old.nodeId,
      path: [old.nodeId],
      bubbles: false,
      cancelable: false,
      payload: { relatedTarget: outer.nodeId },
    },
    {
      type: "focusout",
      target: old.nodeId,
      path: [old.nodeId],
      cancelable: false,
      payload: { relatedTarget: outer.nodeId },
    },
  ]);
  renderer.queueFrame([
    {
      type: "focus",
      target: inner.nodeId,
      path: [inner.nodeId],
      bubbles: false,
      cancelable: false,
      payload: { relatedTarget: null },
    },
    {
      type: "focusin",
      target: inner.nodeId,
      path: [inner.nodeId],
      cancelable: false,
      payload: { relatedTarget: null },
    },
  ]);
  old.addEventListener("blur", () => {
    order.push("outer blur before");
    inner.focus();
    order.push("outer blur after");
  });
  old.addEventListener("focusout", () => order.push("outer focusout"));
  inner.addEventListener("focus", () => order.push("inner focus"));
  inner.addEventListener("focusin", () => order.push("inner focusin"));

  outer.focus();
  assertEquals(order, [
    "outer blur before",
    "inner focus",
    "inner focusin",
    "sync",
    "outer blur after",
    "outer focusout",
    "sync",
  ]);
  assertEquals(
    renderer.calls.filter(([method]) => method === "begin_focus").map((call) => call.slice(2)),
    [[outer.nodeId], [inner.nodeId]],
  );
});

Deno.test("trusted staged events preserve multiplicity and capture, target, bubble order", () => {
  const { document, renderer, window } = createHarness();
  const root = document.createElement("main");
  const parent = document.createElement("button");
  const calls: string[] = [];
  let firstEvent: unknown;

  window.addEventListener("click", () => calls.push("window capture"), true);
  document.addEventListener("click", () => calls.push("document capture"), true);
  root.addEventListener("click", () => calls.push("root capture"), true);
  parent.addEventListener("click", () => calls.push("parent capture"), true);
  parent.addEventListener("click", (event) => {
    calls.push("parent target");
    firstEvent = event;
    assert(event.isTrusted);
    assertEquals(event.timeStamp, 42.5);
    assertStrictEquals(event.target, parent);
    assertEquals(event.composedPath(), [parent, root, document, window]);
  });
  root.addEventListener("click", () => calls.push("root bubble"));
  document.addEventListener("click", () => calls.push("document bubble"));
  window.addEventListener("click", () => calls.push("window bubble"));

  renderer.queueFrame([
    { type: "click", target: parent.nodeId, path: [parent.nodeId, root.nodeId], timeStamp: 42.5 },
    { type: "click", target: parent.nodeId, path: [parent.nodeId, root.nodeId], timeStamp: 42.5 },
  ]);
  document.dispatchPointerMove(1, 2, 0, 0);

  const oneDispatch = [
    "window capture",
    "document capture",
    "root capture",
    "parent capture",
    "parent target",
    "root bubble",
    "document bubble",
    "window bubble",
  ];
  assertEquals(calls, [...oneDispatch, ...oneDispatch]);
  assert(firstEvent !== undefined);
  assertEquals(
    renderer.calls.filter(([method]) => method === "resume").map((call) => call.slice(3)),
    [[false], [false]],
  );
});

Deno.test("trusted staged payloads create browser-style event subclasses with exact values", () => {
  const { document, renderer, window } = createHarness();
  const target = document.createElement("button");
  const related = document.createElement("aside");
  const events = new Map<string, QuoxEvent>();
  const eventTypes: DomDispatchEventType[] = [
    "pointermove",
    "pointercancel",
    "click",
    "auxclick",
    "contextmenu",
    "dblclick",
    "wheel",
    "keydown",
    "input",
    "change",
    "focus",
    "blur",
    "scroll",
  ];
  for (const type of eventTypes) {
    target.addEventListener(type, (event) => events.set(type, event));
  }

  renderer.queueFrame([
    {
      type: "pointermove",
      target: target.nodeId,
      path: [target.nodeId],
      payload: pointerPayload({ movementX: 2.25, movementY: -3.75 }),
    },
    {
      type: "pointercancel",
      target: target.nodeId,
      path: [target.nodeId],
      cancelable: false,
      payload: pointerPayload({ button: -1, buttons: 0, detail: 0, pressure: 0 }),
    },
    {
      type: "click",
      target: target.nodeId,
      path: [target.nodeId],
      timeStamp: 41.5,
      payload: pointerPayload({
        relatedTarget: related.nodeId,
        clientX: 123.25,
        clientY: 45.5,
        pageX: 130.75,
        pageY: 55.25,
        offsetX: 3.125,
        offsetY: 4.875,
        screenX: 0,
        screenY: 0,
        button: 0,
        buttons: 1,
        detail: 3,
        pressure: 0.75,
      }),
    },
    {
      type: "auxclick",
      target: target.nodeId,
      path: [target.nodeId],
      payload: pointerPayload({ button: 1, buttons: 0, detail: 1 }),
    },
    {
      type: "contextmenu",
      target: target.nodeId,
      path: [target.nodeId],
      payload: pointerPayload({ button: 2, buttons: 0, detail: 0 }),
    },
    {
      type: "dblclick",
      target: target.nodeId,
      path: [target.nodeId],
      payload: mousePayload({ detail: 2 }),
    },
    {
      type: "wheel",
      target: target.nodeId,
      path: [target.nodeId],
      payload: wheelPayload({ deltaX: 1.125, deltaY: -9.75, deltaZ: 0.5, deltaMode: 2 }),
    },
    {
      type: "keydown",
      target: target.nodeId,
      path: [target.nodeId],
      payload: keyboardPayload({
        key: "FutureNamedKey",
        code: "FuturePhysicalCode",
        keyCode: 0x1234,
        capsLock: true,
        altGraphKey: true,
        fnKey: true,
        numLock: true,
        scrollLock: true,
      }),
    },
    {
      type: "input",
      target: target.nodeId,
      path: [target.nodeId],
      payload: { data: "é", inputType: "insertText", isComposing: true },
    },
    {
      type: "change",
      target: target.nodeId,
      path: [target.nodeId],
      cancelable: false,
      composed: false,
    },
    {
      type: "focus",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: false,
      payload: { relatedTarget: related.nodeId },
    },
    {
      type: "blur",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: false,
      payload: { relatedTarget: null },
    },
    { type: "scroll", target: target.nodeId, path: [target.nodeId] },
  ]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(events.get("scroll"), undefined);
  document.flushPendingScrollEvents();

  const pointerMove = events.get("pointermove");
  assert(pointerMove instanceof QuoxPointerEvent);
  assertEquals([pointerMove.movementX, pointerMove.movementY], [2.25, -3.75]);

  const pointerCancel = events.get("pointercancel");
  assert(pointerCancel instanceof QuoxPointerEvent);
  assertFalse(pointerCancel.cancelable);
  assertEquals([pointerCancel.button, pointerCancel.buttons, pointerCancel.pressure], [-1, 0, 0]);

  const click = events.get("click");
  assert(click instanceof QuoxPointerEvent);
  assert(click instanceof QuoxMouseEvent);
  assertStrictEquals(click.view, window);
  assertEquals(click.timeStamp, 41.5);
  assertEquals(
    {
      clientX: click.clientX,
      clientY: click.clientY,
      pageX: click.pageX,
      pageY: click.pageY,
      offsetX: click.offsetX,
      offsetY: click.offsetY,
      screenX: click.screenX,
      screenY: click.screenY,
      movementX: click.movementX,
      movementY: click.movementY,
      button: click.button,
      buttons: click.buttons,
      detail: click.detail,
      pressure: click.pressure,
    },
    {
      clientX: 123.25,
      clientY: 45.5,
      pageX: 130.75,
      pageY: 55.25,
      offsetX: 3.125,
      offsetY: 4.875,
      screenX: 0,
      screenY: 0,
      movementX: 0,
      movementY: 0,
      button: 0,
      buttons: 1,
      detail: 3,
      pressure: 0.75,
    },
  );
  assert(click.shiftKey);
  assert(click.altKey);
  assert(click.getModifierState("CapsLock"));
  assert(click.getModifierState("AltGraph"));
  assert(click.getModifierState("Fn"));
  assert(click.getModifierState("NumLock"));
  assert(click.getModifierState("ScrollLock"));
  assertStrictEquals(click.relatedTarget, related);
  const auxClick = events.get("auxclick");
  assert(auxClick instanceof QuoxPointerEvent);
  assertEquals([auxClick.button, auxClick.buttons, auxClick.detail], [1, 0, 1]);
  assert(events.get("contextmenu") instanceof QuoxPointerEvent);
  assert(events.get("dblclick") instanceof QuoxMouseEvent);
  assert(!(events.get("dblclick") instanceof QuoxPointerEvent));

  const wheel = events.get("wheel");
  assert(wheel instanceof QuoxWheelEvent);
  assertEquals(
    [wheel.deltaX, wheel.deltaY, wheel.deltaZ, wheel.deltaMode],
    [1.125, -9.75, 0.5, QuoxWheelEvent.DOM_DELTA_PAGE],
  );
  assert(wheel.getModifierState("Fn"));
  assert(wheel.getModifierState("ScrollLock"));

  const key = events.get("keydown");
  assert(key instanceof QuoxDOMKeyboardEvent);
  assertEquals(
    [key.key, key.code, key.keyCode, key.which, key.location, key.repeat, key.isComposing],
    ["FutureNamedKey", "FuturePhysicalCode", 0x1234, 0x1234, 2, true, false],
  );
  assert(key.getModifierState("CapsLock"));
  assert(key.getModifierState("AltGraph"));
  assert(key.getModifierState("Fn"));
  assert(key.getModifierState("NumLock"));
  assert(key.getModifierState("ScrollLock"));

  const input = events.get("input");
  assert(input instanceof QuoxDOMInputEvent);
  assertEquals([input.data, input.inputType, input.isComposing], ["é", "insertText", true]);

  const change = events.get("change");
  assert(change instanceof QuoxEvent);
  assert(!(change instanceof QuoxDOMInputEvent));
  assert(change.bubbles);
  assertFalse(change.cancelable);
  assertFalse(change.composed);

  const focus = events.get("focus");
  assert(focus instanceof QuoxFocusEvent);
  assertStrictEquals(focus.relatedTarget, related);
  const blur = events.get("blur");
  assert(blur instanceof QuoxFocusEvent);
  assertStrictEquals(blur.relatedTarget, null);

  const scroll = events.get("scroll");
  assert(scroll instanceof QuoxEvent);
  assert(!(scroll instanceof QuoxFocusEvent));
  assert(!(scroll instanceof QuoxMouseEvent));
});

Deno.test("trusted beforeinput and composition steps preserve browser payloads and flags", () => {
  const { document, renderer, window } = createHarness();
  const target = document.createElement("input");
  const events: QuoxEvent[] = [];

  for (
    const type of [
      "beforeinput",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ] as const
  ) {
    target.addEventListener(type, (event) => {
      events.push(event);
      if (type === "beforeinput") event.preventDefault();
    });
  }

  renderer.queueFrame([
    {
      type: "beforeinput",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: true,
      composed: true,
      payload: { data: "é", inputType: "insertCompositionText", isComposing: true },
    },
    {
      type: "compositionstart",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: false,
      composed: true,
      payload: { data: "" },
    },
    {
      type: "compositionupdate",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: false,
      composed: true,
      payload: { data: "é" },
    },
    {
      type: "compositionend",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: false,
      composed: true,
      payload: { data: "é" },
    },
  ]);

  document.dispatchPointerMove(1, 2, 0, 0);

  assertEquals(events.map((event) => event.type), [
    "beforeinput",
    "compositionstart",
    "compositionupdate",
    "compositionend",
  ]);
  const beforeInput = events[0];
  assert(beforeInput instanceof QuoxDOMInputEvent);
  assertStrictEquals(beforeInput.view, window);
  assertEquals(
    [
      beforeInput.data,
      beforeInput.inputType,
      beforeInput.isComposing,
      beforeInput.dataTransfer,
      beforeInput.getTargetRanges(),
    ],
    ["é", "insertCompositionText", true, null, []],
  );
  assert(beforeInput.bubbles);
  assert(beforeInput.cancelable);
  assert(beforeInput.composed);
  assert(beforeInput.defaultPrevented);

  for (const [event, data] of events.slice(1).map((event, index) => [event, ["", "é", "é"][index]] as const)) {
    assert(event instanceof QuoxCompositionEvent);
    assertStrictEquals(event.view, window);
    assertEquals(event.data, data);
    assert(event.bubbles);
    assertFalse(event.cancelable);
    assert(event.composed);
    assert(event.isTrusted);
  }
  assertEquals(
    renderer.calls.filter(([method]) => method === "resume").map((call) => call[3]),
    [true, false, false, false],
  );
});

Deno.test("trusted text edits deliver beforeinput before input with matching details", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("input");
  const observed: Array<[string, string | null, string, boolean, boolean]> = [];

  for (const type of ["beforeinput", "input"] as const) {
    target.addEventListener(type, (event) => {
      assert(event instanceof QuoxDOMInputEvent);
      observed.push([
        event.type,
        event.data,
        event.inputType,
        event.cancelable,
        event.composed,
      ]);
    });
  }

  const payload = { data: "x", inputType: "insertText", isComposing: false };
  renderer.queueFrame([
    {
      type: "beforeinput",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: true,
      composed: true,
      payload,
    },
    {
      type: "input",
      target: target.nodeId,
      path: [target.nodeId],
      bubbles: true,
      cancelable: false,
      composed: true,
      payload,
    },
  ]);

  document.dispatchPointerMove(1, 2, 0, 0);

  assertEquals(observed, [
    ["beforeinput", "x", "insertText", true, true],
    ["input", "x", "insertText", false, true],
  ]);
  assertEquals(
    renderer.calls.filter(([method]) => method === "resume").map((call) => call[3]),
    [false, false],
  );
});

Deno.test("native boundary frames preserve DOM order, target, and null related targets", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("div");
  const observed: Array<[string, unknown, unknown]> = [];
  const types = [
    "pointerover",
    "mouseover",
    "pointerenter",
    "mouseenter",
    "pointerout",
    "mouseout",
    "pointerleave",
    "mouseleave",
  ] as const;
  for (const type of types) {
    target.addEventListener(type, (event) => {
      observed.push([type, event.target, (event as QuoxMouseEvent).relatedTarget]);
    });
  }
  const boundary = (type: typeof types[number]) => ({
    type,
    target: target.nodeId,
    path: [target.nodeId],
    bubbles: !type.endsWith("enter") && !type.endsWith("leave"),
    payload: type.startsWith("pointer")
      ? pointerPayload({ button: -1, buttons: 1, detail: 0, relatedTarget: null })
      : mousePayload({ button: 0, buttons: 1, detail: 0, relatedTarget: null }),
  });

  renderer.queueFrame(types.slice(0, 4).map(boundary));
  document.dispatchPointerEnter(1, 2, 1, 0, 10);
  renderer.queueFrame(types.slice(4).map(boundary));
  document.dispatchPointerLeave(1, 2, 1, 0, 11);

  assertEquals(observed.map(([type]) => type), [...types]);
  for (const [, eventTarget, relatedTarget] of observed) {
    assertStrictEquals(eventTarget, target);
    assertStrictEquals(relatedTarget, null);
  }
});

Deno.test("scroll events wait for rendering, coalesce targets, and use browser paths", () => {
  const { document, renderer, window, renders } = createHarness();
  const root = document.createElement("main");
  const outer = document.createElement("section");
  const inner = document.createElement("div");
  renderer.documentElementHandle = root.nodeId;
  renderer.syntheticEventPaths.set(inner.nodeId, Uint32Array.of(inner.nodeId, outer.nodeId, root.nodeId, 0));
  renderer.syntheticEventPaths.set(outer.nodeId, Uint32Array.of(outer.nodeId, root.nodeId, 0));

  const name = (target: unknown): string =>
    target === inner ? "inner" : target === outer ? "outer" : target === document ? "document" : "unexpected";
  const calls: string[] = [];
  const record = (label: string) => (event: QuoxEvent) => {
    assert(event.isTrusted);
    assertFalse(event.cancelable);
    assertFalse(event.composed);
    calls.push(`${label}:${name(event.target)}`);
  };

  window.addEventListener("scroll", record("window capture"), true);
  window.addEventListener("scroll", record("window bubble"));
  document.addEventListener("scroll", record("document capture"), true);
  document.addEventListener("scroll", record("document bubble"));
  root.addEventListener("scroll", record("root capture"), true);
  root.addEventListener("scroll", record("root bubble"));
  outer.addEventListener("scroll", record("outer capture"), true);
  outer.addEventListener("scroll", record("outer bubble"));
  inner.addEventListener("scroll", record("inner target"));

  renderer.queueFrame([
    { type: "scroll", target: inner.nodeId, path: [inner.nodeId, outer.nodeId, root.nodeId] },
    { type: "scroll", target: outer.nodeId, path: [outer.nodeId, root.nodeId] },
    { type: "scroll", target: inner.nodeId, path: [inner.nodeId, outer.nodeId, root.nodeId] },
    { type: "scroll", target: root.nodeId, path: [root.nodeId] },
  ], true);
  document.dispatchPointerMove(1, 2, 0, 0);

  assertEquals(calls, []);
  assertEquals(renders, ["render"]);
  document.flushPendingScrollEvents();
  assertEquals(calls, [
    "window capture:inner",
    "document capture:inner",
    "root capture:inner",
    "outer capture:inner",
    "inner target:inner",
    "window capture:outer",
    "document capture:outer",
    "root capture:outer",
    "outer capture:outer",
    "outer bubble:outer",
    "window capture:document",
    "document capture:document",
    "document bubble:document",
    "window bubble:document",
  ]);

  calls.length = 0;
  inner.addEventListener("scroll", () => {
    renderer.queueFrame([
      { type: "scroll", target: outer.nodeId, path: [outer.nodeId, root.nodeId] },
      { type: "scroll", target: inner.nodeId, path: [inner.nodeId, outer.nodeId, root.nodeId] },
    ]);
    document.dispatchPointerMove(3, 4, 0, 0);
  }, { once: true });
  renderer.queueFrame([
    { type: "scroll", target: inner.nodeId, path: [inner.nodeId, outer.nodeId, root.nodeId] },
  ]);
  document.dispatchPointerMove(1, 2, 0, 0);
  document.flushPendingScrollEvents();
  assertEquals(calls, [
    "window capture:inner",
    "document capture:inner",
    "root capture:inner",
    "outer capture:inner",
    "inner target:inner",
    "window capture:outer",
    "document capture:outer",
    "root capture:outer",
    "outer capture:outer",
    "outer bubble:outer",
  ]);

  calls.length = 0;
  document.flushPendingScrollEvents();
  assertEquals(calls, []);
});

Deno.test("CSSOM scroll setters queue changed element and document targets", () => {
  const { document, renderer, window, renders } = createHarness();
  const root = document.createElement("main");
  const scroller = document.createElement("section");
  renderer.documentElementHandle = root.nodeId;
  renderer.syntheticEventPaths.set(scroller.nodeId, Uint32Array.of(scroller.nodeId, root.nodeId, 0));
  const calls: string[] = [];

  scroller.addEventListener("scroll", () => calls.push("element"));
  root.addEventListener("scroll", () => calls.push("root"));
  document.addEventListener("scroll", (event) => {
    if (event.target === document) calls.push("document");
  });
  window.addEventListener("scroll", () => calls.push("window"));

  scroller.scrollTop = 12;
  scroller.scrollLeft = 8;
  scroller.scrollTop = 12;
  assertEquals([scroller.scrollLeft, scroller.scrollTop], [8, 12]);
  assertEquals(renders, ["render"], "one pending target needs one rendering opportunity");
  assertEquals(calls, []);

  document.flushPendingScrollEvents();
  assertEquals(calls, ["element"]);

  root.scrollTop = 20;
  root.scrollLeft = 4;
  assertEquals(renders, ["render", "render"]);
  document.flushPendingScrollEvents();
  assertEquals(calls, ["element", "document", "window"]);
});

Deno.test("scroll flushing stops cleanly when a listener deactivates the document", () => {
  const renderer = new FakeDispatchRenderer();
  const window = new QuoxEventTarget();
  let active = true;
  let idleCount = 0;
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => {
      if (!active) throw new Error("window is not active");
    },
    undefined,
    undefined,
    window,
    () => idleCount++,
    () => active,
  );
  const first = document.createElement("div");
  const second = document.createElement("div");
  renderer.syntheticEventPaths.set(first.nodeId, Uint32Array.of(first.nodeId, 0));
  renderer.syntheticEventPaths.set(second.nodeId, Uint32Array.of(second.nodeId, 0));
  const calls: string[] = [];
  first.addEventListener("scroll", () => {
    calls.push("first");
    assert(documentHasActiveDispatch(document));
    active = false;
  });
  second.addEventListener("scroll", () => calls.push("second"));
  renderer.queueFrame([
    { type: "scroll", target: first.nodeId, path: [first.nodeId] },
    { type: "scroll", target: second.nodeId, path: [second.nodeId] },
  ]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(idleCount, 1);
  document.flushPendingScrollEvents();
  assertEquals(calls, ["first"]);
  assertEquals(idleCount, 2);
  assertFalse(documentHasActiveDispatch(document));
});

Deno.test("pointer detail stays within the signed DOM UIEvent range", () => {
  const { document, renderer } = createHarness();

  document.dispatchPointerDown(1, 2, 0, 1, 0, 3, 0x7fff_ffff);
  document.dispatchPointerUp(1, 2, 0, 0, 0, 4, 0x7fff_ffff);
  assertEquals(
    renderer.calls.filter(([method]) => method === "begin_pointer_down" || method === "begin_pointer_up").map((call) =>
      call.at(-1)
    ),
    [0x7fff_ffff, 0x7fff_ffff],
  );

  assertThrows(
    () => document.dispatchPointerDown(1, 2, 0, 1, 0, 5, 0x8000_0000),
    RangeError,
  );
  assertThrows(
    () => document.dispatchPointerUp(1, 2, 0, 0, 0, 6, 0x8000_0000),
    RangeError,
  );
});

Deno.test("native pointer entry points preserve screen-coordinate availability", () => {
  const { document, renderer } = createHarness();

  document.dispatchPointerMove(1, 2, 0, 0x1ff, 3, 101.5, 202.25);
  document.dispatchPointerCancel(1, 2, 5, 0x1ff, 3.125, 101.5, 202.25);
  document.dispatchPointerEnter(1, 2, 5, 0x1ff, 3.25, 101.5, 202.25);
  document.dispatchPointerLeave(-1, 2, 5, 0x1ff, 3.5);
  document.dispatchPointerDown(1, 2, 0, 1, 0, 4, 1);
  document.dispatchWheel(1, 2, 3, 4, 0, 0, -3, -4, 0, 5, 101.5, 202.25);

  assertEquals(
    renderer.calls.map(([method, _frame, ...args]) => [method, ...args]),
    [
      ["begin_pointer_move", 1, 2, true, 101.5, 202.25, 0, 0x1ff, 3],
      ["begin_pointer_cancel", 1, 2, true, 101.5, 202.25, 5, 0x1ff, 3.125],
      ["begin_pointer_enter", 1, 2, true, 101.5, 202.25, 5, 0x1ff, 3.25],
      ["begin_pointer_leave", -1, 2, false, 0, 0, 5, 0x1ff, 3.5],
      ["begin_pointer_down", 1, 2, false, 0, 0, 0, 1, 0, 4, 1],
      ["begin_wheel", 1, 2, true, 101.5, 202.25, 3, 4, -3, -4, 0, 0, 0, 5],
    ],
  );

  assertThrows(
    () => document.dispatchPointerMove(1, 2, 0, 0, 6, null, 202.25),
    TypeError,
  );
  assertThrows(
    () => document.dispatchPointerMove(1, 2, 0, 0, 6, Number.NaN, 202.25),
    RangeError,
  );
  assertThrows(
    () => document.dispatchPointerCancel(1, 2, 0x20, 0, 6),
    RangeError,
  );
  assertThrows(
    () => document.dispatchPointerEnter(1, 2, 0, 0, 6, null, 202.25),
    TypeError,
  );
  assertThrows(
    () => document.dispatchPointerLeave(1, 2, 0, 0x200, 6),
    RangeError,
  );
});

Deno.test("trusted focus relatedTarget is resolved before listener mutation invalidates its handle", () => {
  const { document, renderer } = createHarness();
  const container = document.createElement("main");
  const target = document.createElement("input");
  const related = document.createElement("button");
  renderer.invalidatedByInnerHtml = new Uint32Array([related.nodeId]);
  let observed: unknown;

  target.addEventListener("focus", (event) => {
    container.innerHTML = "replacement";
    observed = (event as QuoxFocusEvent).relatedTarget;
  });
  renderer.queueFrame([{
    type: "focus",
    target: target.nodeId,
    path: [target.nodeId, container.nodeId],
    bubbles: false,
    payload: { relatedTarget: related.nodeId },
  }]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertStrictEquals(observed, related);
});

Deno.test("nonbubbling trusted events still capture through window and document", () => {
  const { document, renderer, window } = createHarness();
  const parent = document.createElement("section");
  const target = document.createElement("input");
  const calls: string[] = [];

  window.addEventListener("focus", () => calls.push("window capture"), true);
  document.addEventListener("focus", () => calls.push("document capture"), true);
  parent.addEventListener("focus", () => calls.push("parent capture"), true);
  target.addEventListener("focus", () => calls.push("target"));
  parent.addEventListener("focus", () => calls.push("parent bubble"));
  document.addEventListener("focus", () => calls.push("document bubble"));
  renderer.queueFrame([{
    type: "focus",
    target: target.nodeId,
    path: [target.nodeId, parent.nodeId],
    bubbles: false,
  }]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(calls, ["window capture", "document capture", "parent capture", "target"]);
});

Deno.test("synthetic node events capture and bubble through DOM ancestors", () => {
  const { document, renderer, window } = createHarness();
  const parent = document.createElement("section");
  const target = document.createElement("button");
  renderer.syntheticEventPaths.set(
    target.nodeId,
    Uint32Array.of(target.nodeId, parent.nodeId, 0),
  );
  const calls: string[] = [];

  window.addEventListener("custom", () => calls.push("window capture"), true);
  document.addEventListener("custom", () => calls.push("document capture"), true);
  parent.addEventListener("custom", () => calls.push("parent capture"), true);
  target.addEventListener("custom", (event) => {
    calls.push("target");
    assertFalse(event.isTrusted);
    assertEquals(event.composedPath(), [target, parent, document, window]);
  });
  parent.addEventListener("custom", () => calls.push("parent bubble"));
  document.addEventListener("custom", () => calls.push("document bubble"));
  window.addEventListener("custom", () => calls.push("window bubble"));

  assert(target.dispatchEvent(new QuoxEvent("custom", { bubbles: true })));
  assertEquals(calls, [
    "window capture",
    "document capture",
    "parent capture",
    "target",
    "parent bubble",
    "document bubble",
    "window bubble",
  ]);

  let documentLoads = 0;
  let windowLoads = 0;
  document.addEventListener("load", () => documentLoads++);
  window.addEventListener("load", () => windowLoads++);
  assert(target.dispatchEvent(new QuoxEvent("load", { bubbles: true })));
  assertEquals(documentLoads, 1);
  assertEquals(windowLoads, 0);

  renderer.syntheticEventPaths.set(
    target.nodeId,
    Uint32Array.of(target.nodeId, parent.nodeId, parent.nodeId, 0),
  );
  assertThrows(
    () => target.dispatchEvent(new QuoxEvent("malformed", { bubbles: true })),
    TypeError,
  );
});

Deno.test("JSX handlers occupy one stable listener slot and feed preventDefault back before resume", () => {
  const { document, renderer } = createHarness();
  const element = document.createElement("button");
  const calls: string[] = [];
  let handlerThis: unknown;

  element.addEventListener("click", () => calls.push("before"));
  setElementFunctionProp(element, "onClick", () => calls.push("old"));
  element.addEventListener("click", () => calls.push("after"));
  setElementFunctionProp(element, "onClick", function (this: QuoxElement, value: unknown) {
    const event = value as QuoxEvent;
    calls.push("current");
    handlerThis = this;
    assertStrictEquals(event.target, element);
    event.preventDefault();
    return false;
  });

  renderer.queueFrame([{
    type: "click",
    target: element.nodeId,
    path: [element.nodeId],
    cancelable: true,
  }]);
  document.dispatchPointerMove(1, 2, 0, 0);

  assertEquals(calls, ["before", "current", "after"]);
  assertStrictEquals(handlerThis, element);
  assertEquals(renderer.calls.find(([method]) => method === "resume")?.slice(3), [true]);
});

Deno.test("a false JSX listener return does not cancel the renderer default", () => {
  const { document, renderer } = createHarness();
  const element = document.createElement("button");
  setElementFunctionProp(element, "onClick", () => false);
  renderer.queueFrame([{
    type: "click",
    target: element.nodeId,
    path: [element.nodeId],
    cancelable: true,
  }]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(renderer.calls.find(([method]) => method === "resume")?.slice(3), [false]);
});

Deno.test("listener exceptions are reported while later listeners and renderer defaults continue", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("button");
  const calls: string[] = [];
  const listenerError = new Error("listener failed");
  const reported: unknown[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "reportError");
  Object.defineProperty(globalThis, "reportError", {
    configurable: true,
    value: (error: unknown) => reported.push(error),
  });
  try {
    target.addEventListener("click", () => {
      calls.push("throws");
      throw listenerError;
    });
    target.addEventListener("click", () => calls.push("continues"));
    renderer.queueFrame([{ type: "click", target: target.nodeId, path: [target.nodeId] }]);

    document.dispatchPointerMove(1, 2, 0, 0);
  } finally {
    if (previous === undefined) delete (globalThis as { reportError?: unknown }).reportError;
    else Object.defineProperty(globalThis, "reportError", previous);
  }

  assertEquals(calls, ["throws", "continues"]);
  assertEquals(reported, [listenerError]);
  assertEquals(renderer.calls.find(([method]) => method === "resume")?.slice(3), [false]);
});

Deno.test("nested frames finish and synchronize IME before the outer listener resumes", () => {
  const order: string[] = [];
  const renderer = new FakeDispatchRenderer();
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => order.push("redraw"),
    () => undefined,
    undefined,
    () => order.push("sync"),
  );
  const outer = document.createElement("button");
  const inner = document.createElement("input");
  renderer.queueFrame([{ type: "click", target: outer.nodeId, path: [outer.nodeId] }]);
  renderer.queueFrame([{ type: "input", target: inner.nodeId, path: [inner.nodeId] }]);
  inner.addEventListener("input", () => order.push("inner"));
  outer.addEventListener("click", () => {
    order.push("outer before");
    document.dispatchPointerMove(3, 4, 0, 0);
    order.push("outer after");
  });

  document.dispatchPointerMove(1, 2, 0, 0);

  assertEquals(order, ["outer before", "inner", "sync", "outer after", "sync"]);
  assertEquals(
    renderer.calls.map(([method, frame]) => [method, frame]),
    [
      ["begin_pointer_move", 1],
      ["begin_pointer_move", 2],
      ["resume", 2],
      ["resume", 1],
    ],
  );
});

Deno.test("a listener mutation cannot replace wrappers on the frozen propagation path", () => {
  const { document, renderer } = createHarness();
  const root = document.createElement("main");
  const parent = document.createElement("section");
  const target = document.createElement("button");
  renderer.invalidatedByInnerHtml = new Uint32Array([parent.nodeId]);
  let bubbledCurrentTarget: unknown;

  target.addEventListener("click", () => {
    root.innerHTML = "replacement";
  });
  parent.addEventListener("click", (event) => {
    bubbledCurrentTarget = event.currentTarget;
  });
  renderer.queueFrame([{
    type: "click",
    target: target.nodeId,
    path: [target.nodeId, parent.nodeId, root.nodeId],
  }]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertStrictEquals(bubbledCurrentTarget, parent);
});

Deno.test("fatal bridge failures resume prevented, abort, and preserve cleanup errors", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("button");
  const pathError = new Error("path resolution failed");
  const resumeError = new Error("prevented feedback failed");
  const abortError = new Error("abort failed");
  renderer.nodeKindError = pathError;
  renderer.resumeError = resumeError;
  renderer.abortError = abortError;
  renderer.queueFrame([{ type: "click", target: target.nodeId, path: [target.nodeId] }]);

  const error = assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0), AggregateError);
  assertEquals(error.errors, [pathError, resumeError, abortError]);
  assertEquals(
    renderer.calls.filter(([method]) => method === "resume" || method === "abort").map((call) => call[0]),
    ["resume", "abort"],
  );
  assertEquals(renderer.calls.find(([method]) => method === "resume")?.slice(3), [true]);
});

Deno.test("scroll target failures resume and abort their staged frame", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("div");
  const targetError = new Error("scroll target resolution failed");
  renderer.nodeKindError = targetError;
  const unknownTarget = target.nodeId + 100;
  renderer.queueFrame([{ type: "scroll", target: unknownTarget, path: [unknownTarget] }]);

  const error = assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0));
  assertStrictEquals(error, targetError);
  assertEquals(
    renderer.calls.filter(([method]) => method === "resume" || method === "abort").map((call) => call[0]),
    ["resume", "abort"],
  );
  assertEquals(renderer.calls.find(([method]) => method === "resume")?.slice(3), [true]);
});

Deno.test("malformed initial steps abort their recoverable frame and honor abort redraw", () => {
  const { document, renderer, renders } = createHarness();
  renderer.abortRedrawRequested = true;
  renderer.initialValue = {
    kind: "event",
    frameId: 9,
    eventId: 1,
    type: "click",
    target: 1,
    path: [],
    bubbles: true,
    cancelable: true,
    composed: true,
    timeStamp: 1,
    payload: pointerPayload(),
  };

  assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0), RangeError);
  assertEquals(renderer.calls.at(-1), ["abort", 9]);
  assertEquals(renders, ["render"]);
});

Deno.test("malformed trusted payloads abort before invoking a listener", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("button");
  const payload = pointerPayload();
  let getterCalls = 0;
  let listenerCalls = 0;
  Object.defineProperty(payload, "clientX", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 11.25;
    },
  });
  target.addEventListener("click", () => listenerCalls++);
  renderer.queueFrame([{
    type: "click",
    target: target.nodeId,
    path: [target.nodeId],
    payload,
  }]);

  assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0), TypeError);
  assertEquals(getterCalls, 0);
  assertEquals(listenerCalls, 0);
  assertEquals(renderer.calls.at(-1), ["abort", 1]);
});

Deno.test("malformed resumed steps abort the known frame and preserve an abort failure", () => {
  const { document, renderer } = createHarness();
  const target = document.createElement("button");
  const abortError = new Error("abort failed");
  renderer.abortError = abortError;
  renderer.queueFrame(
    [{ type: "click", target: target.nodeId, path: [target.nodeId] }],
    false,
    { kind: "complete", frameId: 99, redrawRequested: false },
  );

  const error = assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0), AggregateError);
  assert(error.errors[0] instanceof RangeError);
  assertStrictEquals(error.errors[1], abortError);
  assertEquals(renderer.calls.at(-1), ["abort", 1]);
});

Deno.test("redraw and dispatch-idle cleanup happen only after a complete frame", () => {
  const order: string[] = [];
  const renderer = new FakeDispatchRenderer();
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => order.push("redraw"),
    () => undefined,
    undefined,
    () => order.push("sync"),
    null,
    () => order.push("idle"),
  );
  const target = document.createElement("button");
  target.addEventListener("click", () => order.push("listener"));
  renderer.queueFrame([{ type: "click", target: target.nodeId, path: [target.nodeId] }], true);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(order, ["listener", "redraw", "sync", "idle"]);
});

Deno.test("the running-window release hook leaves a healthy renderer alive", () => {
  const renderer = new FakeDispatchRenderer();
  let releases = 0;
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => undefined,
    undefined,
    undefined,
    null,
    () => {
      releaseStoppedRenderer(false, documentHasActiveDispatch(document), releases !== 0, () => releases++);
    },
  );
  renderer.queueFrame([]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(releases, 0);
});

Deno.test("a renderer stop requested by a listener releases only after resume and IME sync", () => {
  const order: string[] = [];
  const renderer = new FakeDispatchRenderer();
  let stopped = false;
  let released = false;
  const tryRelease = () => {
    if (
      releaseStoppedRenderer(stopped, documentHasActiveDispatch(document), released, () => {
        released = true;
        order.push("free");
      })
    ) released = true;
  };
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => undefined,
    undefined,
    () => order.push("sync"),
    null,
    tryRelease,
  );
  const target = document.createElement("button");
  target.addEventListener("click", () => {
    order.push("listener");
    stopped = true;
    tryRelease();
    assertEquals(released, false);
  });
  renderer.queueFrame([{ type: "click", target: target.nodeId, path: [target.nodeId] }]);

  document.dispatchPointerMove(1, 2, 0, 0);
  assertEquals(order, ["listener", "sync", "free"]);
  assertEquals(released, true);
  assertEquals(renderer.calls.findLast(([method]) => method === "resume")?.[0], "resume");
});
