import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";

export type RequestRender = () => void;

type DocumentInternals = {
  readonly renderer: WasmRenderer;
  readonly requestRender: RequestRender;
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

  return value;
}
