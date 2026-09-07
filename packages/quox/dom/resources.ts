import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";

/**
 * The subset of `fetch` the resource loader needs. Deno's global `fetch` satisfies it as-is;
 * the indirection exists so tests can substitute their own.
 */
export type QuoxResourceFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetches the resources a quox document asks for.
 *
 * The renderer never touches the network: when the document references a resource — an
 * `<img src>`, a `<link rel=stylesheet>`, a font or image named by CSS — it queues the
 * resolved URL and waits. This loader drains that queue, fetches each URL with Deno's
 * `fetch` (so every request goes through Deno's permission sandbox, and needs `--allow-net`
 * for remote URLs), holds the response in memory, and hands the bytes back to the renderer
 * as a byte buffer. Those are the same bytes `QuoxElement.setImageData` takes for an image
 * the caller loaded itself; only the source differs.
 *
 * Requests are answered even when they fail, so the document stops waiting on a URL it will
 * never get — and a later reference to that URL is fetched afresh rather than joining a
 * request that already ended.
 */
export class QuoxResourceLoader {
  readonly #renderer: WasmRenderer;
  readonly #requestRender: () => void;
  readonly #fetch: QuoxResourceFetch;
  readonly #abort = new AbortController();
  #closed = false;

  constructor(
    renderer: WasmRenderer,
    requestRender: () => void,
    fetchResource: QuoxResourceFetch = (url, init) => fetch(url, init),
  ) {
    this.#renderer = renderer;
    this.#requestRender = requestRender;
    this.#fetch = fetchResource;
  }

  /**
   * Start a fetch for every resource the document has requested since the last call.
   *
   * Each URL is queued by the renderer only once while its request is outstanding, so
   * pumping repeatedly (as the window's event loop does) never refetches anything.
   */
  pump(): void {
    if (this.#closed) return;

    for (const url of this.#renderer.take_resource_requests()) {
      void this.#load(url);
    }
  }

  /** Stop fetching: abort in-flight requests and ignore anything still to arrive. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
  }

  async #load(url: string): Promise<void> {
    let bytes: Uint8Array | undefined;

    try {
      const response = await this.#fetch(url, { signal: this.#abort.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      // Aborted by `close()`: the document is going away, so there is nothing to answer.
      if (this.#closed) return;

      // A browser fires an `error` event at the element that referenced the resource. The
      // renderer tracks resources by URL and never reports which nodes were waiting on one,
      // so quox has no element to fire at — report the failure here instead.
      console.error(`Quox resource fetch failed: ${url}`, error);
    }

    this.#answer(url, bytes);
  }

  /** Hand the result to the document. Undefined `bytes` reports a fetch that failed. */
  #answer(url: string, bytes: Uint8Array | undefined): void {
    if (this.#closed) return;

    const needsRender = bytes === undefined
      ? this.#renderer.fail_resource_request(url)
      : this.#renderer.resolve_resource_request(url, bytes);
    if (needsRender) this.#requestRender();
  }
}
