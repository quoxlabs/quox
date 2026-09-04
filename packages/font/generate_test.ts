import { assertEquals, assertThrows } from "@std/assert";
import { readFamilyName } from "./generate.ts";

interface NameRecord {
  platformId: number;
  nameId: number;
  value: string;
}

function encodeUtf16BE(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), false);
  return bytes;
}

/**
 * Build a minimal sfnt buffer containing only a `name` table, so
 * `readFamilyName`'s table-directory and name-record parsing can be
 * exercised without needing a real font file on disk.
 */
function sfntWithNameTable(records: NameRecord[]): Uint8Array {
  const encoded = records.map(({ platformId, value }) =>
    platformId === 1 ? Uint8Array.from(value, (c) => c.charCodeAt(0)) : encodeUtf16BE(value)
  );

  const headerSize = 6;
  const recordsSize = records.length * 12;
  let stringAreaOffset = 0;
  const stringOffsets = encoded.map((bytes) => {
    const offset = stringAreaOffset;
    stringAreaOffset += bytes.length;
    return offset;
  });
  const nameTableSize = headerSize + recordsSize + stringAreaOffset;

  const sfntHeaderSize = 12;
  const tableDirSize = 16;
  const nameTableOffset = sfntHeaderSize + tableDirSize;
  const buffer = new Uint8Array(nameTableOffset + nameTableSize);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x00010000, false); // sfnt version
  view.setUint16(4, 1, false); // numTables
  buffer.set(new TextEncoder().encode("name"), sfntHeaderSize);
  view.setUint32(sfntHeaderSize + 8, nameTableOffset, false);
  view.setUint32(sfntHeaderSize + 12, nameTableSize, false);

  view.setUint16(nameTableOffset, 0, false); // format
  view.setUint16(nameTableOffset + 2, records.length, false);
  view.setUint16(nameTableOffset + 4, headerSize + recordsSize, false);

  records.forEach(({ platformId, nameId }, i) => {
    const recordStart = nameTableOffset + headerSize + i * 12;
    view.setUint16(recordStart, platformId, false);
    view.setUint16(recordStart + 2, platformId === 1 ? 0 : 1, false); // encodingId
    view.setUint16(recordStart + 4, 0, false); // languageId
    view.setUint16(recordStart + 6, nameId, false);
    view.setUint16(recordStart + 8, encoded[i].length, false);
    view.setUint16(recordStart + 10, stringOffsets[i], false);
  });

  const stringAreaStart = nameTableOffset + headerSize + recordsSize;
  encoded.forEach((bytes, i) => buffer.set(bytes, stringAreaStart + stringOffsets[i]));

  return buffer;
}

Deno.test("readFamilyName prefers the Typographic Family (nameID 16) over Family (nameID 1)", () => {
  const font = sfntWithNameTable([
    { platformId: 3, nameId: 1, value: "Example" },
    { platformId: 3, nameId: 16, value: "Example Text" },
  ]);
  assertEquals(readFamilyName(font), "Example Text");
});

Deno.test("readFamilyName falls back to Family (nameID 1) when nameID 16 is absent", () => {
  const font = sfntWithNameTable([{ platformId: 3, nameId: 1, value: "Example" }]);
  assertEquals(readFamilyName(font), "Example");
});

Deno.test("readFamilyName decodes Macintosh (platform 1) records", () => {
  const font = sfntWithNameTable([{ platformId: 1, nameId: 1, value: "Example" }]);
  assertEquals(readFamilyName(font), "Example");
});

Deno.test("readFamilyName rejects bytes with no sfnt `name` table", () => {
  assertThrows(() => readFamilyName(new Uint8Array(32)));
});

Deno.test("readFamilyName rejects a `name` table with neither nameID 1 nor 16", () => {
  const font = sfntWithNameTable([{ platformId: 3, nameId: 2, value: "Regular" }]);
  assertThrows(() => readFamilyName(font));
});
