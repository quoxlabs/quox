import { join } from "@std/path";
import { exists } from "@std/fs";
import { arch, homedir } from "node:os";

const SYMBOLS = {
  window_new: {
    parameters: ["buffer"],
    result: "pointer",
  } satisfies Deno.ForeignFunction,
  window_tick: {
    parameters: ["pointer"],
    result: "bool",
  } satisfies Deno.ForeignFunction,
  window_set_event_listener: {
    parameters: ["pointer", "pointer"],
    result: "void",
  } satisfies Deno.ForeignFunction,
  window_free: {
    parameters: ["pointer"],
    result: "void",
  } satisfies Deno.ForeignFunction,
} as const;

type QuoxLib = Deno.DynamicLibrary<typeof SYMBOLS>;

export interface LoadOptions {
  /** custom cache directory for binary files */
  cacheDir?: string;
  /** target operating system to use instead of detecting it */
  os?: "linux-gnu";
  /** target CPU architecture to use instead of detecting it */
  arch?: "x64" | "arm64";
}

export type QuoxInputEvent =
  | QuoxMouseMoveEvent
  | QuoxMouseButtonEvent
  | QuoxMouseWheelEvent
  | QuoxKeyboardEvent;
export type QuoxMouseMoveEvent = {
  type: "mousemove";
  x: number;
  y: number;
};
export type QuoxMouseButtonEvent = {
  type: "mousedown" | "mouseup";
  /** 0=left, 1=middle, 2=right */
  button: number;
};
export type QuoxMouseWheelEvent = {
  type: "wheel";
  deltaX: number;
  deltaY: number;
};
export type QuoxKeyboardEvent = {
  type: "keydown" | "keyup";
  /** Logical key name, e.g. "a", "Enter", "ArrowUp" */
  key: string;
  /** Physical key code, e.g. "KeyA", "Enter", "ArrowUp" */
  code: string;
};

function loadLocalLib(path: string): QuoxLib {
  return Deno.dlopen(path, SYMBOLS);
}

/**
 * Downloads/caches the binary
 */
async function cache(options?: LoadOptions) {
  const { url, cacheDir, cacheFile, local } = await locateCache(options);

  // If file exists, return path immediately (unless local, which is not immutable)
  if (!local && await exists(cacheFile, { isFile: true })) {
    return cacheFile;
  }

  // Ensure directory exists
  await Deno.mkdir(cacheDir, { recursive: true });

  // Download to temp file
  const tempDest = await Deno.makeTempFile({ dir: cacheDir });
  try {
    using file = await Deno.open(tempDest, { write: true });
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(
        `Could not fetch library from ${url}: ${response.statusText}`,
      );
    }
    await response.body.pipeTo(file.writable);
  } catch (err) {
    // Cleanup temp file on failure
    await Deno.remove(tempDest).catch(() => {});
    throw err;
  }

  // Atomic move
  await Deno.rename(tempDest, cacheFile);
  return cacheFile;
}
async function locateCache(options?: LoadOptions) {
  const detectedOS = Deno.build.os;
  const os = options?.os ?? (detectedOS === "darwin" ? "apple-darwin" : "linux-gnu");
  const cpu = options?.arch ?? arch();
  let target: string;
  switch (cpu) {
    case "x64":
      target = os === "apple-darwin" ? `x86_64-apple-darwin` : `x86_64-unknown-${os}`;
      break;
    case "arm64":
      target = os === "apple-darwin" ? `aarch64-apple-darwin` : `aarch64-unknown-${os}`;
      break;
    default:
      throw new Error(`unsupported architecture '${cpu}'`);
  }
  const libName = os === "apple-darwin" ? "libquox.dylib" : "libquox.so";
  const libUrl = new URL(
    `../target/${target}/release/${libName}`,
    import.meta.url,
  );
  const url = libUrl.href;
  const libUrlBytes = new TextEncoder().encode(url);
  const libUrlHash = await crypto.subtle.digest("SHA-1", libUrlBytes);
  const libUrlHex = new Uint8Array(libUrlHash).toHex();
  const cacheDir = options?.cacheDir ??
    join(homedir(), ".cache", "quox", libUrlHex);
  const cacheFile = join(cacheDir, libName);
  return { url, cacheDir, cacheFile, local: libUrl.protocol === "file:" };
}

