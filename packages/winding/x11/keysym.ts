/** XLookupString/Xutf8LookupString text that represents actual insertable text. */
export function normalizeCommittedText(text: string): string | undefined {
  if (text.length === 0) return undefined;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return text;
}

const CHARACTER_KEYSYMS: Readonly<Record<string, string>> = {
  space: " ",
  exclam: "!",
  quotedbl: '"',
  numbersign: "#",
  dollar: "$",
  percent: "%",
  ampersand: "&",
  apostrophe: "'",
  quoteright: "'",
  parenleft: "(",
  parenright: ")",
  asterisk: "*",
  plus: "+",
  comma: ",",
  minus: "-",
  period: ".",
  slash: "/",
  colon: ":",
  semicolon: ";",
  less: "<",
  equal: "=",
  greater: ">",
  question: "?",
  at: "@",
  bracketleft: "[",
  backslash: "\\",
  bracketright: "]",
  asciicircum: "^",
  underscore: "_",
  grave: "`",
  quoteleft: "`",
  braceleft: "{",
  bar: "|",
  braceright: "}",
  asciitilde: "~",
  KP_Space: " ",
  KP_Equal: "=",
  KP_Multiply: "*",
  KP_Add: "+",
  KP_Separator: ",",
  KP_Subtract: "-",
  KP_Decimal: ".",
  KP_Divide: "/",
};

const NAMED_KEYSYMS: Readonly<Record<string, string>> = {
  BackSpace: "Backspace",
  Tab: "Tab",
  ISO_Left_Tab: "Tab",
  Linefeed: "Enter",
  Return: "Enter",
  KP_Enter: "Enter",
  Pause: "Pause",
  Scroll_Lock: "ScrollLock",
  Sys_Req: "PrintScreen",
  Print: "PrintScreen",
  Escape: "Escape",
  Delete: "Delete",
  KP_Delete: "Delete",
  Home: "Home",
  KP_Home: "Home",
  Left: "ArrowLeft",
  KP_Left: "ArrowLeft",
  Up: "ArrowUp",
  KP_Up: "ArrowUp",
  Right: "ArrowRight",
  KP_Right: "ArrowRight",
  Down: "ArrowDown",
  KP_Down: "ArrowDown",
  Prior: "PageUp",
  KP_Prior: "PageUp",
  Next: "PageDown",
  KP_Next: "PageDown",
  End: "End",
  KP_End: "End",
  Begin: "Clear",
  KP_Begin: "Clear",
  Select: "Select",
  Execute: "Execute",
  Insert: "Insert",
  KP_Insert: "Insert",
  Undo: "Undo",
  Redo: "Redo",
  Menu: "ContextMenu",
  Find: "Find",
  Cancel: "Cancel",
  Help: "Help",
  Break: "Pause",
  Mode_switch: "AltGraph",
  ISO_Level3_Shift: "AltGraph",
  ISO_Level5_Shift: "AltGraph",
  Num_Lock: "NumLock",
  Caps_Lock: "CapsLock",
  Shift_Lock: "CapsLock",
  Shift_L: "Shift",
  Shift_R: "Shift",
  Control_L: "Control",
  Control_R: "Control",
  Alt_L: "Alt",
  Alt_R: "Alt",
  Meta_L: "Meta",
  Meta_R: "Meta",
  Super_L: "Meta",
  Super_R: "Meta",
  Hyper_L: "Hyper",
  Hyper_R: "Hyper",
  KP_Tab: "Tab",
  KP_F1: "F1",
  KP_F2: "F2",
  KP_F3: "F3",
  KP_F4: "F4",
  XF86Back: "BrowserBack",
  XF86Forward: "BrowserForward",
  XF86Refresh: "BrowserRefresh",
  XF86Stop: "BrowserStop",
  XF86Search: "BrowserSearch",
  XF86Favorites: "BrowserFavorites",
  XF86HomePage: "BrowserHome",
  XF86AudioMute: "AudioVolumeMute",
  XF86AudioLowerVolume: "AudioVolumeDown",
  XF86AudioRaiseVolume: "AudioVolumeUp",
  XF86AudioPlay: "MediaPlayPause",
  XF86AudioPause: "MediaPause",
  XF86AudioStop: "MediaStop",
  XF86AudioPrev: "MediaTrackPrevious",
  XF86AudioNext: "MediaTrackNext",
  XF86Mail: "LaunchMail",
  XF86Calculator: "LaunchCalculator",
};

/** Convert Xlib's KeySym name and lookup text to a DOM KeyboardEvent.key value. */
export function keysymToDomKey(keysymName: string | undefined, lookupText: string): string | undefined {
  const committed = normalizeCommittedText(lookupText);
  if (committed !== undefined) return committed;
  if (keysymName === undefined || keysymName.length === 0) return undefined;

  const named = NAMED_KEYSYMS[keysymName];
  if (named !== undefined) return named;
  if (keysymName.startsWith("dead_")) return "Dead";
  const character = CHARACTER_KEYSYMS[keysymName];
  if (character !== undefined) return character;

  const functionKey = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(keysymName);
  if (functionKey !== null) return functionKey[0];
  const keypadDigit = /^KP_([0-9])$/.exec(keysymName);
  if (keypadDigit !== null) return keypadDigit[1];
  if ([...keysymName].length === 1) return keysymName;
  return undefined;
}

export function utf8ByteOffset(characters: readonly string[], scalarIndex: number): number {
  if (!Number.isInteger(scalarIndex) || scalarIndex <= 0) return 0;
  return new TextEncoder().encode(characters.slice(0, scalarIndex).join("")).length;
}

/** Apply XIMPreeditDraw's scalar-indexed replacement to an in-memory preedit buffer. */
export function applyPreeditChange(
  characters: string[],
  first: number,
  length: number,
  replacement: readonly string[],
): boolean {
  if (!Number.isInteger(first) || !Number.isInteger(length) || first < 0 || length < 0) return false;
  if (first > characters.length || first + length > characters.length) return false;
  characters.splice(first, length, ...replacement);
  return true;
}
