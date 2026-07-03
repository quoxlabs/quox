import { createVNode, type QuoxKey, type QuoxProps, type QuoxVNode, type QuoxVNodeType } from "./jsx-runtime.ts";

export * from "./jsx-runtime.ts";

export function jsxDEV(
  type: QuoxVNodeType,
  props: QuoxProps | null,
  key?: QuoxKey,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): QuoxVNode {
  return createVNode(type, props, key);
}
