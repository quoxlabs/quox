import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { invokeEventHandlers } from "./event_handlers.ts";
import { documentInternals } from "./internals.ts";
import { QuoxElement, type QuoxFullscreenEvent } from "./node.ts";

class FakeFullscreenRenderer {
  readonly connected = new Set([1, 7, 42]);
  readonly paths = new Map<number, number[]>([
    [1, [1]],
    [7, [7, 1]],
    [42, [42, 7, 1]],
  ]);
  readonly presentation: Array<number | null> = [];
  refreshes = 0;

  title(): string {
    return "";
  }

  document_element(): number {
    return 1;
  }

  is_connected_element(nodeId: number): boolean {
    return this.connected.has(nodeId);
  }

  element_path(nodeId: number): Uint32Array {
    return new Uint32Array(this.connected.has(nodeId) ? this.paths.get(nodeId) ?? [] : []);
  }

  set_fullscreen_element(nodeId: number): void {
    if (!this.connected.has(nodeId)) throw new Error("detached");
    this.presentation.push(nodeId);
  }

  clear_fullscreen_element(): void {
    this.presentation.push(null);
  }

  refresh_fullscreen_element(): boolean {
    this.refreshes++;
    return true;
  }
}

function createHarness(
  options: { enabled?: boolean; active?: boolean; timeout?: number; nativeThrows?: boolean } = {},
) {
  const renderer = new FakeFullscreenRenderer();
  const nativeRequests: boolean[] = [];
  const active = { value: options.active ?? true };
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => undefined,
    () => {
      if (!active.value) throw new Error("inactive");
    },
    () => undefined,
    (fullscreen) => {
      nativeRequests.push(fullscreen);
      if (options.nativeThrows) throw new Error("native failure");
    },
    () => options.enabled ?? true,
    options.timeout ?? 50,
  );
  return { document, renderer, nativeRequests, active };
}

Deno.test("fullscreen waits for native confirmation, updates state, then bubbles before resolving", async () => {
  const { document, renderer, nativeRequests } = createHarness();
  const target = new QuoxElement(document, 42);
  const parent = new QuoxElement(document, 7);
  const calls: string[] = [];
  let eventSeen: QuoxFullscreenEvent | undefined;

  target.onfullscreenchange = function (event) {
    assertStrictEquals(this, target);
    assertStrictEquals(event.target, target);
    assert(document.fullscreenElement === target || document.fullscreenElement === null);
    calls.push("target-property");
    eventSeen = event;
  };
  const targetListener = () => calls.push("target-listener");
  target.addEventListener("fullscreenchange", targetListener);
  target.addEventListener("fullscreenchange", () => calls.push("target-listener-2"));
  parent.addEventListener("fullscreenchange", () => calls.push("parent"));
  document.onfullscreenchange = function (event) {
    assertStrictEquals(this, document);
    assertStrictEquals(event, eventSeen);
    assertStrictEquals(event.currentTarget, document);
    calls.push("document-property");
  };
  document.addEventListener("fullscreenchange", () => calls.push("document-listener"));

  let settled = false;
  const entering = target.requestFullscreen().then(() => {
    settled = true;
    calls.push("resolved");
  });
  await Promise.resolve();
  assertEquals(settled, false);
  assertEquals(document.fullscreenElement, null);
  assertEquals(nativeRequests, [true]);

  documentInternals(document).handleNativeFullscreenChange(true);
  await entering;
  assertStrictEquals(document.fullscreenElement, target);
  assertEquals(renderer.presentation, [42]);
  assertEquals(calls, [
    "target-property",
    "target-listener",
    "target-listener-2",
    "parent",
    "document-property",
    "document-listener",
    "resolved",
  ]);

  target.removeEventListener("fullscreenchange", targetListener);
  const exiting = document.exitFullscreen();
  assertEquals(nativeRequests, [true, false]);
  assertStrictEquals(document.fullscreenElement, target);
  documentInternals(document).handleNativeFullscreenChange(false);
  await exiting;
  assertEquals(document.fullscreenElement, null);
  assertEquals(renderer.presentation, [42, null]);
  assertEquals(calls.filter((call) => call === "target-listener").length, 1);
});

Deno.test("fullscreen duplicate requests coalesce and rapid enter/exit stays serialized", async () => {
  const { document, nativeRequests } = createHarness();
  const target = new QuoxElement(document, 42);
  const equivalentWrapper = new QuoxElement(document, 42);

  const first = target.requestFullscreen();
  const duplicate = equivalentWrapper.requestFullscreen();
  const exit = document.exitFullscreen();
  assertEquals(nativeRequests, [true]);

  documentInternals(document).handleNativeFullscreenChange(true);
  await Promise.all([first, duplicate]);
  assertStrictEquals(document.fullscreenElement, target);
  assertEquals(nativeRequests, [true, false]);

  documentInternals(document).handleNativeFullscreenChange(false);
  await exit;
  assertEquals(document.fullscreenElement, null);
});

