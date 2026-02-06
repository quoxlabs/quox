import * as path from "@std/path";
import { Buffer } from "node:buffer";
import os from "node:os";

// We just support Linux for now
const RUST_TARGET = "x86_64-unknown-linux-gnu";
const RUST_LIB = "libquox.so";

interface RenderRawHTML {
  (buffer: BufferSource, len: bigint): void;
}

const CACHE_DIR = Deno.env.get("CACHE_DIR") ??
  path.join(os.homedir(), ".cache");

/** Recursivle create a directory, if it does not exist. */
async function createDirIfNotExists(directory: string) {
  try {
    await Deno.lstat(directory);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
    await Deno.mkdir(directory, { recursive: true });
  }
}

/** Extract package name and version from JSON file. */
async function getManifest(
  jsonFile: Promise<{ default: { name: string; version: string } }>,
): Promise<{ name: string; version: string }> {
  const { default: manifest } = await jsonFile;

  if (!("name" in manifest) || typeof manifest.name !== "string") {
    throw new Error("Could not determine version, missing 'name' in JSON file");
  }
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error(
      "Could not determine version, missing 'version' in JSON file",
    );
  }

  const { name, version } = manifest;
  return { name, version };
}

/**
 * Downloads a file using the fetch API into a temporary directory and moves it to the destination.
 * @param tmpDirectory - required as temporary download location
 * @param fileDestination - final destination of the file
 * @param sourceURL - file web URL
 * @returns
 */
async function cacheFile(
  tmpDirectory: string,
  fileDestination: string,
  sourceURL: string,
): Promise<void> {
  try {
    await Deno.lstat(fileDestination);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const tempDest = await Deno.makeTempFile({ dir: tmpDirectory });
  {
    await using tempFile = await Deno.open(tempDest, { write: true });
    const response = await fetch(sourceURL);
    if (response.body === null) throw new Error("Could not fetch file");
    await response.body.pipeTo(tempFile.writable);
  }

  await Deno.rename(tempDest, fileDestination);
}

async function load(): Promise<RenderRawHTML> {
  await createDirIfNotExists(CACHE_DIR);

  const { name, version } = await getManifest(
    import("../deno.json", {
      with: { type: "json" },
    }),
  );
  const source =
    `https://jsr.io/${name}/${version}/target/${RUST_TARGET}/release/${RUST_LIB}`;
  const destDir = path.join(CACHE_DIR, name, version);
  const destFile = path.join(destDir, RUST_LIB);

  await createDirIfNotExists(destDir);
  await cacheFile(CACHE_DIR, destFile, source);

  const { symbols } = Deno.dlopen(
    destFile,
    {
      render_raw_html: {
        parameters: ["buffer", "usize"],
        result: "void",
      },
    },
  );
  return symbols.render_raw_html;
}

let cache: RenderRawHTML | null = null;
async function loadLib() {
  if (!cache) {
    cache = await load();
  }
}

export async function renderRawHTML(html: string): Promise<void> {
  if (!cache) {
    await loadLib();
    if (!cache) {
      throw new Error("Library could not be loaded!");
    }
  }

  const htmlBuffer = Buffer.from(html, "utf-8");
  return cache(htmlBuffer, BigInt(htmlBuffer.length));
}
