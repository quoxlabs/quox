/** Native Win32 keyboard and IMM32 controller, separate from window/render ownership. */

import type { KeyEvent, UIEvent, Window } from "../types.ts";
import {
  CompositionState,
  createImeActivationEvent,
  createImeCommitEvent,
  createImePreeditEvent,
  createKeyDownEvent,
  createKeyUpEvent,
  ImeActivationState,
  type PreeditUpdate,
} from "../input/mod.ts";
import { type ImeCursorArea, normalizeImeCursorArea, validateImeCursorRange } from "../input/ime.ts";
import { PressedLogicalKeyCache } from "../input/pressed_keys.ts";
import { getDomCode } from "./dom_code.ts";
import {
  CPS_CANCEL,
  CS_INSERTCHAR,
  CS_NOMOVECARET,
  GCS_COMPATTR,
  GCS_COMPCLAUSE,
  GCS_COMPREADATTR,
  GCS_COMPREADCLAUSE,
  GCS_COMPREADSTR,
  GCS_COMPSTR,
  GCS_CURSORPOS,
  GCS_DELTASTART,
  GCS_RESULTCLAUSE,
  GCS_RESULTREADCLAUSE,
  GCS_RESULTREADSTR,
  GCS_RESULTSTR,
  IACE_DEFAULT,
  IMECHARPOSITION_SIZE,
  type imm32functions,
  IMR_QUERYCHARPOSITION,
  ISC_SHOWUICOMPOSITIONWINDOW,
  NI_COMPOSITIONSTR,
  PM_NOREMOVE,
  TU_NO_STATE_CHANGE,
  UNICODE_NOCHAR,
  type user32functions,
  WM,
} from "./ffi.ts";
import {
  AltGraphControlFilter,
  decodeKeyLParam,
  isCommitText,
  keyboardModifiers,
  logicalKeyFromVirtualKey,
  matchesWin32KeyMessage,
  repeatedWmCharText,
  ResultEchoSuppressor,
  shouldExposeAltGraph,
  type ToUnicodeAdapter,
  translateLogicalKey,
  VK,
  win32KeyEditDisposition,
  win32KeyIdentity,
  WmCharDecoder,
} from "./input.ts";
import {
  encodeCandidateForm,
  encodeCompositionForm,
  encodeImeCharPosition,
  type ImeCompositionUpdate,
  insertCompositionCharacter,
  readImmUtf16,
  utf16CursorRangeToUtf8,
  withImeContext,
} from "./imm.ts";

const GCS_ALL = GCS_COMPREADSTR | GCS_COMPREADATTR | GCS_COMPREADCLAUSE | GCS_COMPSTR |
  GCS_COMPATTR | GCS_COMPCLAUSE | GCS_CURSORPOS | GCS_DELTASTART | GCS_RESULTREADSTR |
  GCS_RESULTREADCLAUSE | GCS_RESULTSTR | GCS_RESULTCLAUSE;
const IME_COMPOSITION_FLAGS = GCS_ALL | CS_INSERTCHAR | CS_NOMOVECARET;

export interface Win32InputWindow extends Window {
  readonly id: bigint;
  readonly hwnd: Deno.PointerObject;
}

interface WindowInputState {
  readonly activation: ImeActivationState;
  readonly composition: CompositionState;
  cursorArea?: ImeCursorArea;
  surroundingText?: {
    text: string;
    selectionStartBytes: number;
    selectionEndBytes: number;
  };
  readonly logicalKeys: PressedLogicalKeyCache<string>;
  readonly altGraphTextKeys: Set<string>;
  readonly altGraphControlFilter: AltGraphControlFilter;
  readonly charDecoder: WmCharDecoder;
  readonly resultEcho: ResultEchoSuppressor;
}

interface KeyEventResult {
  event: KeyEvent;
  suppress: boolean;
}

interface PreparedKeyEvent extends KeyEventResult {
  native: NativeKeyMessage;
}

interface NativeKeyMessage {
  windowId: bigint;
  message: number;
  virtualKey: number;
  lParam: bigint;
  timestamp: number;
}

type User32Library = Deno.DynamicLibrary<typeof user32functions>;
type Imm32Library = Deno.DynamicLibrary<typeof imm32functions>;

