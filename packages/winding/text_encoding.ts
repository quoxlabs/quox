/** Encode a string as null-terminated UTF-8 bytes, suitable for C-string FFI parameters. */
export function utf8CString(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${s}\0`);
}

/** Encode a string as UTF-8 bytes without a null terminator, for length-prefixed FFI parameters. */
export function utf8Bytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}
