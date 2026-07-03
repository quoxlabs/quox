import { Fragment, isQuoxVNode, type QuoxProps, type QuoxStyle, serializeQuoxStyle } from "@quoxlabs/jsx";
import type { QuoxDocument } from "./document.ts";
import { setElementFunctionProp } from "./handlers.ts";
import type { QuoxElement, QuoxNode } from "./node.ts";

type NormalizedVNode = {
  type: string | ((props: never) => unknown);
  props: QuoxProps;
  children: unknown;
};

/** A JSX value produced by any JSX runtime `mount` recognizes (see `normalizeVNode`), or plain content. */
export type QuoxRenderable = string | number | bigint | boolean | null | undefined | object | QuoxRenderable[];

/** Mount a JSX value (from any recognized runtime) into `parent`, returning the created nodes. */
export async function mount(parent: QuoxElement, value: QuoxRenderable): Promise<QuoxNode[]> {
  const nodes = await createNodes(parent.ownerDocument, value);
  for (const node of nodes) parent.appendChild(node);
  return nodes;
}

async function createNodes(document: QuoxDocument, value: unknown): Promise<QuoxNode[]> {
  if (value === null || value === undefined || typeof value === "boolean") return [];

  if (Array.isArray(value)) {
    const groups = await Promise.all(value.map((child) => createNodes(document, child)));
    return groups.flat();
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

  const vnode = normalizeVNode(value);
  if (vnode === null) {
    throw new TypeError("Unsupported object in Quox render tree.");
  }

  if (vnode.type === Fragment) {
    return createNodes(document, vnode.children);
  }

  if (typeof vnode.type === "function") {
    const component = vnode.type as (props: QuoxProps & { children?: unknown }) => unknown;
    const rendered = await component(componentProps(vnode));
    return createNodes(document, rendered);
  }

  const element = document.createElement(vnode.type);
  applyProps(element, vnode.props);
  for (const node of await createNodes(document, vnode.children)) {
    element.appendChild(node);
  }

  return [element];
}

/**
 * Recognize a vnode produced by any supported JSX runtime and normalize it to a common shape.
 * Add a branch here to support another runtime.
 */
function normalizeVNode(value: object): NormalizedVNode | null {
  if (isQuoxVNode(value)) {
    return { type: value.type, props: value.props, children: value.children };
  }

  if (isPreactLikeVNode(value)) {
    const { children, ...props } = value.props ?? {};
    return { type: value.type as NormalizedVNode["type"], props, children };
  }

  return null;
}

/**
 * Duck-types Preact's vnode shape without depending on `preact`. Preact tags every vnode with
 * `constructor: undefined` as an anti-forgery marker (the same check `preact/compat`'s
 * `isValidElement` uses); plain object literals have `constructor === Object`.
 */
function isPreactLikeVNode(value: object): value is { type: unknown; props: QuoxProps | null } {
  return "type" in value && "props" in value && (value as { constructor?: unknown }).constructor === undefined;
}

function componentProps(vnode: NormalizedVNode): QuoxProps & { children?: unknown } {
  return vnode.children === undefined ? vnode.props : { ...vnode.props, children: vnode.children };
}

function applyProps(element: QuoxElement, props: QuoxProps): void {
  for (const [rawName, value] of Object.entries(props)) {
    if (rawName === "children" || rawName === "key") continue;
    if (value === null || value === undefined || value === false) continue;

    if (typeof value === "function") {
      setElementFunctionProp(element, rawName, value as (...args: unknown[]) => unknown);
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
