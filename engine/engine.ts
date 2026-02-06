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
type RustLib = Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

export class RustService implements Disposable {
  private lib: Deno.DynamicLibrary<typeof SYMBOLS>;
  private symbols: RustLib;
  private ptr: Deno.PointerValue;

  private callbackRef: Deno.UnsafeCallback<
    { parameters: ["i32"]; result: "void" }
  >;

  private constructor(lib: Deno.DynamicLibrary<typeof SYMBOLS>) {
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

  static init(libPath: string): RustService {
    const dylib = Deno.dlopen(libPath, SYMBOLS);
    return new RustService(dylib);
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

if (import.meta.main) {
  const libPath = "./target/release/libquox_engine.so";

  try {
    using service = RustService.init(libPath);
    service.start();
    service.send("start_processing");
    await new Promise((r) => setTimeout(r, 2000));
    service.send("reset");
    await new Promise((r) => setTimeout(r, 1000));
    service.send("end_processing");
  } catch (err) {
    console.error("Failed to run service:", err);
  }
}
