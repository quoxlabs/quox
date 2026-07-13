const QUOX_VNODE = Symbol.for("quox.vnode");

export type QuoxKey = string | number | null;
export type QuoxStyleValue = string | number | boolean | null | undefined;
export type QuoxStyleObject = Record<string, QuoxStyleValue>;
export type QuoxStyle = string | QuoxStyleObject;
export type QuoxProps = Record<string, unknown>;
export type QuoxComponent<P extends object = QuoxProps> = (
  props: P & { children?: QuoxRenderable },
) => QuoxRenderable | Promise<QuoxRenderable>;
type AnyQuoxComponent = (props: never) => QuoxRenderable | Promise<QuoxRenderable>;
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

/** Dependency-free structural view of the event objects dispatched by Quox. */
export interface QuoxJsxEvent {
  readonly NONE: 0;
  readonly CAPTURING_PHASE: 1;
  readonly AT_TARGET: 2;
  readonly BUBBLING_PHASE: 3;
  readonly type: string;
  readonly target: object | null;
  readonly srcElement: object | null;
  readonly currentTarget: object | null;
  readonly eventPhase: 0 | 1 | 2 | 3;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly composed: boolean;
  readonly isTrusted: boolean;
  readonly timeStamp: number;
  cancelBubble: boolean;
  returnValue: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  composedPath(): object[];
  initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
}

export interface QuoxJsxUIEvent extends QuoxJsxEvent {
  readonly view: object | null;
  readonly detail: number;
  readonly which: number;
}

export interface QuoxJsxMouseEvent extends QuoxJsxUIEvent {
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly x: number;
  readonly y: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly movementX: number;
  readonly movementY: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly relatedTarget: object | null;
  getModifierState(keyArg: string): boolean;
}

export interface QuoxJsxPointerEvent extends QuoxJsxMouseEvent {
  readonly pointerId: number;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly persistentDeviceId: number;
  getCoalescedEvents(): QuoxJsxPointerEvent[];
  getPredictedEvents(): QuoxJsxPointerEvent[];
}

export interface QuoxJsxWheelEvent extends QuoxJsxMouseEvent {
  readonly DOM_DELTA_PIXEL: 0;
  readonly DOM_DELTA_LINE: 1;
  readonly DOM_DELTA_PAGE: 2;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
}

export interface QuoxJsxKeyboardEvent extends QuoxJsxUIEvent {
  readonly DOM_KEY_LOCATION_STANDARD: 0;
  readonly DOM_KEY_LOCATION_LEFT: 1;
  readonly DOM_KEY_LOCATION_RIGHT: 2;
  readonly DOM_KEY_LOCATION_NUMPAD: 3;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly charCode: number;
  readonly keyCode: number;
  getModifierState(keyArg: string): boolean;
}

export interface QuoxJsxInputEvent extends QuoxJsxUIEvent {
  readonly data: string | null;
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly dataTransfer: unknown | null;
  getTargetRanges(): unknown[];
}

export interface QuoxJsxCompositionEvent extends QuoxJsxUIEvent {
  readonly data: string;
}

export interface QuoxJsxFocusEvent extends QuoxJsxUIEvent {
  readonly relatedTarget: object | null;
}

/** JSX callbacks are bivariant like browser-framework handler props. */
export type QuoxEventHandler<Event extends QuoxJsxEvent> = {
  bivarianceHack(event: Event): unknown;
}["bivarianceHack"];

type QuoxEventProp<Event extends QuoxJsxEvent> = QuoxEventHandler<Event> | false | null;

type QuoxBaseEventProps = {
  onPointerMove?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerDown?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerUp?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerCancel?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerEnter?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerLeave?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerOver?: QuoxEventProp<QuoxJsxPointerEvent>;
  onPointerOut?: QuoxEventProp<QuoxJsxPointerEvent>;
  onMouseMove?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseDown?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseUp?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseEnter?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseLeave?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseOver?: QuoxEventProp<QuoxJsxMouseEvent>;
  onMouseOut?: QuoxEventProp<QuoxJsxMouseEvent>;
  onScroll?: QuoxEventProp<QuoxJsxEvent>;
  onWheel?: QuoxEventProp<QuoxJsxWheelEvent>;
  onClick?: QuoxEventProp<QuoxJsxPointerEvent>;
  onAuxClick?: QuoxEventProp<QuoxJsxPointerEvent>;
  onContextMenu?: QuoxEventProp<QuoxJsxPointerEvent>;
  onDoubleClick?: QuoxEventProp<QuoxJsxMouseEvent>;
  onDblClick?: QuoxEventProp<QuoxJsxMouseEvent>;
  onKeyDown?: QuoxEventProp<QuoxJsxKeyboardEvent>;
  onKeyUp?: QuoxEventProp<QuoxJsxKeyboardEvent>;
  onBeforeInput?: QuoxEventProp<QuoxJsxInputEvent>;
  onInput?: QuoxEventProp<QuoxJsxInputEvent>;
  onChange?: QuoxEventProp<QuoxJsxEvent>;
  onCompositionStart?: QuoxEventProp<QuoxJsxCompositionEvent>;
  onCompositionUpdate?: QuoxEventProp<QuoxJsxCompositionEvent>;
  onCompositionEnd?: QuoxEventProp<QuoxJsxCompositionEvent>;
  onFocus?: QuoxEventProp<QuoxJsxFocusEvent>;
  onBlur?: QuoxEventProp<QuoxJsxFocusEvent>;
  onFocusIn?: QuoxEventProp<QuoxJsxFocusEvent>;
  onFocusOut?: QuoxEventProp<QuoxJsxFocusEvent>;
};

type QuoxCaptureEventProps = {
  [Prop in keyof QuoxBaseEventProps as `${Prop & string}Capture`]?: QuoxBaseEventProps[Prop];
};

export type QuoxEventProps = QuoxBaseEventProps & QuoxCaptureEventProps;

export type QuoxIntrinsicProps = QuoxEventProps & {
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
