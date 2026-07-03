const QUOX_VNODE = Symbol.for("quox.vnode");

export type QuoxKey = string | number | null;
export type QuoxStyleValue = string | number | boolean | null | undefined;
export type QuoxStyleObject = Record<string, QuoxStyleValue>;
export type QuoxStyle = string | QuoxStyleObject;
export type QuoxProps = Record<string, unknown>;
export type QuoxComponent<P extends QuoxProps = QuoxProps> = (
  props: P & { children?: QuoxRenderable },
) => QuoxRenderable;
type AnyQuoxComponent = (props: never) => QuoxRenderable;
export type QuoxVNodeType = string | AnyQuoxComponent;
export type QuoxRenderable =
  | QuoxVNode
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | QuoxRenderable[];

export interface QuoxVNode<P extends QuoxProps = QuoxProps> {
  readonly $$typeof: typeof QUOX_VNODE;
  readonly type: QuoxVNodeType;
  readonly props: P;
  readonly children: QuoxRenderable;
  readonly key: QuoxKey;
}

export type QuoxIntrinsicProps = {
  children?: QuoxRenderable;
  key?: QuoxKey;
  class?: string;
  className?: string;
  htmlFor?: string;
  style?: QuoxStyle;
  [prop: string]: unknown;
};

export function Fragment(props: { children?: QuoxRenderable }): QuoxRenderable {
  return props.children;
}

export function jsx(type: QuoxVNodeType, props: QuoxProps | null, key?: QuoxKey): QuoxVNode {
  return createVNode(type, props, key);
}

export function jsxs(type: QuoxVNodeType, props: QuoxProps | null, key?: QuoxKey): QuoxVNode {
  return createVNode(type, props, key);
}

export function createVNode(type: QuoxVNodeType, props: QuoxProps | null, key?: QuoxKey): QuoxVNode {
  const source = props ?? {};
  const { children, key: propsKey, ...rest } = source;
  return {
    $$typeof: QUOX_VNODE,
    type,
    props: rest,
    children: children as QuoxRenderable,
    key: normalizeKey(key ?? propsKey),
  };
}

export function isQuoxVNode(value: unknown): value is QuoxVNode {
  return typeof value === "object" && value !== null && (value as QuoxVNode).$$typeof === QUOX_VNODE;
}

export function serializeQuoxStyle(style: QuoxStyle): string {
  if (typeof style === "string") return style;

  const declarations: string[] = [];
  for (const [rawName, value] of Object.entries(style)) {
    if (value === null || value === undefined || typeof value === "boolean") continue;
    declarations.push(`${stylePropertyName(rawName)}:${String(value)}`);
  }

  return declarations.join(";");
}

function stylePropertyName(name: string): string {
  if (name.startsWith("--")) return name;

  const kebab = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return kebab.startsWith("ms-") ? `-${kebab}` : kebab;
}

function normalizeKey(value: unknown): QuoxKey {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = QuoxRenderable;
  export type ElementType = QuoxVNodeType;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: QuoxKey;
  }
  export interface IntrinsicElements {
    [tagName: string]: QuoxIntrinsicProps;
  }
}
