import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { type QuoxResourceFetch, QuoxResourceLoader } from "./resources.ts";

// `QuoxResourceFetch` exists so the loader can default to Deno's global `fetch` while still
// accepting a substitute.

/** The global `fetch` — the loader's own default — has to satisfy the type as-is. */
const _globalFetchSatisfies: QuoxResourceFetch = fetch;

/** A substitute may ignore arguments it doesn't need, and narrow the ones it takes. */
const _narrowSubstituteSatisfies: QuoxResourceFetch = (url: string) => Promise.resolve(new Response(url));

/** But it has to be awaitable: the loader awaits the response before reading its body. */
// @ts-expect-error a fetch returning a bare Response does not satisfy QuoxResourceFetch
const _synchronousSubstituteIsRejected: QuoxResourceFetch = (url: string) => new Response(url);

/** And it has to accept the URL the loader passes it, which is always a string. */
// @ts-expect-error a fetch demanding a URL object does not satisfy QuoxResourceFetch
const _urlObjectSubstituteIsRejected: QuoxResourceFetch = (url: URL) => Promise.resolve(new Response(url.href));

/** What the loader handed back for a URL: the fetched bytes, or `null` for a failure. */
type Answer = { url: string; bytes: Uint8Array | null };

class FakeRenderer {
  readonly answers: Answer[] = [];
  #queued: string[] = [];

  /** Queue URLs the way the renderer does when the document references a resource. */
  queueRequests(...urls: string[]): void {
    this.#queued.push(...urls);
  }

  take_resource_requests(): string[] {
    return this.#queued.splice(0);
  }

  resolve_resource_request(url: string, bytes: Uint8Array): boolean {
    this.answers.push({ url, bytes });
    return true;
  }

  fail_resource_request(url: string): boolean {
    this.answers.push({ url, bytes: null });
    return true;
  }
}

function createLoader(fetchResource: QuoxResourceFetch): {
  loader: QuoxResourceLoader;
  renderer: FakeRenderer;
  renderCount: () => number;
} {
  const renderer = new FakeRenderer();
  let renders = 0;

  return {
    loader: new QuoxResourceLoader(
      renderer as unknown as WasmRenderer,
      () => {
        renders += 1;
      },
      fetchResource,
    ),
    renderer,
    renderCount: () => renders,
  };
}

/** Let the loader's fetches settle — `pump` starts them without exposing their promises. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Capture what the loader reports about failed fetches, keeping test output clean. */
async function withCapturedErrors(run: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };

  try {
    await run();
  } finally {
    console.error = original;
  }

  return messages;
}

Deno.test("pump fetches every queued resource and hands back its bytes", async () => {
  const bodies = new Map([
    ["https://cdn.test/a.png", new Uint8Array([1, 2, 3])],
    ["https://cdn.test/b.png", new Uint8Array([4, 5])],
  ]);
  const requested: string[] = [];
  const { loader, renderer, renderCount } = createLoader((url) => {
    requested.push(url);
    return Promise.resolve(new Response(bodies.get(url)));
  });

  renderer.queueRequests("https://cdn.test/a.png", "https://cdn.test/b.png");
  loader.pump();
  await settle();

  assertEquals(requested, ["https://cdn.test/a.png", "https://cdn.test/b.png"]);
  assertEquals(renderer.answers, [
    { url: "https://cdn.test/a.png", bytes: new Uint8Array([1, 2, 3]) },
    { url: "https://cdn.test/b.png", bytes: new Uint8Array([4, 5]) },
  ]);
  assertEquals(renderCount(), 2);
});

Deno.test("a loader given no substitute fetches through the global fetch", async () => {
  const renderer = new FakeRenderer();
  const loader = new QuoxResourceLoader(renderer as unknown as WasmRenderer, () => {});
  renderer.queueRequests("https://cdn.test/a.png");

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response(new Uint8Array([7])));
  }) as typeof fetch;

  try {
    loader.pump();
    await settle();
  } finally {
    globalThis.fetch = original;
  }

  // Resolved per call rather than captured when the loader was built, so a runtime that
  // replaces the global — as this test does — is the one that gets used.
  assertEquals(calls.map((call) => call.url), ["https://cdn.test/a.png"]);
  assert(calls[0].init.signal instanceof AbortSignal, "the loader passes its abort signal along");
  assertEquals(renderer.answers, [{ url: "https://cdn.test/a.png", bytes: new Uint8Array([7]) }]);
});

Deno.test("pump does nothing when the document is waiting on nothing", async () => {
  let fetches = 0;
  const { loader, renderer, renderCount } = createLoader(() => {
    fetches += 1;
    return Promise.resolve(new Response(new Uint8Array()));
  });

  loader.pump();
  await settle();

  assertEquals(fetches, 0);
  assertEquals(renderer.answers, []);
  assertEquals(renderCount(), 0);
});

Deno.test("an error response is answered as a failed fetch so the document stops waiting", async () => {
  const { loader, renderer } = createLoader(() => Promise.resolve(new Response("nope", { status: 404 })));
  renderer.queueRequests("https://cdn.test/missing.png");

  const errors = await withCapturedErrors(async () => {
    loader.pump();
    await settle();
  });

  assertEquals(renderer.answers, [{ url: "https://cdn.test/missing.png", bytes: null }]);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "https://cdn.test/missing.png");
  assertStringIncludes(errors[0], "404");
});

Deno.test("an unreachable resource is answered as a failed fetch", async () => {
  const { loader, renderer } = createLoader(() => Promise.reject(new TypeError("connection refused")));
  renderer.queueRequests("https://offline.test/a.png");

  const errors = await withCapturedErrors(async () => {
    loader.pump();
    await settle();
  });

  assertEquals(renderer.answers, [{ url: "https://offline.test/a.png", bytes: null }]);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "connection refused");
});

Deno.test("close aborts in-flight fetches and never touches the renderer again", async () => {
  let aborted = false;
  const { loader, renderer, renderCount } = createLoader((_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The signal has been aborted", "AbortError"));
      });
    })
  );

  renderer.queueRequests("https://cdn.test/slow.png");
  loader.pump();

  const errors = await withCapturedErrors(async () => {
    loader.close();
    await settle();
  });

  assert(aborted, "closing the loader should abort the request it started");
  assertEquals(renderer.answers, []);
  assertEquals(renderCount(), 0);
  assertEquals(errors, []);
});

Deno.test("a closed loader stops pumping", async () => {
  let fetches = 0;
  const { loader, renderer } = createLoader(() => {
    fetches += 1;
    return Promise.resolve(new Response(new Uint8Array()));
  });

  renderer.queueRequests("https://cdn.test/a.png");
  loader.close();
  loader.pump();
  await settle();

  assertEquals(fetches, 0);
  assertEquals(renderer.answers, []);
});
