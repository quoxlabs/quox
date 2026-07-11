import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";

export type RequestRender = () => void;
export type AssertActive = () => void;
export type InvalidateNodeHandles = (nodeHandles: Iterable<number>) => void;

type DocumentInternals = {
  readonly renderer: WasmRenderer;
  readonly requestRender: RequestRender;
  readonly assertActive: AssertActive;
  readonly invalidateNodeHandles: InvalidateNodeHandles;
  readonly isDispatching: () => boolean;
};

const internals = new WeakMap<QuoxDocument, DocumentInternals>();

export function attachDocumentInternals(document: QuoxDocument, value: DocumentInternals): void {
  internals.set(document, value);
}

/** Read dispatch liveness without asserting that the native window is still active. */
export function documentHasActiveDispatch(document: QuoxDocument): boolean {
  return internals.get(document)?.isDispatching() ?? false;
}

/** Decide whether a stopped window may release its renderer at this point. */
export function releaseStoppedRenderer(
  stopped: boolean,
  dispatching: boolean,
  alreadyReleased: boolean,
  release: () => void,
): boolean {
  if (!stopped || dispatching || alreadyReleased) return false;
  release();
  return true;
}

export function documentInternals(document: QuoxDocument): DocumentInternals {
  const value = internals.get(document);
  if (value === undefined) {
    throw new TypeError("document internals are unavailable");
  }
  value.assertActive();

  return value;
}
