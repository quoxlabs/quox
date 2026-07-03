import {
  isQuoxVNode,
  type QuoxProps,
  type QuoxRenderable,
  type QuoxStyle,
  type QuoxVNode,
  serializeQuoxStyle,
} from "@quoxlabs/jsx";
import type { QuoxDocument } from "./document.ts";
import { type QuoxFunctionProp, setElementFunctionProp } from "./handlers.ts";
import type { QuoxElement, QuoxNode } from "./node.ts";

export function mountRenderable(parent: QuoxElement, value: QuoxRenderable): QuoxNode[] {
  const nodes = createNodes(parent.ownerDocument, value);
  for (const node of nodes) parent.appendChild(node);
  return nodes;
}

function createNodes(document: QuoxDocument, value: unknown): QuoxNode[] {
  if (value === null || value === undefined || typeof value === "boolean") return [];

  if (Array.isArray(value)) {
    return value.flatMap((child) => createNodes(document, child));
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
      return [document.createTextNode(String(value))];
    case "function":
      throw new TypeError("Function values cannot be rendered as children. Use JSX component syntax instead.");
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported Quox renderable value: ${String(value)}`);
  }

  if (!isQuoxVNode(value)) {
    throw new TypeError("Unsupported object in Quox render tree.");
  }

  if (typeof value.type === "function") {
    const component = value.type as (props: QuoxProps & { children?: QuoxRenderable }) => unknown;
    const rendered = component(componentProps(value));
    if (isPromiseLike(rendered)) {
      throw new TypeError("Async Quox components are not supported yet.");
    }
    return createNodes(document, rendered);
  }

  const element = document.createElement(value.type);
  applyProps(element, value.props);
  for (const node of createNodes(document, value.children)) {
    element.appendChild(node);
  }

  return [element];
}

function componentProps(vnode: QuoxVNode): QuoxProps & { children?: QuoxRenderable } {
  return vnode.children === undefined ? vnode.props : { ...vnode.props, children: vnode.children };
}

function applyProps(element: QuoxElement, props: QuoxProps): void {
  for (const [rawName, value] of Object.entries(props)) {
    if (rawName === "children" || rawName === "key") continue;
    if (value === null || value === undefined || value === false) continue;

    if (typeof value === "function") {
      setElementFunctionProp(element, rawName, value as QuoxFunctionProp);
      continue;
    }

    const name = attributeName(rawName);

    if (name === "style") {
      if (typeof value !== "string" && (typeof value !== "object" || Array.isArray(value))) {
        throw new TypeError('The "style" prop must be a string or object.');
      }
      element.setAttribute("style", serializeQuoxStyle(value as QuoxStyle));
      continue;
    }

    if (typeof value === "boolean") {
      element.setAttribute(name, "");
      continue;
    }

    if (typeof value === "object") {
      throw new TypeError(`Cannot set object value as "${name}" attribute.`);
    }

    element.setAttribute(name, String(value));
  }
}

function attributeName(name: string): string {
  switch (name) {
    case "className":
      return "class";
    case "htmlFor":
      return "for";
    default:
      return name;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
