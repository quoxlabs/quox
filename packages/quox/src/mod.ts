import { join } from "@std/path";
import { exists } from "@std/fs";
import { arch, homedir } from "node:os";

const SYMBOLS = {
  app_new: {
    parameters: [],
    result: "pointer",
  },
  app_start_work: {
    parameters: ["pointer", "function"],
    result: "void",
  },
  app_send_cmd: {
    parameters: ["pointer", "buffer"],
    result: "void",
  },
  app_free: {
    parameters: ["pointer"],
    result: "void",
  },
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

async function loadLib(): Promise<QuoxLib> {
  const libPath = await cache();
  return Deno.dlopen(libPath, SYMBOLS);
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

export class RustService implements Disposable {
  private lib: QuoxLib;
  private symbols: QuoxLib["symbols"];
  private ptr: Deno.PointerValue;

  private callbackRef: Deno.UnsafeCallback<
    { parameters: ["i32"]; result: "void" }
  >;

  // Changed constructor to public/private pattern used in engine.ts,
  // but updated to take the loaded library instance.
  private constructor(lib: QuoxLib) {
    this.lib = lib;
    this.symbols = lib.symbols;

    this.ptr = this.symbols.app_new();
    if (!this.ptr) {
      throw new Error("Failed to allocate Rust state");
    }

    this.callbackRef = new Deno.UnsafeCallback(
      { parameters: ["i32"], result: "void" },
      (val: number) => {
        this.onEvent(val);
      },
    );

    this.callbackRef.ref();
  }

  /**
   * Initializes the service, ensuring the library is loaded/cached.
   */
  static async init(): Promise<RustService> {
    const lib = await loadLib();
    return new RustService(lib);
  }

  /**
   * Kicks off the background Tokio task.
   */
  start() {
    this.assertAlive();
    this.symbols.app_start_work(this.ptr, this.callbackRef.pointer);
  }

  /**
   * Sends a string command to the Rust Tokio loop.
   */
  send(command: string) {
    this.assertAlive();
    const buffer = new TextEncoder().encode(command + "\0");
    this.symbols.app_send_cmd(this.ptr, buffer);
  }

  /**
   * Internal handler for events coming FROM Rust.
   */
  private onEvent(val: number) {
    console.log(`[Deno] Received event from Rust: ${val}`);
  }

  private assertAlive() {
    if (!this.ptr) throw new Error("RustService has been disposed");
  }

  [Symbol.dispose]() {
    if (this.ptr) {
      this.symbols.app_free(this.ptr);
      this.ptr = null;
    }
    this.callbackRef.close();
    this.lib.close();
  }
}

export async function renderRawHTML(html: string): Promise<RustService> {
  const service = await RustService.init();
  service.start();
  service.send(html);
  return service;
}

if (import.meta.main) {
  console.log(await cache());
}