/** Owns all mutable native-input state for Win32 windows. */
export class Win32InputController {
  readonly #states = new Map<Win32InputWindow, WindowInputState>();
  readonly #altGraphLayouts = new Map<bigint, boolean>();
  readonly #peekMessage = new ArrayBuffer(48);
  readonly #user32: User32Library;
  readonly #imm32: Imm32Library;
  readonly #enqueue: (event: UIEvent) => void;
  readonly #windowById: (id: bigint) => Win32InputWindow | undefined;
  #preparedKey: PreparedKeyEvent | undefined;

  constructor(
    user32: User32Library,
    imm32: Imm32Library,
    enqueue: (event: UIEvent) => void,
    windowById: (id: bigint) => Win32InputWindow | undefined,
  ) {
    this.#user32 = user32;
    this.#imm32 = imm32;
    this.#enqueue = enqueue;
    this.#windowById = windowById;
  }

  attach(window: Win32InputWindow): void {
    if (this.#states.has(window)) return;
    const state: WindowInputState = {
      activation: new ImeActivationState(),
      composition: new CompositionState(),
      logicalKeys: new PressedLogicalKeyCache<string>(),
      altGraphTextKeys: new Set<string>(),
      altGraphControlFilter: new AltGraphControlFilter(),
      charDecoder: new WmCharDecoder(),
      resultEcho: new ResultEchoSuppressor(),
    };
    this.#states.set(window, state);
    try {
      // WM_CHAR remains available without an associated IMM context; native
      // composition is opt-in and is reconciled when the focused editor asks.
      this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, 0);
      state.activation.setAvailable(true);
    } catch (error) {
      this.#states.delete(window);
      throw error;
    }
  }

