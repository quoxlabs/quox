import { assertEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";
import { attachDocumentInternals } from "./internals.ts";
import { QuoxElement } from "./node.ts";

class FakeScrollRenderer {
  readonly leftInputs: number[] = [];
  readonly topInputs: number[] = [];
  #left = 0;
  #top = 0;

  element_scroll_left(_nodeHandle: number): number {
    return this.#left;
  }

  element_scroll_top(_nodeHandle: number): number {
    return this.#top;
  }

  set_element_scroll_left(_nodeHandle: number, value: number): boolean {
    this.leftInputs.push(value);
    const next = Math.max(0, Math.min(100, value));
    const changed = next !== this.#left;
    this.#left = next;
    return changed;
  }

  set_element_scroll_top(_nodeHandle: number, value: number): boolean {
    this.topInputs.push(value);
    const next = Math.max(0, Math.min(200, value));
    const changed = next !== this.#top;
    this.#top = next;
    return changed;
  }

  simulateNativeScroll(left: number, top: number): void {
    this.#left = left;
    this.#top = top;
  }
}

function createElement(): {
  readonly element: QuoxElement;
  readonly renderer: FakeScrollRenderer;
  readonly renders: { count: number };
  readonly scrollTargets: number[];
} {
  const document = {} as QuoxDocument;
  const renderer = new FakeScrollRenderer();
  const renders = { count: 0 };
  const scrollTargets: number[] = [];
  const element = new QuoxElement(document, 7);
  attachDocumentInternals(document, {
    renderer: renderer as unknown as WasmRenderer,
    requestRender: () => renders.count++,
    assertActive: () => undefined,
    invalidateNodeHandles: () => undefined,
    queueScrollEvent: (nodeHandle) => {
      scrollTargets.push(nodeHandle);
      renders.count++;
    },
    isDispatching: () => false,
    focusElement: () => undefined,
    blurElement: () => undefined,
    syntheticEventPath: () => [element],
  });
  return { element, renderer, renders, scrollTargets };
}

Deno.test("element scroll offsets stay live and queue events only after effective movement", () => {
  const { element, renderer, renders, scrollTargets } = createElement();

  renderer.simulateNativeScroll(33.25, 44.75);
  assertEquals(element.scrollLeft, 33.25);
  assertEquals(element.scrollTop, 44.75);
  assertEquals(renders.count, 0, "reading a wheel-updated offset must not request paint");

  element.scrollLeft = 40.5;
  assertEquals(element.scrollLeft, 40.5);
  assertEquals(renders.count, 1);

  element.scrollLeft = 40.5;
  assertEquals(renders.count, 1, "assigning the current offset must not request paint");

  element.scrollLeft = 10_000;
  assertEquals(element.scrollLeft, 100);
  assertEquals(renders.count, 2);

  element.scrollTop = -25;
  assertEquals(element.scrollTop, 0);
  assertEquals(renders.count, 3);
  assertEquals(scrollTargets, [7, 7, 7]);
});

Deno.test("scroll setters perform Web IDL conversion once and normalize non-finite values", () => {
  const { element, renderer, renders } = createElement();
  let conversions = 0;

  (element as unknown as { scrollLeft: unknown }).scrollLeft = {
    valueOf() {
      conversions += 1;
      return 12.75;
    },
  };
  assertEquals(conversions, 1);
  assertEquals(renderer.leftInputs, [12.75]);
  assertEquals(element.scrollLeft, 12.75);
  assertEquals(renders.count, 1);

  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    (element as unknown as { scrollLeft: unknown }).scrollLeft = value;
  }
  assertEquals(renderer.leftInputs, [12.75, 0, 0, 0, 0]);
  assertEquals(element.scrollLeft, 0);
  assertEquals(renders.count, 2, "equivalent normalized assignments must not repaint");

  (element as unknown as { scrollTop: unknown }).scrollTop = "18.5";
  assertEquals(renderer.topInputs, [18.5]);
  assertEquals(element.scrollTop, 18.5);

  const leftCallCount = renderer.leftInputs.length;
  assertThrows(
    () => ((element as unknown as { scrollLeft: unknown }).scrollLeft = 1n),
    TypeError,
  );
  assertThrows(
    () => ((element as unknown as { scrollLeft: unknown }).scrollLeft = Symbol("offset")),
    TypeError,
  );
  assertEquals(renderer.leftInputs.length, leftCallCount, "failed conversion must not reach WASM");
});
