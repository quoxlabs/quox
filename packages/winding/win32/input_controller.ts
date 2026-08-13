/** Native Win32 keyboard and committed-text controller. */

import type { KeyEvent, UIEvent, Window } from "../types.ts";
import { createKeyDownEvent, createKeyUpEvent, createTextInputEvent } from "../input/mod.ts";
import { PressedLogicalKeyCache } from "../input/pressed_keys.ts";
import { getDomCode } from "./dom_code.ts";
import { PM_NOREMOVE, TU_NO_STATE_CHANGE, UNICODE_NOCHAR, type user32functions, WM } from "./ffi.ts";
import {
  AltGraphControlFilter,
  decodeKeyLParam,
  isCommitText,
  keyboardModifiers,
  logicalKeyFromVirtualKey,
  repeatedWmCharText,
  type ToUnicodeAdapter,
  translateLogicalKey,
  VK,
  win32KeyEditDisposition,
  win32KeyIdentity,
  WmCharDecoder,
} from "./input.ts";

export interface Win32InputWindow extends Window {
  readonly id: bigint;
  readonly hwnd: Deno.PointerObject;
}

interface WindowInputState {
  readonly logicalKeys: PressedLogicalKeyCache<string>;
  readonly altGraphControlFilter: AltGraphControlFilter;
  readonly charDecoder: WmCharDecoder;
}

interface PreparedKeyEvent {
  event: KeyEvent;
  suppress: boolean;
}

interface NativeKeyMessage {
  windowId: bigint;
  message: number;
  virtualKey: number;
  lParam: bigint;
  timestamp: number;
}

type User32Library = Deno.DynamicLibrary<typeof user32functions>;

/** Owns all mutable native-input state for Win32 windows. */
export class Win32InputController {
  readonly #states = new Map<Win32InputWindow, WindowInputState>();
  readonly #altGraphLayouts = new Map<bigint, boolean>();
  readonly #peekMessage = new ArrayBuffer(48);
  readonly #user32: User32Library;
  readonly #enqueue: (event: UIEvent) => void;
  readonly #windowById: (id: bigint) => Win32InputWindow | undefined;
  #preparedKey: PreparedKeyEvent | undefined;
  #pendingText: UIEvent[] = [];

  constructor(
    user32: User32Library,
    enqueue: (event: UIEvent) => void,
    windowById: (id: bigint) => Win32InputWindow | undefined,
  ) {
    this.#user32 = user32;
    this.#enqueue = enqueue;
    this.#windowById = windowById;
  }

