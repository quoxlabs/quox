import type { QuoxDocument } from "./document.ts";
import { getEventHandler, setEventHandler } from "./event_handlers.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string;

export type QuoxEventType =
  | "click"
  | "dblclick"
  | "contextmenu"
  | "input"
  | "focus"
  | "blur"
  | "scroll"
  | "pointermove"
  | "pointerdown"
  | "pointerup"
  | "pointerover"
  | "pointerout"
  | "mousemove"
  | "mousedown"
  | "mouseup"
  | "mouseover"
  | "mouseout"
  | "wheel"
  | "keydown"
  | "keyup";

export interface QuoxEvent {
  readonly type: QuoxEventType;
  readonly target: QuoxElement;
  readonly currentTarget: QuoxElement | null;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface QuoxMouseEvent extends QuoxEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly button: number;
  readonly buttons: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export interface QuoxPointerEvent extends QuoxMouseEvent {
  readonly pointerId: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly isPrimary: boolean;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;
}

export interface QuoxWheelEvent extends QuoxMouseEvent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: 0;
}

export interface QuoxElementKeyboardEvent extends QuoxEvent {
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export type QuoxEventHandler<Event extends QuoxEvent = QuoxEvent> = (
  this: QuoxElement,
  event: Event,
) => unknown;

type MouseEventHandler = QuoxEventHandler<QuoxMouseEvent>;
type PointerEventHandler = QuoxEventHandler<QuoxPointerEvent>;
type WheelEventHandler = QuoxEventHandler<QuoxWheelEvent>;
type KeyboardEventHandler = QuoxEventHandler<QuoxElementKeyboardEvent>;

export class QuoxNode {
  constructor(
    readonly ownerDocument: QuoxDocument,
    readonly nodeId: number,
  ) {}

  get textContent(): string {
    return documentInternals(this.ownerDocument).renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_text_content(this.nodeId, value ?? "");
    requestRender();
  }

  appendChild<T extends QuoxNode>(child: T): T {
    if (child.ownerDocument !== this.ownerDocument) {
      throw new TypeError("node belongs to a different document");
    }

    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.append_child(this.nodeId, child.nodeId);
    requestRender();
    return child;
  }

  remove(): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_node(this.nodeId);
    requestRender();
  }
}

export class QuoxElement extends QuoxNode {
  get onclick(): MouseEventHandler | null {
    return getEventHandler(this, "click");
  }

  set onclick(handler: MouseEventHandler | null) {
    setEventHandler(this, "click", handler);
  }

  get ondblclick(): MouseEventHandler | null {
    return getEventHandler(this, "dblclick");
  }

  set ondblclick(handler: MouseEventHandler | null) {
    setEventHandler(this, "dblclick", handler);
  }

  get oncontextmenu(): MouseEventHandler | null {
    return getEventHandler(this, "contextmenu");
  }

  set oncontextmenu(handler: MouseEventHandler | null) {
    setEventHandler(this, "contextmenu", handler);
  }

  get oninput(): QuoxEventHandler | null {
    return getEventHandler(this, "input");
  }

  set oninput(handler: QuoxEventHandler | null) {
    setEventHandler(this, "input", handler);
  }

  get onfocus(): QuoxEventHandler | null {
    return getEventHandler(this, "focus");
  }

  set onfocus(handler: QuoxEventHandler | null) {
    setEventHandler(this, "focus", handler);
  }

  get onblur(): QuoxEventHandler | null {
    return getEventHandler(this, "blur");
  }

  set onblur(handler: QuoxEventHandler | null) {
    setEventHandler(this, "blur", handler);
  }

  get onscroll(): QuoxEventHandler | null {
    return getEventHandler(this, "scroll");
  }

  set onscroll(handler: QuoxEventHandler | null) {
    setEventHandler(this, "scroll", handler);
  }

  get onpointermove(): PointerEventHandler | null {
    return getEventHandler(this, "pointermove") as PointerEventHandler | null;
  }

  set onpointermove(handler: PointerEventHandler | null) {
    setEventHandler(this, "pointermove", handler);
  }

  get onpointerdown(): PointerEventHandler | null {
    return getEventHandler(this, "pointerdown") as PointerEventHandler | null;
  }

  set onpointerdown(handler: PointerEventHandler | null) {
    setEventHandler(this, "pointerdown", handler);
  }

  get onpointerup(): PointerEventHandler | null {
    return getEventHandler(this, "pointerup") as PointerEventHandler | null;
  }

  set onpointerup(handler: PointerEventHandler | null) {
    setEventHandler(this, "pointerup", handler);
  }

  get onpointerover(): PointerEventHandler | null {
    return getEventHandler(this, "pointerover") as PointerEventHandler | null;
  }

  set onpointerover(handler: PointerEventHandler | null) {
    setEventHandler(this, "pointerover", handler);
  }

  get onpointerout(): PointerEventHandler | null {
    return getEventHandler(this, "pointerout") as PointerEventHandler | null;
  }

  set onpointerout(handler: PointerEventHandler | null) {
    setEventHandler(this, "pointerout", handler);
  }

  get onmousemove(): MouseEventHandler | null {
    return getEventHandler(this, "mousemove") as MouseEventHandler | null;
  }

  set onmousemove(handler: MouseEventHandler | null) {
    setEventHandler(this, "mousemove", handler);
  }

  get onmousedown(): MouseEventHandler | null {
    return getEventHandler(this, "mousedown") as MouseEventHandler | null;
  }

  set onmousedown(handler: MouseEventHandler | null) {
    setEventHandler(this, "mousedown", handler);
  }

  get onmouseup(): MouseEventHandler | null {
    return getEventHandler(this, "mouseup") as MouseEventHandler | null;
  }

  set onmouseup(handler: MouseEventHandler | null) {
    setEventHandler(this, "mouseup", handler);
  }

  get onmouseover(): MouseEventHandler | null {
    return getEventHandler(this, "mouseover") as MouseEventHandler | null;
  }

  set onmouseover(handler: MouseEventHandler | null) {
    setEventHandler(this, "mouseover", handler);
  }

  get onmouseout(): MouseEventHandler | null {
    return getEventHandler(this, "mouseout") as MouseEventHandler | null;
  }

  set onmouseout(handler: MouseEventHandler | null) {
    setEventHandler(this, "mouseout", handler);
  }

  get onwheel(): WheelEventHandler | null {
    return getEventHandler(this, "wheel") as WheelEventHandler | null;
  }

  set onwheel(handler: WheelEventHandler | null) {
    setEventHandler(this, "wheel", handler);
  }

  get onkeydown(): KeyboardEventHandler | null {
    return getEventHandler(this, "keydown") as KeyboardEventHandler | null;
  }

  set onkeydown(handler: KeyboardEventHandler | null) {
    setEventHandler(this, "keydown", handler);
  }

  get onkeyup(): KeyboardEventHandler | null {
    return getEventHandler(this, "keyup") as KeyboardEventHandler | null;
  }

  set onkeyup(handler: KeyboardEventHandler | null) {
    setEventHandler(this, "keyup", handler);
  }

  set innerHTML(value: QuoxInnerHTML) {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    const html = value;
    renderer.set_inner_html(this.nodeId, html);
    requestRender();
  }

  setAttribute(name: string, value: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_attribute(this.nodeId, name, value);
    requestRender();
  }

  removeAttribute(name: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_attribute(this.nodeId, name);
    requestRender();
  }
}

export class QuoxText extends QuoxNode {}