  detach(window: Win32InputWindow): void {
    const state = this.#states.get(window);
    if (state === undefined) return;
    const errors: unknown[] = [];
    if (state.composition.active) {
      try {
        this.#withImeContext(window, (context) => {
          this.#imm32.symbols.ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
        });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, 0);
    } catch (error) {
      errors.push(error);
    }
    state.composition.reset();
    state.charDecoder.reset();
    state.resultEcho.clear();
    state.logicalKeys.clear();
    state.altGraphTextKeys.clear();
    state.altGraphControlFilter.reset();
    state.activation.reset();
    this.#states.delete(window);
    throwCollected(errors, "Failed to release Win32 input state");
  }

  setImeEnabled(window: Win32InputWindow, enabled: boolean): void {
    const state = this.#state(window);
    if (state.activation.desired !== enabled) {
      if (!enabled) this.#cancelComposition(window, state);
      state.activation.setDesired(enabled);
    }
    this.#reconcileIme(window, state);
  }

  setImeCursorArea(window: Win32InputWindow, x: number, y: number, width: number, height: number): void {
    const rectangle = normalizeImeCursorArea(x, y, width, height);
    if (rectangle === undefined) return;
    const state = this.#state(window);
    state.cursorArea = rectangle;
    if (state.activation.active) this.#applyImeCursorArea(window, state);
  }

  setImeSurroundingText(
    window: Win32InputWindow,
    text: string,
    selectionStartBytes: number,
    selectionEndBytes: number,
  ): void {
    const selection = validateImeCursorRange(text, selectionStartBytes, selectionEndBytes);
    if (selection === null) {
      throw new RangeError("winding(win32): invalid UTF-8 surrounding-text selection");
    }
    this.#state(window).surroundingText = {
      text,
      selectionStartBytes: selection[0],
      selectionEndBytes: selection[1],
    };
  }

  /** Synchronize focus queried during construction or reported by the WndProc. */
  observeNativeFocus(window: Win32InputWindow, focused: boolean): void {
    const state = this.#state(window);
    if (state.activation.focused === focused) return;
    if (focused) {
      this.#enqueue({ type: "focus", window });
      state.activation.setFocused(true);
      this.#reconcileIme(window, state);
      return;
    }
    this.#cancelComposition(window, state);
    state.activation.setFocused(false);
    this.#reconcileIme(window, state);
    state.logicalKeys.clear();
    state.altGraphTextKeys.clear();
    state.altGraphControlFilter.reset();
    this.#enqueue({ type: "blur", window });
  }

  /** Queue IME-owning sent-message work while TranslateMessage has the IME on its stack. */
  deferImeMessage(
    window: Win32InputWindow | undefined,
    message: number,
    wParam: number | bigint,
    lParam: number | bigint,
    schedule: (operation: () => void) => void,
  ): { result: bigint | undefined } | undefined {
    if (window === undefined) return undefined;
    const state = this.#states.get(window);
    if (state === undefined) return undefined;

    let result: bigint | undefined;
    switch (message) {
      case WM.SETFOCUS:
      case WM.KILLFOCUS:
        result = undefined;
        break;
      case WM.IME_STARTCOMPOSITION:
      case WM.IME_COMPOSITION:
      case WM.IME_ENDCOMPOSITION:
        if (!state.activation.desired) return undefined;
        result = 0n;
        break;
      case WM.IME_SETCONTEXT:
        result = this.#forwardImeSetContext(window, state, message, wParam, lParam);
        break;
      default:
        return undefined;
    }

    schedule(() => {
      if (this.#states.get(window) === state) this.handleMessage(window, message, wParam, lParam, true);
    });
    return { result };
  }

  /** Process input-owned WndProc messages; undefined means continue with DefWindowProcW. */
  handleMessage(
    window: Win32InputWindow | undefined,
    message: number,
    wParam: number | bigint,
    lParam: number | bigint,
    replayed = false,
  ): bigint | undefined {
    const state = window === undefined ? undefined : this.#states.get(window);
    switch (message) {
      case WM.SETFOCUS:
        if (window !== undefined && state !== undefined) {
          this.observeNativeFocus(window, true);
        }
        return undefined;
      case WM.KILLFOCUS:
        if (window !== undefined && state !== undefined) {
          this.observeNativeFocus(window, false);
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
        if (window !== undefined && state !== undefined) this.#flushCharDecoder(window, state);
        return 0n;
      case WM.SYSCHAR:
        if (window !== undefined && state !== undefined && this.#currentModifiers(true).altGraphKey) {
          this.#handleChar(window, state, wParam, lParam);
          return 0n;
        }
        return undefined;
      case WM.SYSDEADCHAR:
        if (window !== undefined && state !== undefined && this.#currentModifiers(true).altGraphKey) {
          this.#flushCharDecoder(window, state);
          return 0n;
        }
        return undefined;
      case WM.UNICHAR:
        if (Number(wParam) === UNICODE_NOCHAR) return 1n;
        if (window !== undefined && state !== undefined) {
          this.#flushCharDecoder(window, state);
          this.#handleUniChar(window, state, Number(wParam), lParam);
          return 0n;
        }
        return undefined;
      case WM.INPUTLANGCHANGE:
        this.#altGraphLayouts.clear();
        for (const [inputWindow, inputState] of this.#states) {
          this.#flushCharDecoder(inputWindow, inputState);
          inputState.altGraphControlFilter.reset();
          inputState.altGraphTextKeys.clear();
        }
        return undefined;
      case WM.IME_STARTCOMPOSITION:
        if (window !== undefined && state?.activation.desired) {
          this.#flushCharDecoder(window, state);
          state.composition.start();
          state.resultEcho.clear();
          if (!state.activation.active) this.#setImeActive(window, state, true);
          this.#applyImeCursorArea(window, state);
          return 0n;
        }
        return undefined;
      case WM.IME_COMPOSITION:
        if (
          window !== undefined && state?.activation.desired &&
          this.#handleImeComposition(window, state, wParam, lParam)
        ) return 0n;
        return undefined;
      case WM.IME_ENDCOMPOSITION:
        if (window !== undefined && state?.activation.desired) {
          this.#flushCharDecoder(window, state);
          this.#queuePreedit(window, state.composition.cancel());
          return 0n;
        }
        return undefined;
      case WM.IME_CHAR:
        if (window !== undefined && state !== undefined) {
          this.#handleChar(window, state, wParam, lParam);
          return 0n;
        }
        return undefined;
      case WM.IME_SETCONTEXT:
        if (window !== undefined && state !== undefined) {
          const activating = BigInt(wParam) !== 0n;
          if (activating && state.activation.desired) {
            this.#reconcileIme(window, state);
            this.#applyImeCursorArea(window, state);
          } else if (!activating) {
            this.#cancelComposition(window, state);
            this.#setImeActive(window, state, false);
          }
          return replayed ? 0n : this.#forwardImeSetContext(window, state, message, wParam, lParam);
        }
        return undefined;
      case WM.IME_REQUEST:
        if (
          window !== undefined && state !== undefined && Number(wParam) === IMR_QUERYCHARPOSITION &&
          this.#answerImeCharPosition(window, state, lParam)
        ) return 1n;
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
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, false);

    const code = getDomCode(message.lParam);
    const identity = win32KeyIdentity(message.virtualKey, message.lParam);
    let key = logicalKeyFromVirtualKey(message.virtualKey);
    let translatedText: string | undefined;
    if (type === "keydown") {
      const translated = translateLogicalKey(
        message.virtualKey,
        message.lParam,
        keyboardState,
        this.#toUnicodeAdapter(layout),
        layoutHasAltGraph && modifiers.ctrlKey && modifiers.altKey,
      );
      key = translated.key;
      translatedText = translated.text;
      if (modifiers.ctrlKey && modifiers.altKey && translatedText !== undefined) {
        state.altGraphTextKeys.add(identity);
      } else if (!decodeKeyLParam(message.lParam).isRepeat) {
        state.altGraphTextKeys.delete(identity);
      }
    } else if (state.altGraphTextKeys.delete(identity)) {
      modifiers.altGraphKey = layoutHasAltGraph;
    }
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, translatedText !== undefined);
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    if (code === "AltRight") key = modifiers.altGraphKey && layoutHasAltGraph ? "AltGraph" : "Alt";

    if (type === "keydown") {
      key = state.logicalKeys.press(identity, key);
      state.resultEcho.clear();
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
      native: message,
      suppress: layoutHasAltGraph && state.altGraphControlFilter.shouldSuppress(current, next),
      event: createWin32KeyEvent(
        type,
        window,
        message.virtualKey,
        code,
        key,
        type === "keydown" && decodeKeyLParam(message.lParam).isRepeat,
        state.composition.active,
        modifiers,
        translatedText,
        message.message === WM.SYSKEYDOWN,
      ),
    };
  }

  clearPreparedKey(): void {
    this.#preparedKey = undefined;
  }

  close(): void {
    this.#preparedKey = undefined;
    this.#altGraphLayouts.clear();
    for (const state of this.#states.values()) {
      state.composition.reset();
      state.charDecoder.reset();
      state.resultEcho.clear();
      state.logicalKeys.clear();
      state.altGraphTextKeys.clear();
      state.altGraphControlFilter.reset();
      state.activation.reset();
    }
    this.#states.clear();
  }

  #state(window: Win32InputWindow): WindowInputState {
    const state = this.#states.get(window);
    if (state === undefined) throw new Error("winding(win32): window input is not attached");
    return state;
  }

  #forwardImeSetContext(
    window: Win32InputWindow,
    state: WindowInputState,
    message: number,
    wParam: number | bigint,
    lParam: number | bigint,
  ): bigint {
    const forwardedLParam = state.activation.desired
      ? BigInt.asUintN(64, BigInt(lParam)) & ~BigInt(ISC_SHOWUICOMPOSITIONWINDOW)
      : BigInt(lParam);
    return this.#user32.symbols.DefWindowProcW(window.hwnd, message, BigInt(wParam), forwardedLParam);
  }

  #snapshotKeyboardState(): Uint8Array<ArrayBuffer> {
    const state = new Uint8Array(256) as Uint8Array<ArrayBuffer>;
    if (this.#user32.symbols.GetKeyboardState(state) !== 0) return state;
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

  #currentModifiers(characterMessage = false) {
    const modifiers = keyboardModifiers(this.#snapshotKeyboardState());
    const layoutHasAltGraph = this.#layoutHasAltGraph(this.#user32.symbols.GetKeyboardLayout(0));
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, characterMessage);
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
    if (this.#user32.symbols.PeekMessageW(pointer, null, WM.KEYDOWN, WM.UNICHAR, PM_NOREMOVE) === 0) return undefined;
    return this.#keyMessageFromBuffer(this.#peekMessage);
  }

  #takePreparedKey(
    window: Win32InputWindow | undefined,
    type: "keydown" | "keyup",
    wParam: number | bigint,
    lParam: number | bigint,
    systemMessage: boolean,
  ): KeyEventResult | undefined {
    const prepared = this.#preparedKey;
    const expectedMessage = type === "keydown"
      ? (systemMessage ? WM.SYSKEYDOWN : WM.KEYDOWN)
      : (systemMessage ? WM.SYSKEYUP : WM.KEYUP);
    if (
      prepared !== undefined && window !== undefined &&
      matchesWin32KeyMessage(prepared.native, {
        windowId: window.id,
        message: expectedMessage,
        virtualKey: Number(wParam),
        lParam: BigInt.asUintN(64, BigInt(lParam)),
      })
    ) {
      this.#preparedKey = undefined;
      return prepared;
    }
    if (window === undefined) return undefined;
    const state = this.#states.get(window);
    if (state === undefined) return undefined;

    const keyboardState = this.#snapshotKeyboardState();
    const layout = this.#user32.symbols.GetKeyboardLayout(0);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const modifiers = keyboardModifiers(keyboardState);
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, false);
    const code = getDomCode(lParam);
    const identity = win32KeyIdentity(Number(wParam), lParam);
    let key = logicalKeyFromVirtualKey(Number(wParam));
    let translatedText: string | undefined;
    if (type === "keydown") {
      const translated = translateLogicalKey(
        Number(wParam),
        lParam,
        keyboardState,
        this.#toUnicodeAdapter(layout),
        layoutHasAltGraph && modifiers.ctrlKey && modifiers.altKey,
      );
      key = translated.key;
      translatedText = translated.text;
      if (modifiers.ctrlKey && modifiers.altKey && translatedText !== undefined) {
        state.altGraphTextKeys.add(identity);
      } else if (!decodeKeyLParam(lParam).isRepeat) {
        state.altGraphTextKeys.delete(identity);
      }
    } else if (state.altGraphTextKeys.delete(identity)) {
      modifiers.altGraphKey = layoutHasAltGraph;
    }
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, translatedText !== undefined);
    modifiers.accelKey = modifiers.ctrlKey && !modifiers.altGraphKey;
    if (code === "AltRight") key = modifiers.altGraphKey ? "AltGraph" : "Alt";
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
        state.composition.active,
        modifiers,
        translatedText,
        systemMessage,
      ),
    };
  }

  #queuePreedit(window: Win32InputWindow, update: PreeditUpdate | undefined): void {
    if (update !== undefined) this.#enqueue(createImePreeditEvent(window, update.text, update.cursorRange));
  }

  #applyImeUpdate(window: Win32InputWindow, state: WindowInputState, update: ImeCompositionUpdate): void {
    if (update.result !== undefined && isCommitText(update.result)) {
      state.composition.commit();
      const commit = createImeCommitEvent(window, update.result);
      if (commit !== undefined) this.#enqueue(commit);
    }
    if (update.preedit === undefined) return;
    if (update.preedit === null || update.preedit.text.length === 0) {
      this.#queuePreedit(window, state.composition.cancel());
      return;
    }
    this.#queuePreedit(
      window,
      state.composition.update(update.preedit.text, update.preedit.cursorRange ?? null),
    );
  }

  #handleChar(
    window: Win32InputWindow,
    state: WindowInputState,
    wParam: number | bigint,
    lParam: number | bigint,
  ): void {
    const repeatCount = decodeKeyLParam(lParam).repeatCount;
    for (const decoded of state.charDecoder.push(wParam, repeatCount)) {
      if (state.resultEcho.consume(decoded.text, decoded.repeatCount)) continue;
      this.#applyImeUpdate(window, state, { result: repeatedWmCharText(decoded) });
    }
  }

  #flushCharDecoder(window: Win32InputWindow, state: WindowInputState): void {
    for (const decoded of state.charDecoder.flush()) {
      if (state.resultEcho.consume(decoded.text, decoded.repeatCount)) continue;
      this.#applyImeUpdate(window, state, { result: repeatedWmCharText(decoded) });
    }
  }

  #handleUniChar(
    window: Win32InputWindow,
    state: WindowInputState,
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
    if (state.resultEcho.consume(text, repeatCount)) return;
    this.#applyImeUpdate(window, state, { result: text.repeat(repeatCount) });
  }

  #withImeContext<Result>(
    window: Win32InputWindow,
    callback: (context: Deno.PointerObject) => Result,
  ): Result | undefined {
    return withImeContext(
      () => this.#imm32.symbols.ImmGetContext(window.hwnd),
      (context) => {
        this.#imm32.symbols.ImmReleaseContext(window.hwnd, context);
      },
      callback,
    );
  }

  #readCompositionString(context: Deno.PointerObject, index: number): string | undefined {
    return readImmUtf16({
      getCompositionString: (compositionIndex, buffer) =>
        this.#imm32.symbols.ImmGetCompositionStringW(
          context,
          compositionIndex,
          buffer === undefined ? null : Deno.UnsafePointer.of(buffer),
          buffer?.byteLength ?? 0,
        ),
    }, index);
  }

  #handleImeComposition(
    window: Win32InputWindow,
    state: WindowInputState,
    wParam: number | bigint,
    lParam: number | bigint,
  ): boolean {
    const flags = Number(BigInt(lParam) & 0xffffffffn);
    if ((flags & IME_COMPOSITION_FLAGS) === 0) {
      this.#applyImeUpdate(window, state, { preedit: null });
      return true;
    }

    let insertedPreedit: { text: string; cursorRange?: readonly [number, number] } | undefined;
    if ((flags & CS_INSERTCHAR) !== 0 && (flags & GCS_COMPSTR) === 0) {
      const character = String.fromCharCode(Number(BigInt(wParam) & 0xffffn));
      if (isCommitText(character)) {
        insertedPreedit = insertCompositionCharacter(
          state.composition.text,
          state.composition.cursorRange ?? undefined,
          character,
          (flags & CS_NOMOVECARET) !== 0,
        );
      }
    }
    if ((flags & GCS_ALL) === 0) {
      if (insertedPreedit !== undefined) this.#applyImeUpdate(window, state, { preedit: insertedPreedit });
      return true;
    }

    const update = this.#withImeContext(window, (context) => {
      let result: string | undefined;
      let preedit: { text: string; cursorRange?: readonly [number, number] } | null | undefined = insertedPreedit;
      if ((flags & GCS_RESULTSTR) !== 0) {
        result = this.#readCompositionString(context, GCS_RESULTSTR);
        if (result === undefined) return null;
      }
      if ((flags & GCS_COMPSTR) !== 0) {
        const text = this.#readCompositionString(context, GCS_COMPSTR);
        if (text === undefined) return null;
        const cursorPosition = this.#imm32.symbols.ImmGetCompositionStringW(context, GCS_CURSORPOS, null, 0);
        const cursorRange = cursorPosition < 0 ? undefined : utf16CursorRangeToUtf8(text, cursorPosition);
        preedit = text.length === 0 ? null : { text, ...(cursorRange === undefined ? {} : { cursorRange }) };
      } else if ((flags & GCS_CURSORPOS) !== 0 && state.composition.text.length > 0) {
        const cursorPosition = this.#imm32.symbols.ImmGetCompositionStringW(context, GCS_CURSORPOS, null, 0);
        const cursorRange = cursorPosition < 0
          ? undefined
          : utf16CursorRangeToUtf8(state.composition.text, cursorPosition);
        preedit = {
          text: state.composition.text,
          ...(cursorRange === undefined ? {} : { cursorRange }),
        };
      }
      return { result, preedit };
    });
    if (update === undefined || update === null) return false;
    if (update.result !== undefined && isCommitText(update.result)) state.resultEcho.expect(update.result);
    this.#applyImeUpdate(window, state, update);
    return true;
  }

  #setImeActive(window: Win32InputWindow, state: WindowInputState, active: boolean): void {
    const transition = state.activation.markActive(active);
    if (transition !== undefined) this.#enqueue(createImeActivationEvent(window, transition));
  }

  #reconcileIme(window: Win32InputWindow, state: WindowInputState): void {
    const transition = state.activation.reconcile({
      activate: () => {
        const activated = this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, IACE_DEFAULT);
        if (activated !== 0) this.#applyImeCursorArea(window, state);
        return activated !== 0;
      },
      deactivate: () => {
        this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, 0);
      },
    });
    if (transition !== undefined) this.#enqueue(createImeActivationEvent(window, transition));
    if (transition === undefined && state.activation.active) this.#applyImeCursorArea(window, state);
  }

  #cancelComposition(window: Win32InputWindow, state: WindowInputState): void {
    if (state.composition.active) {
      this.#withImeContext(window, (context) => {
        this.#imm32.symbols.ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
      });
    }
    this.#flushCharDecoder(window, state);
    this.#queuePreedit(window, state.composition.cancel());
    state.resultEcho.clear();
  }

  #applyImeCursorArea(window: Win32InputWindow, state: WindowInputState): void {
    const rectangle = state.cursorArea;
    if (rectangle === undefined) return;
    this.#withImeContext(window, (context) => {
      this.#imm32.symbols.ImmSetCandidateWindow(context, encodeCandidateForm(rectangle));
      this.#imm32.symbols.ImmSetCompositionWindow(context, encodeCompositionForm(rectangle));
    });
  }

  #clientPointToScreen(window: Win32InputWindow, x: number, y: number): { x: number; y: number } | undefined {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setInt32(0, x, true);
    view.setInt32(4, y, true);
    if (this.#user32.symbols.ClientToScreen(window.hwnd, buffer) === 0) return undefined;
    return { x: view.getInt32(0, true), y: view.getInt32(4, true) };
  }

  #clientRectToScreen(window: Win32InputWindow, rectangle: ImeCursorArea): ImeCursorArea | undefined {
    const topLeft = this.#clientPointToScreen(window, rectangle.x, rectangle.y);
    const bottomRight = this.#clientPointToScreen(
      window,
      rectangle.x + rectangle.width,
      rectangle.y + rectangle.height,
    );
    if (topLeft === undefined || bottomRight === undefined) return undefined;
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: Math.max(0, bottomRight.x - topLeft.x),
      height: Math.max(0, bottomRight.y - topLeft.y),
    };
  }

  #screenDocumentRectangle(window: Win32InputWindow): ImeCursorArea | undefined {
    const buffer = new ArrayBuffer(16);
    if (this.#user32.symbols.GetClientRect(window.hwnd, buffer) === 0) return undefined;
    const view = new DataView(buffer);
    return this.#clientRectToScreen(window, {
      x: view.getInt32(0, true),
      y: view.getInt32(4, true),
      width: Math.max(0, view.getInt32(8, true) - view.getInt32(0, true)),
      height: Math.max(0, view.getInt32(12, true) - view.getInt32(4, true)),
    });
  }

  #answerImeCharPosition(
    window: Win32InputWindow,
    state: WindowInputState,
    lParam: number | bigint,
  ): boolean {
    const address = BigInt(lParam);
    if (address === 0n || state.cursorArea === undefined) return false;
    const pointer = Deno.UnsafePointer.create(address);
    if (pointer === null) return false;
    const target = new Deno.UnsafePointerView(pointer).getArrayBuffer(IMECHARPOSITION_SIZE);
    const targetView = new DataView(target);
    if (targetView.getUint32(0, true) < IMECHARPOSITION_SIZE) return false;
    const caret = this.#clientRectToScreen(window, state.cursorArea);
    const document = this.#screenDocumentRectangle(window);
    if (caret === undefined || document === undefined) return false;
    const response = encodeImeCharPosition(targetView.getUint32(4, true), caret, document);
    new Uint8Array(target).set(new Uint8Array(response));
    return true;
  }
}

function createWin32KeyEvent(
  type: "keydown" | "keyup",
  window: Win32InputWindow,
  keycode: number,
  code: string,
  key: string,
  repeat: boolean,
  isComposing: boolean,
  modifiers: ReturnType<typeof keyboardModifiers>,
  text: string | undefined,
  systemMessage: boolean,
): KeyEvent {
  const init = { window, keycode, code, key, isComposing, ...modifiers };
  return type === "keydown"
    ? createKeyDownEvent({
      ...init,
      repeat,
      editDisposition: win32KeyEditDisposition(key, isComposing, modifiers, text, systemMessage),
    })
    : createKeyUpEvent(init);
}

function throwCollected(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
