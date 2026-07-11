import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import type { QuoxEvent } from "./event.ts";
import type { DomDispatchEventType } from "./renderer_port.ts";
import { QuoxEventTarget } from "./event_target.ts";
import { setElementFunctionProp } from "./handlers.ts";
import { documentHasActiveDispatch, releaseStoppedRenderer } from "./internals.ts";
import type { QuoxElement } from "./node.ts";

type EventSpec = {
  type: DomDispatchEventType;
  target: number;
  path: number[];
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
  timeStamp?: number;
};

type FramePlan = {
  events: EventSpec[];
  redrawRequested: boolean;
  resumeValue?: unknown;
};

class FakeDispatchRenderer {
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  readonly #nodeKinds = new Map<number, number>();
  readonly #plans: FramePlan[] = [];
  readonly #pending = new Map<number, unknown[]>();
  #nextNodeId = 1;
  #nextFrameId = 1;
  #nextEventId = 1;
  initialValue: unknown | undefined;
  invalidatedByInnerHtml = new Uint32Array();
  nodeKindError: unknown;
  resumeError: unknown;
  abortError: unknown;
  abortRedrawRequested = false;

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

  node_kind(nodeHandle: number): number {
    if (this.nodeKindError !== undefined) throw this.nodeKindError;
    const kind = this.#nodeKinds.get(nodeHandle);
    if (kind === undefined) throw new RangeError(`unknown fake node ${nodeHandle}`);
    return kind;
  }

  set_inner_html(_nodeHandle: number, _html: string): Uint32Array {
    return this.invalidatedByInnerHtml;
  }

  queueFrame(events: EventSpec[], redrawRequested = false, resumeValue?: unknown): void {
    this.#plans.push({ events, redrawRequested, resumeValue });
  }

  begin_pointer_move(...args: unknown[]): unknown {
    return this.#begin("begin_pointer_move", args);
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
    const steps = plan.events.map((event) => ({
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
    }));
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

Deno.test("trusted staged events preserve multiplicity and capture, target, bubble order", () => {
  const { document, renderer, window } = createHarness();
  const root = document.createElement("main");
  const parent = document.createElement("button");
  const text = document.createTextNode("Save");
  const calls: string[] = [];
  let firstEvent: unknown;

  window.addEventListener("click", () => calls.push("window capture"), true);
  document.addEventListener("click", () => calls.push("document capture"), true);
  root.addEventListener("click", () => calls.push("root capture"), true);
  parent.addEventListener("click", () => calls.push("parent capture"), true);
  text.addEventListener("click", (event) => {
    calls.push("text target");
    firstEvent = event;
    assert(event.isTrusted);
    assertEquals(event.timeStamp, 42.5);
    assertStrictEquals(event.target, text);
    assertEquals(event.composedPath(), [text, parent, root, document, window]);
  });
  parent.addEventListener("click", () => calls.push("parent bubble"));
  root.addEventListener("click", () => calls.push("root bubble"));
  document.addEventListener("click", () => calls.push("document bubble"));
  window.addEventListener("click", () => calls.push("window bubble"));

  renderer.queueFrame([
    { type: "click", target: text.nodeId, path: [text.nodeId, parent.nodeId, root.nodeId], timeStamp: 42.5 },
    { type: "click", target: text.nodeId, path: [text.nodeId, parent.nodeId, root.nodeId], timeStamp: 42.5 },
  ]);
  document.dispatchPointerMove(1, 2, 0, 0);

  const oneDispatch = [
    "window capture",
    "document capture",
    "root capture",
    "parent capture",
    "text target",
    "parent bubble",
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
  };

  assertThrows(() => document.dispatchPointerMove(1, 2, 0, 0), RangeError);
  assertEquals(renderer.calls.at(-1), ["abort", 9]);
  assertEquals(renders, ["render"]);
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
