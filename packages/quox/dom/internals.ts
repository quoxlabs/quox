import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";
import type { QuoxElement } from "./node.ts";

export type RequestRender = () => void;
export type AssertActive = () => void;

type DocumentInternals = {
  readonly renderer: WasmRenderer;
  readonly requestRender: RequestRender;
  readonly assertActive: AssertActive;
  readonly requestFullscreen: (element: QuoxElement) => Promise<void>;
  readonly didMutate: () => void;
  readonly handleNativeFullscreenChange: (fullscreen: boolean) => void;
  readonly handleNativeFullscreenError: (requestedFullscreen: boolean, message: string) => void;
  readonly disposeFullscreen: () => void;
};

const internals = new WeakMap<QuoxDocument, DocumentInternals>();

export function attachDocumentInternals(document: QuoxDocument, value: DocumentInternals): void {
  internals.set(document, value);
}

export function documentInternals(document: QuoxDocument): DocumentInternals {
  const value = internals.get(document);
  if (value === undefined) {
    throw new TypeError("document internals are unavailable");
  }
  value.assertActive();

  return value;
}

/** Call the promise-returning fullscreen entry point without synchronously asserting activity. */
export function requestElementFullscreen(element: QuoxElement): Promise<void> {
  const value = internals.get(element.ownerDocument);
  if (value === undefined) return Promise.reject(new TypeError("document internals are unavailable"));
  return value.requestFullscreen(element);
}

/** Release fullscreen state during shutdown, after the owning window may already be marked disposed. */
export function disposeDocumentFullscreen(document: QuoxDocument): void {
  internals.get(document)?.disposeFullscreen();
}