type EventListenerCallbackDef = {
  readonly parameters: readonly ["pointer"];
  readonly result: "void";
};

export class QuoxWindow implements Disposable {
  private readonly lib: QuoxLib;
  private ptr: Deno.PointerValue;
  private intervalId: number | null = null;
  private windowEventListenerRef:
    | Deno.UnsafeCallback<EventListenerCallbackDef>
    | null = null;
  private readonly windowEventListeners: Array<
    (event: QuoxInputEvent) => void
  > = [];

  private constructor(lib: QuoxLib, html: string) {
    this.lib = lib;
    const buffer = new TextEncoder().encode(html + "\0");
    this.ptr = lib.symbols.window_new(buffer);
    if (!this.ptr) {
      lib.close();
      throw new Error("Failed to create native window");
    }
  }

  /**
   * Initializes the window, ensuring the library is loaded/cached.
   */
  static async create(
    html: string,
    options?: LoadOptions,
  ): Promise<QuoxWindow> {
    const libOverride = Deno.env.get("LIBQUOX_PATH");
    const path = libOverride ?? await (async () => {
      const cachedPath = await cache(options);
      return cachedPath;
    })();
    return QuoxWindow.createLib(path, html);
  }

  /**
   * Initializes the window from a cached library path.
   */
  static createLib(path: string, html: string): QuoxWindow {
    const lib = loadLocalLib(path);
    return new QuoxWindow(lib, html);
  }

  /**
   * Starts the render loop and input handling loop.
   */
  start() {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      const ptr = this.ptr;
      if (!ptr) return;
      const running = this.lib.symbols.window_tick(ptr);
      if (!running) this.stop();
    }, 16);
  }

  /**
   * Register a callback that is invoked for every input event (mouse and
   * keyboard) that occurs during a tick.
   */
  addEventListener(callback: (event: QuoxInputEvent) => void) {
    this.windowEventListeners.push(callback);
    if (this.windowEventListenerRef === null) {
      const nativeCb = new Deno.UnsafeCallback<EventListenerCallbackDef>(
        { parameters: ["pointer"], result: "void" } as const,
        (ptr: Deno.PointerValue) => {
          if (!ptr) return;
          const view = new Deno.UnsafePointerView(ptr as Deno.PointerObject);
          let ev: QuoxInputEvent;
          try {
            ev = JSON.parse(view.getCString()); // implicit type case
          } catch {
            // ignore malformed JSON (should never happen in practice)
          }
          this.windowEventListeners.forEach((cb) => cb(ev));
        },
      );
      this.windowEventListenerRef = nativeCb;
      if (this.ptr) {
        this.lib.symbols.window_set_event_listener(this.ptr, nativeCb.pointer);
      }
    }
  }

  /**
   * Removes a callback that was previously registered via
   * {@link QuoxWindow.addEventListener}.
   */
  removeEventListener(callback: (event: QuoxInputEvent) => void) {
    const index = this.windowEventListeners.indexOf(callback);
    if (index >= 0) this.windowEventListeners.splice(index, 1);
    if (
      this.windowEventListeners.length === 0 &&
      this.windowEventListenerRef !== null
    ) {
      this.windowEventListenerRef.close();
      this.windowEventListenerRef = null;
    }
  }

  /**
   * Stops the render loop and frees native resources.
   */
  stop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.windowEventListenerRef !== null) {
      this.windowEventListenerRef.close();
      this.windowEventListenerRef = null;
    }
    if (this.ptr) {
      this.lib.symbols.window_free(this.ptr);
      this.ptr = null;
    }
  }

  [Symbol.dispose]() {
    this.stop();
    this.lib.close();
  }
}

export async function renderRawHTML(
  html: string,
  options?: LoadOptions,
): Promise<QuoxWindow> {
  const window = await QuoxWindow.create(html, options);
  window.start();
  return window;
}

if (import.meta.main) {
  console.log(await cache());
}
