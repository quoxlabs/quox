import { load } from "./mod.ts";

if (Deno.build.os === "darwin") {
  Deno.test("Darwin rejects AppKit initialization from a Deno test worker", () => {
    let error: unknown;
    try {
      load();
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error) || !error.message.includes("process main thread")) {
      throw new Error(`expected a deterministic main-thread error, got ${String(error)}`);
    }
  });
}
