import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { QuoxDocument } from "./document.ts";
import { getElementFunctionProps, setElementFunctionProp } from "./handlers.ts";
import { ELEMENT_NODE, QuoxNodeCache, TEXT_NODE } from "./node_cache.ts";
import { QuoxElement, QuoxText } from "./node.ts";

/** Minimal model of the Rust boundary: raw ids are reusable, public handles are not. */
class FakeHandleBridge {
  #nextHandle = 1;
  readonly #handlesByRawId = new Map<number, number>();

  expose(rawId: number): number {
    const existing = this.#handlesByRawId.get(rawId);
    if (existing !== undefined) return existing;
    const handle = this.#nextHandle++;
    this.#handlesByRawId.set(rawId, handle);
    return handle;
  }

  destroy(rawId: number): void {
    this.#handlesByRawId.delete(rawId);
  }
}

Deno.test("raw node id reuse cannot alias cached wrappers or handlers", () => {
  const document = {} as QuoxDocument;
  const cache = new QuoxNodeCache(document);
  const bridge = new FakeHandleBridge();
  const reusedRawId = 7;

  const oldHandle = bridge.expose(reusedRawId);
  const oldNode = cache.get(oldHandle, ELEMENT_NODE);
  const oldHandler = () => undefined;
  setElementFunctionProp(oldNode, "onClick", oldHandler);

  assertStrictEquals(cache.get(oldHandle, ELEMENT_NODE), oldNode);
  bridge.destroy(reusedRawId);
  cache.invalidate([oldHandle]);

  const replacementHandle = bridge.expose(reusedRawId);
  const replacementNode = cache.get(replacementHandle, ELEMENT_NODE);

  assertNotStrictEquals(replacementHandle, oldHandle);
  assertNotStrictEquals(replacementNode, oldNode);
  assertStrictEquals(getElementFunctionProps(oldNode)?.get("onClick"), oldHandler);
  assertEquals(getElementFunctionProps(replacementNode), undefined);
});

Deno.test("the wrapper cache preserves element and text identity", () => {
  const document = {} as QuoxDocument;
  const cache = new QuoxNodeCache(document);

  const element = cache.get(1, ELEMENT_NODE);
  const text = cache.get(2, TEXT_NODE);

  assertInstanceOf(element, QuoxElement);
  assertInstanceOf(text, QuoxText);
  assertStrictEquals(cache.get(1, ELEMENT_NODE), element);
  assertStrictEquals(cache.get(2, TEXT_NODE), text);
  assert(element !== text);
});

Deno.test("node handles cannot alias after unsigned WASM narrowing", () => {
  const cache = new QuoxNodeCache({} as QuoxDocument);

  assertThrows(() => cache.get(0x1_0000_0001, ELEMENT_NODE), RangeError);
});
