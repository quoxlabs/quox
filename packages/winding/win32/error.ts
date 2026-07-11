/** `FormatMessageW` flags safe for arbitrary system error templates. */
export const WIN32_SYSTEM_MESSAGE_FLAGS = 0x1000 | 0x0200;

/** Attach the original numeric code even when Windows has no message for it. */
export function describeWin32Error(code: number, formatted?: string): string {
  const message = formatted?.trim();
  return message ? `${message} (${code})` : `Win32 error (${code})`;
}