  attach(window: Win32InputWindow): void {
    if (this.#states.has(window)) return;
    const state: WindowInputState = {
      logicalKeys: new PressedLogicalKeyCache<string>(),
      altGraphControlFilter: new AltGraphControlFilter(),
      charDecoder: new WmCharDecoder(),
    };
    this.#states.set(window, state);
  }

  detach(window: Win32InputWindow): void {
    const state = this.#states.get(window);
    if (state === undefined) return;
    state.charDecoder.reset();
    state.logicalKeys.clear();
    state.altGraphControlFilter.reset();
    this.#states.delete(window);
  }

  /** Process input-owned WndProc messages; undefined means continue with DefWindowProcW. */
  handleMessage(
    window: Win32InputWindow | undefined,
    message: number,
    wParam: number | bigint,
    lParam: number | bigint,
  ): bigint | undefined {
    const state = window === undefined ? undefined : this.#states.get(window);
    switch (message) {
      case WM.SETFOCUS:
        if (window !== undefined && state !== undefined) {
          this.#enqueue({ type: "focus", window });
        }
        return undefined;
      case WM.KILLFOCUS:
        if (window !== undefined && state !== undefined) {
          state.logicalKeys.clear();
          state.altGraphControlFilter.reset();
          this.#enqueue({ type: "blur", window });
        }
        return undefined;
      case WM.KEYDOWN:
      case WM.SYSKEYDOWN: {
        const prepared = this.#takePreparedKey(
          window,
          "keydown",
          wParam,
          lParam,
          message === WM.SYSKEYDOWN,
        );
        if (prepared !== undefined && !prepared.suppress) this.#enqueue(prepared.event);
        this.#flushPendingText();
        return undefined;
      }
      case WM.KEYUP:
      case WM.SYSKEYUP: {
        const prepared = this.#takePreparedKey(window, "keyup", wParam, lParam, message === WM.SYSKEYUP);
        if (prepared !== undefined && !prepared.suppress) this.#enqueue(prepared.event);
        return undefined;
      }
      case WM.CHAR:
        if (window !== undefined && state !== undefined) {
          this.#handleChar(window, state, wParam, lParam);
          return 0n;
        }
        return undefined;
      case WM.DEADCHAR:
        return 0n;
      case WM.SYSCHAR:
        if (window !== undefined && state !== undefined && this.#currentModifiers().altGraphKey) {
          this.#handleChar(window, state, wParam, lParam);
          return 0n;
        }
        return undefined;
      case WM.SYSDEADCHAR:
        if (window !== undefined && state !== undefined && this.#currentModifiers().altGraphKey) {
          return 0n;
        }
        return undefined;
      case WM.UNICHAR:
        if (Number(wParam) === UNICODE_NOCHAR) return 1n;
        if (window !== undefined && state !== undefined) {
          this.#flushCharDecoder(window, state);
          this.#handleUniChar(window, Number(wParam), lParam);
          return 0n;
        }
        return undefined;
      case WM.INPUTLANGCHANGE:
        this.#altGraphLayouts.clear();
        for (const [inputWindow, inputState] of this.#states) {
          this.#flushCharDecoder(inputWindow, inputState);
          inputState.altGraphControlFilter.reset();
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /** Prepare the next queued key before TranslateMessage can synchronously emit WM_CHAR. */
  prepareKeyMessage(buffer: ArrayBuffer): void {
    this.#preparedKey = undefined;
    const message = this.#keyMessageFromBuffer(buffer);
    if (message === undefined) return;
    const window = this.#windowById(message.windowId);
    if (window === undefined) return;
    const state = this.#states.get(window);
    if (state === undefined) return;

    const type = message.message === WM.KEYDOWN || message.message === WM.SYSKEYDOWN ? "keydown" : "keyup";
    const keyboardState = this.#snapshotKeyboardState();
    const layout = this.#user32.symbols.GetKeyboardLayout(0);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const modifiers = keyboardModifiers(keyboardState);
    modifiers.altGraphKey = layoutHasAltGraph && modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;

    const code = getDomCode(message.lParam);
    let key = logicalKeyFromVirtualKey(message.virtualKey);
    let translatedText: string | undefined;
    if (type === "keydown") {
      const stateForTranslation = Uint8Array.from(keyboardState);
      if (!layoutHasAltGraph) stateForTranslation[VK.RMENU] &= 0x7f;
      const translated = translateLogicalKey(
        message.virtualKey,
        message.lParam,
        stateForTranslation,
        this.#toUnicodeAdapter(layout),
      );
      key = translated.key;
      translatedText = translated.text;
    }
    if (code === "AltRight") key = modifiers.altGraphKey && layoutHasAltGraph ? "AltGraph" : "Alt";

    const identity = win32KeyIdentity(message.virtualKey, message.lParam);
    if (type === "keydown") {
      key = state.logicalKeys.press(identity, key);
    } else {
      key = state.logicalKeys.release(identity, key);
    }

    const current = {
      phase: type === "keydown" ? "down" as const : "up" as const,
      virtualKey: message.virtualKey,
      lParam: message.lParam,
      timestamp: message.timestamp,
    };
    const nextMessage = type === "keydown" ? this.#peekNextKeyMessage() : undefined;
    const next = nextMessage === undefined || nextMessage.windowId !== message.windowId ? undefined : {
      phase: nextMessage.message === WM.KEYDOWN || nextMessage.message === WM.SYSKEYDOWN
        ? "down" as const
        : "up" as const,
      virtualKey: nextMessage.virtualKey,
      lParam: nextMessage.lParam,
      timestamp: nextMessage.timestamp,
    };
    this.#preparedKey = {
      suppress: layoutHasAltGraph && state.altGraphControlFilter.shouldSuppress(current, next),
      event: createWin32KeyEvent(
        type,
        window,
        message.virtualKey,
        code,
        key,
        type === "keydown" && decodeKeyLParam(message.lParam).isRepeat,
        modifiers,
        translatedText,
        message.message === WM.SYSKEYDOWN,
      ),
    };
  }

  clearPreparedKey(): void {
    this.#preparedKey = undefined;
    this.#flushPendingText();
  }

  close(): void {
    this.#preparedKey = undefined;
    this.#pendingText = [];
    this.#altGraphLayouts.clear();
    for (const state of this.#states.values()) {
      state.charDecoder.reset();
      state.logicalKeys.clear();
      state.altGraphControlFilter.reset();
    }
    this.#states.clear();
  }

  #snapshotKeyboardState(): Uint8Array<ArrayBuffer> {
    const state = new Uint8Array(256) as Uint8Array<ArrayBuffer>;
    if (this.#user32.symbols.GetKeyboardState(state)) return state;
    for (
      const virtualKey of [
        VK.SHIFT,
        VK.CONTROL,
        VK.MENU,
        VK.CAPITAL,
        VK.LSHIFT,
        VK.RSHIFT,
        VK.LCONTROL,
        VK.RCONTROL,
        VK.LMENU,
        VK.RMENU,
        VK.LWIN,
        VK.RWIN,
      ]
    ) {
      const keyState = this.#user32.symbols.GetKeyState(virtualKey);
      if ((keyState & 0x8000) !== 0) state[virtualKey] |= 0x80;
      if ((keyState & 0x0001) !== 0) state[virtualKey] |= 0x01;
    }
    return state;
  }

  #currentModifiers() {
    const modifiers = keyboardModifiers(this.#snapshotKeyboardState());
    modifiers.altGraphKey = this.#layoutHasAltGraph(this.#user32.symbols.GetKeyboardLayout(0)) &&
      modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    return modifiers;
  }

  #toUnicodeAdapter(layout: Deno.PointerValue): ToUnicodeAdapter {
    return {
      toUnicode: (virtualKey, scanCode, keyboardState, flags) => {
        const output = new Uint16Array(16) as Uint16Array<ArrayBuffer>;
        const result = this.#user32.symbols.ToUnicodeEx(
          virtualKey,
          scanCode,
          keyboardState,
          output,
          output.length,
          flags,
          layout,
        );
        const unitsWritten = result === 0 ? 0 : Math.min(output.length, Math.max(1, Math.abs(result)));
        let text = "";
        for (let index = 0; index < unitsWritten; index++) text += String.fromCharCode(output[index]);
        return { result, text };
      },
    };
  }

