import type { QuoxDocument } from "./document.ts";
import { getEventHandler, setEventHandler } from "./event_handlers.ts";
import { documentInternals } from "./internals.ts";

export type QuoxInnerHTML = string;

export type QuoxEventType = "click" | "dblclick" | "contextmenu" | "input" | "focus" | "blur" | "scroll";

export interface QuoxEvent {
  readonly type: QuoxEventType;
  readonly target: QuoxElement;
  readonly currentTarget: QuoxElement | null;
  readonly bubbles: boolean;
  stopPropagation(): void;
}

export type QuoxEventHandler = (this: QuoxElement, event: QuoxEvent) => unknown;

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

  getAttribute(name: string): string | null {
    const { renderer } = documentInternals(this.ownerDocument);
    return renderer.get_attribute(this.nodeId, name) ?? null;
  }

  /**
   * URL of the image an `<img>` element displays, mirroring `HTMLImageElement.src`.
   *
   * Assigning it reflects the `src` attribute, which is what makes quox load the image:
   * the URL is resolved against the window's `baseUrl` and fetched by Deno (see
   * `QuoxResourceLoader`), then decoded from the fetched bytes — the same byte buffer
   * `setImageData` takes. Loading is asynchronous, so the image appears on a later frame;
   * the window re-renders itself once it arrives.
   *
   * Unlike in a browser, the getter returns the attribute verbatim rather than the
   * absolutized URL, and no `load`/`error` event fires — a failed fetch is reported to the
   * console instead.
   */
  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(value: string) {
    this.setAttribute("src", value);
  }

  /** Alternative text for an `<img>` element, mirroring `HTMLImageElement.alt`. */
  get alt(): string {
    return this.getAttribute("alt") ?? "";
  }

  set alt(value: string) {
    this.setAttribute("alt", value);
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
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.set_image_data(this.nodeId, bytes);
    requestRender();
  }

  removeAttribute(name: string): void {
    const { renderer, requestRender } = documentInternals(this.ownerDocument);
    renderer.remove_attribute(this.nodeId, name);
    requestRender();
  }
}

export class QuoxText extends QuoxNode {}
