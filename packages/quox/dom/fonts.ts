/** A loaded font's family name and raw font-file bytes (TTF/OTF/WOFF/WOFF2). */
export interface FontModule {
  family: string;
  data: Uint8Array;
}

/**
 * Anything `loadFonts` accepts for a single font:
 *
 * - a built-in id (see {@link BUILTIN_FONT_IDS}), e.g. `"liberation-sans"`
 * - raw font bytes, e.g. from `Deno.readFile(...)` — any font, no family override
 * - a `FontModule` object
 * - a dynamic import of a module with a default-exported `FontModule`, e.g.
 *   `import("jsr:@quoxlabs/font/liberation-serif")`
 */
export type FontSource =
  | string
  | Uint8Array
  | FontModule
  | Promise<FontModule | { default: FontModule }>;

const BUILTIN_FONTS: Record<string, () => Promise<{ default: FontModule }>> = {
  "liberation-sans": () => import("jsr:@quoxlabs/font@0.0.1/liberation-sans"),
  "liberation-serif": () => import("jsr:@quoxlabs/font@0.0.1/liberation-serif"),
  "liberation-mono": () => import("jsr:@quoxlabs/font@0.0.1/liberation-mono"),
};

/** The built-in font ids accepted as a plain string by {@link FontSource}. */
export const BUILTIN_FONT_IDS: readonly string[] = Object.keys(BUILTIN_FONTS);

/** The fonts a new window loads automatically, unless overridden via `WindowOptions.fonts`. */
export const DEFAULT_FONTS: readonly FontSource[] = ["liberation-sans"];

/** Resolve a {@link FontSource} down to its bytes and (if known) family name. */
export async function resolveFontSource(
  source: FontSource,
): Promise<{ family?: string; bytes: Uint8Array }> {
  let resolved: Uint8Array | FontModule | { default: FontModule };
  if (typeof source === "string") {
    const load = BUILTIN_FONTS[source];
    if (!load) {
      throw new RangeError(
        `Unknown built-in font: "${source}" (available: ${BUILTIN_FONT_IDS.join(", ")})`,
      );
    }
    resolved = await load();
  } else if (source instanceof Promise) {
    resolved = await source;
  } else {
    resolved = source;
  }

  if (resolved instanceof Uint8Array) return { bytes: resolved };
  const fontModule = "default" in resolved ? resolved.default : resolved;
  return { family: fontModule.family, bytes: fontModule.data };
}
