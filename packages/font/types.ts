/** A font's family name and raw font-file bytes (TTF/OTF/WOFF/WOFF2). */
export interface FontModule {
  family: string;
  data: Uint8Array;
}
