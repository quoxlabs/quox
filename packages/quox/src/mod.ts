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

function loadLibCached(path: string): QuoxLib {
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
  const os = options?.os ?? "linux-gnu";
  const cpu = options?.arch ?? arch();
  let target: string;
  switch (cpu) {
    case "x64":
      target = `x86_64-unknown-${os}`;
      break;
    case "arm64":
      target = `aarch64-unknown-${os}`;
      break;
    default:
      throw new Error(`unsupported architecture '${cpu}'`);
  }
  const libName = `libquox.so`;
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

export class QuoxWindow implements Disposable {
  private lib: QuoxLib;
  private ptr: Deno.PointerValue;
  private intervalId: number | null = null;

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
    const path = await cache(options);
    return QuoxWindow.createCached(path, html);
  }

  /**
   * Initializes the window from a cached library path.
   */
  static createCached(path: string, html: string): QuoxWindow {
    const lib = loadLibCached(path);
    return new QuoxWindow(lib, html);
  }

  /**
   * Starts the render loop, ticking into Rust every 16ms (~60fps).
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
   * Stops the render loop and frees native resources.
   */
  stop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
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
