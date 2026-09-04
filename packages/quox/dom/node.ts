import type { QuoxDocument } from "./document.ts";
import {
  addElementEventListener,
  getEventHandler,
  removeElementEventListener,
  setEventHandler,
} from "./event_handlers.ts";
import { documentInternals, requestElementFullscreen } from "./internals.ts";

export type QuoxInnerHTML = string;

export type QuoxEventType = "click" | "dblclick" | "contextmenu" | "input" | "focus" | "blur" | "scroll";
export type QuoxFullscreenEventType = "fullscreenchange" | "fullscreenerror";

export interface QuoxEvent {
  readonly type: QuoxEventType;
  readonly target: QuoxElement;
  readonly currentTarget: QuoxElement | null;
  readonly bubbles: boolean;
  stopPropagation(): void;
}

export type QuoxEventHandler = (this: QuoxElement, event: QuoxEvent) => unknown;

export interface QuoxFullscreenEvent {
  readonly type: QuoxFullscreenEventType;
  readonly target: QuoxElement | QuoxDocument;
  readonly currentTarget: QuoxElement | QuoxDocument | null;
  readonly bubbles: true;
  stopPropagation(): void;
}

export type QuoxFullscreenEventHandler = (this: QuoxElement, event: QuoxFullscreenEvent) => unknown;

export class QuoxNode {
  constructor(
    readonly ownerDocument: QuoxDocument,
    readonly nodeId: number,
  ) {}

  get textContent(): string {
    return documentInternals(this.ownerDocument).renderer.text_content(this.nodeId);
  }

  set textContent(value: string | null) {
    const { renderer } = documentInternals(this.ownerDocument);
    renderer.set_text_content(this.nodeId, value ?? "");
    documentInternals(this.ownerDocument).didMutate();
  }

  appendChild<T extends QuoxNode>(child: T): T {
    if (child.ownerDocument !== this.ownerDocument) {
      throw new TypeError("node belongs to a different document");
    }

    const { renderer } = documentInternals(this.ownerDocument);
    renderer.append_child(this.nodeId, child.nodeId);
    documentInternals(this.ownerDocument).didMutate();
    return child;
  }

  remove(): void {
    const { renderer } = documentInternals(this.ownerDocument);
    renderer.remove_node(this.nodeId);
    documentInternals(this.ownerDocument).didMutate();
  }
}

export class QuoxElement extends QuoxNode {
  addEventListener(type: QuoxEventType, listener: QuoxEventHandler): void;
  addEventListener(type: QuoxFullscreenEventType, listener: QuoxFullscreenEventHandler): void;
  addEventListener(
    type: QuoxEventType | QuoxFullscreenEventType,
    listener: QuoxEventHandler | QuoxFullscreenEventHandler,
  ): void {
    addElementEventListener(this, type, listener);
  }

  removeEventListener(type: QuoxEventType, listener: QuoxEventHandler): void;
  removeEventListener(type: QuoxFullscreenEventType, listener: QuoxFullscreenEventHandler): void;
  removeEventListener(
    type: QuoxEventType | QuoxFullscreenEventType,
    listener: QuoxEventHandler | QuoxFullscreenEventHandler,
  ): void {
    removeElementEventListener(this, type, listener);
  }

  get onclick(): QuoxEventHandler | null {
    return getEventHandler(this, "click");
  }

  set onclick(handler: QuoxEventHandler | null) {
    setEventHandler(this, "click", handler);
  }

  get ondblclick(): QuoxEventHandler | null {
    return getEventHandler(this, "dblclick");
  }

  set ondblclick(handler: QuoxEventHandler | null) {
    setEventHandler(this, "dblclick", handler);
  }

  get oncontextmenu(): QuoxEventHandler | null {
    return getEventHandler(this, "contextmenu");
  }

  set oncontextmenu(handler: QuoxEventHandler | null) {
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

  get onfullscreenchange(): QuoxFullscreenEventHandler | null {
    return getEventHandler(this, "fullscreenchange") as QuoxFullscreenEventHandler | null;
  }

  set onfullscreenchange(handler: QuoxFullscreenEventHandler | null) {
    setEventHandler(this, "fullscreenchange", handler);
  }

  get onfullscreenerror(): QuoxFullscreenEventHandler | null {
    return getEventHandler(this, "fullscreenerror") as QuoxFullscreenEventHandler | null;
  }

  set onfullscreenerror(handler: QuoxFullscreenEventHandler | null) {
    setEventHandler(this, "fullscreenerror", handler);
  }

  requestFullscreen(): Promise<void> {
    return requestElementFullscreen(this);
  }

  set innerHTML(value: QuoxInnerHTML) {
    const { renderer } = documentInternals(this.ownerDocument);
    const html = value;
    renderer.set_inner_html(this.nodeId, html);
    documentInternals(this.ownerDocument).didMutate();
  }

  setAttribute(name: string, value: string): void {
    const { renderer } = documentInternals(this.ownerDocument);
    renderer.set_attribute(this.nodeId, name, value);
    documentInternals(this.ownerDocument).didMutate();
  }

  /**
   * Display an image in this `<img>` element from a byte buffer of encoded image
   * data — e.g. the `Uint8Array` returned by `Deno.readFile`. You pass the raw
   * bytes of the image file (not pre-decoded pixels); decoding happens inside
   * quox's WebAssembly module. Throws if this element is not an `<img>`.
   *
   * Supported formats are PNG, JPEG, GIF and WebP. GIFs are supported but only
   * as a still image: an animated GIF renders as its first frame, not animated.
   */
  setImageData(bytes: Uint8Array): void {
    const { renderer } = documentInternals(this.ownerDocument);
    renderer.set_image_data(this.nodeId, bytes);
    documentInternals(this.ownerDocument).didMutate();
  }

  removeAttribute(name: string): void {
    const { renderer } = documentInternals(this.ownerDocument);
    renderer.remove_attribute(this.nodeId, name);
    documentInternals(this.ownerDocument).didMutate();
  }
}

export class QuoxText extends QuoxNode {}