Deno.test("opposite requests preserve order instead of coalescing across one another", async () => {
  const { document, nativeRequests } = createHarness();
  const target = new QuoxElement(document, 42);
  const firstEnter = target.requestFullscreen();
  const exit = document.exitFullscreen();
  const secondEnter = target.requestFullscreen();

  documentInternals(document).handleNativeFullscreenChange(true);
  await firstEnter;
  assertEquals(nativeRequests, [true, false]);
  documentInternals(document).handleNativeFullscreenChange(false);
  await exit;
  assertEquals(nativeRequests, [true, false, true]);
  documentInternals(document).handleNativeFullscreenChange(true);
  await secondEnter;
  assertStrictEquals(document.fullscreenElement, target);
});

Deno.test("fullscreen rejects unsupported, inactive, detached, conflicting, failed, and denied requests", async () => {
  const unsupported = createHarness({ enabled: false });
  let errors = 0;
  unsupported.document.onfullscreenerror = () => errors++;
  await assertRejects(() => new QuoxElement(unsupported.document, 42).requestFullscreen(), TypeError);
  assertEquals(errors, 1);
  assertEquals(unsupported.document.fullscreenEnabled, false);

  const inactive = createHarness({ active: false });
  await assertRejects(() => new QuoxElement(inactive.document, 42).requestFullscreen(), TypeError);

  const detached = createHarness();
  detached.renderer.connected.delete(42);
  await assertRejects(() => new QuoxElement(detached.document, 42).requestFullscreen(), TypeError);

  const failed = createHarness({ nativeThrows: true });
  await assertRejects(() => new QuoxElement(failed.document, 42).requestFullscreen(), TypeError, "native failure");

  const denied = createHarness();
  const target = new QuoxElement(denied.document, 42);
  const request = target.requestFullscreen();
  documentInternals(denied.document).handleNativeFullscreenChange(false);
  await assertRejects(() => request, TypeError, "denied");

  const asynchronouslyFailed = createHarness();
  const failedRequest = new QuoxElement(asynchronouslyFailed.document, 42).requestFullscreen();
  documentInternals(asynchronouslyFailed.document).handleNativeFullscreenError(true, "compositor refused");
  await assertRejects(() => failedRequest, TypeError, "compositor refused");

  const conflict = createHarness();
  const first = new QuoxElement(conflict.document, 42).requestFullscreen();
  await assertRejects(() => new QuoxElement(conflict.document, 7).requestFullscreen(), TypeError);
  documentInternals(conflict.document).handleNativeFullscreenChange(true);
  await first;

  const foreign = createHarness();
  const other = createHarness();
  await assertRejects(
    () => documentInternals(foreign.document).requestFullscreen(new QuoxElement(other.document, 42)),
    TypeError,
  );
});

Deno.test("fullscreen times out and pending requests reject when the document is disposed", async () => {
  const timedOut = createHarness({ timeout: 1 });
  await assertRejects(
    () => new QuoxElement(timedOut.document, 42).requestFullscreen(),
    TypeError,
    "timed out",
  );

  const disposed = createHarness();
  const request = new QuoxElement(disposed.document, 42).requestFullscreen();
  documentInternals(disposed.document).disposeFullscreen();
  await assertRejects(() => request, TypeError, "not active");
  assertEquals(disposed.document.fullscreenEnabled, false);
  assertEquals(disposed.nativeRequests, [true, false]);
});

Deno.test("a late enter confirmation is reconciled and followed by a queued user exit", async () => {
  const { document, nativeRequests } = createHarness({ timeout: 1 });
  const target = new QuoxElement(document, 42);
  const enter = target.requestFullscreen();
  const exit = document.exitFullscreen();
  const results = await Promise.allSettled([enter, exit]);
  assertEquals(results.map((result) => result.status), ["rejected", "rejected"]);

  documentInternals(document).handleNativeFullscreenChange(true);
  assertStrictEquals(document.fullscreenElement, target);
  assertEquals(nativeRequests, [true, false]);
  documentInternals(document).handleNativeFullscreenChange(false);
  assertEquals(document.fullscreenElement, null);
});

Deno.test("removing or reparenting the fullscreen target clears presentation and exits natively", async () => {
  for (const detached of [false, true]) {
    const { document, renderer, nativeRequests } = createHarness();
    const target = new QuoxElement(document, 42);
    const events: Array<QuoxElement | QuoxDocument> = [];
    document.onfullscreenchange = (event) => events.push(event.target);
    const request = target.requestFullscreen();
    documentInternals(document).handleNativeFullscreenChange(true);
    await request;

    if (detached) renderer.connected.delete(42);
    else renderer.paths.set(42, [42, 1]);
    documentInternals(document).didMutate();

    assertEquals(document.fullscreenElement, null);
    assertEquals(renderer.presentation, [42, null]);
    assertEquals(nativeRequests, [true, false]);
    assertStrictEquals(events[1], detached ? document : target);
    documentInternals(document).handleNativeFullscreenChange(false);
  }
});

Deno.test("ordinary DOM addEventListener supports multiple callbacks and removal", () => {
  const { document } = createHarness();
  const target = new QuoxElement(document, 42);
  const calls: string[] = [];
  const removed = () => calls.push("removed");
  target.addEventListener("click", () => calls.push("one"));
  target.addEventListener("click", removed);
  target.addEventListener("click", () => calls.push("two"));
  target.removeEventListener("click", removed);

  target.onclick = () => calls.push("property");
  assert(target.onclick !== null);
  invokeEventHandlers(document, [42], "click");
  assertEquals(calls, ["property", "one", "two"]);
});