  #layoutHasAltGraph(layout: Deno.PointerValue): boolean {
    if (layout === null) return false;
    const layoutId = BigInt(Deno.UnsafePointer.value(layout));
    const cached = this.#altGraphLayouts.get(layoutId);
    if (cached !== undefined) return cached;

    const adapter = this.#toUnicodeAdapter(layout);
    const plainState = new Uint8Array(256);
    const altGraphState = new Uint8Array(256);
    for (const virtualKey of [VK.CONTROL, VK.LCONTROL, VK.MENU, VK.RMENU]) altGraphState[virtualKey] = 0x80;

    let hasAltGraph = false;
    for (let virtualKey = 0x20; virtualKey <= 0xfe; virtualKey++) {
      const plain = adapter.toUnicode(virtualKey, 0, plainState, TU_NO_STATE_CHANGE);
      const alternate = adapter.toUnicode(virtualKey, 0, altGraphState, TU_NO_STATE_CHANGE);
      if (alternate.result <= 0) continue;
      const alternateText = alternate.text.slice(0, alternate.result);
      const plainText = plain.result > 0 ? plain.text.slice(0, plain.result) : "";
      if (isCommitText(alternateText) && alternateText !== plainText) {
        hasAltGraph = true;
        break;
      }
    }
    this.#altGraphLayouts.set(layoutId, hasAltGraph);
    return hasAltGraph;
  }

  #keyMessageFromBuffer(buffer: ArrayBuffer): NativeKeyMessage | undefined {
    const view = new DataView(buffer);
    const message = view.getUint32(8, true);
    if (message !== WM.KEYDOWN && message !== WM.SYSKEYDOWN && message !== WM.KEYUP && message !== WM.SYSKEYUP) {
      return undefined;
    }
    return {
      windowId: view.getBigUint64(0, true),
      message,
      virtualKey: Number(view.getBigUint64(16, true)),
      lParam: view.getBigUint64(24, true),
      timestamp: view.getUint32(32, true),
    };
  }

  #peekNextKeyMessage(): NativeKeyMessage | undefined {
    const pointer = Deno.UnsafePointer.of(this.#peekMessage);
    if (!this.#user32.symbols.PeekMessageW(pointer, null, WM.KEYDOWN, WM.UNICHAR, PM_NOREMOVE)) return undefined;
    return this.#keyMessageFromBuffer(this.#peekMessage);
  }

  #takePreparedKey(
    window: Win32InputWindow | undefined,
    type: "keydown" | "keyup",
    wParam: number | bigint,
    lParam: number | bigint,
    systemMessage: boolean,
  ): PreparedKeyEvent | undefined {
    const prepared = this.#preparedKey;
    this.#preparedKey = undefined;
    if (
      prepared !== undefined && prepared.event.type === type && prepared.event.keycode === Number(wParam) &&
      prepared.event.code === getDomCode(lParam)
    ) return prepared;
    if (window === undefined) return undefined;
    const state = this.#states.get(window);
    if (state === undefined) return undefined;

    const keyboardState = this.#snapshotKeyboardState();
    const layout = this.#user32.symbols.GetKeyboardLayout(0);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const modifiers = keyboardModifiers(keyboardState);
    modifiers.altGraphKey = layoutHasAltGraph && modifiers.altGraphKey;
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    const code = getDomCode(lParam);
    let key = logicalKeyFromVirtualKey(Number(wParam));
    let translatedText: string | undefined;
    if (type === "keydown") {
      const stateForTranslation = Uint8Array.from(keyboardState);
      if (!layoutHasAltGraph) stateForTranslation[VK.RMENU] &= 0x7f;
      const translated = translateLogicalKey(
        Number(wParam),
        lParam,
        stateForTranslation,
        this.#toUnicodeAdapter(layout),
      );
      key = translated.key;
      translatedText = translated.text;
    }
    if (code === "AltRight") key = modifiers.altGraphKey ? "AltGraph" : "Alt";
    const identity = win32KeyIdentity(Number(wParam), lParam);
    key = type === "keydown" ? state.logicalKeys.press(identity, key) : state.logicalKeys.release(identity, key);
    return {
      suppress: false,
      event: createWin32KeyEvent(
        type,
        window,
        Number(wParam),
        code,
        key,
        type === "keydown" && decodeKeyLParam(lParam).isRepeat,
        modifiers,
        translatedText,
        systemMessage,
      ),
    };
  }

  #handleChar(
    window: Win32InputWindow,
    state: WindowInputState,
    wParam: number | bigint,
    lParam: number | bigint,
  ): void {
    const repeatCount = decodeKeyLParam(lParam).repeatCount;
    for (const decoded of state.charDecoder.push(wParam, repeatCount)) {
      this.#queueText(window, repeatedWmCharText(decoded));
    }
  }

  #flushCharDecoder(window: Win32InputWindow, state: WindowInputState): void {
    for (const decoded of state.charDecoder.flush()) {
      this.#queueText(window, repeatedWmCharText(decoded));
    }
  }

  #handleUniChar(
    window: Win32InputWindow,
    codePoint: number,
    lParam: number | bigint,
  ): void {
    if (
      !Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) return;
    const text = String.fromCodePoint(codePoint);
    if (!isCommitText(text)) return;
    const repeatCount = Math.max(1, decodeKeyLParam(lParam).repeatCount);
    this.#queueText(window, text.repeat(repeatCount));
  }

  #queueText(window: Win32InputWindow, text: string): void {
    const event = createTextInputEvent(window, text);
    if (event === undefined) return;
    if (this.#preparedKey?.event.type === "keydown") this.#pendingText.push(event);
    else this.#enqueue(event);
  }

  #flushPendingText(): void {
    const events = this.#pendingText;
    this.#pendingText = [];
    for (const event of events) this.#enqueue(event);
  }
}

function createWin32KeyEvent(
  type: "keydown" | "keyup",
  window: Win32InputWindow,
  keycode: number,
  code: string,
  key: string,
  repeat: boolean,
  modifiers: ReturnType<typeof keyboardModifiers>,
  text: string | undefined,
  systemMessage: boolean,
): KeyEvent {
  const init = { window, keycode, code, key, ...modifiers };
  return type === "keydown"
    ? createKeyDownEvent({
      ...init,
      repeat,
      editDisposition: win32KeyEditDisposition(key, modifiers, text, systemMessage),
    })
    : createKeyUpEvent(init);
}
