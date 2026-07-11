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
import {
  type ImeCursorArea,
  normalizeImeCursorArea,
  validateImeCursorArea,
  validateImeCursorRange,
} from "../input/ime.ts";
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
  type imm32functions,
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
  CsInsertCharAssembler,
  type DecodedWmChar,
  decodeKeyLParam,
  expandWin32KeyRepeats,
  InsertOnTypeFallbackState,
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
  Win32ImeAssociationState,
  win32KeyEditDisposition,
  win32KeyIdentity,
  win32LanguageIdFromKeyboardLayout,
  WmCharDecoder,
} from "./input.ts";
import {
  encodeCandidateForm,
  encodeCompositionForm,
  IME_CANDIDATE_LIST_INDICES,
  type ImeCompositionUpdate,
  type ImmCompositionAdapter,
  immCompositionRangeToUtf8,
  insertCompositionCharacter,
  readImmBytes,
  readImmUtf16,
  withImeContext,
} from "./imm.ts";

const GCS_ALL = GCS_COMPREADSTR | GCS_COMPREADATTR | GCS_COMPREADCLAUSE | GCS_COMPSTR |
  GCS_COMPATTR | GCS_COMPCLAUSE | GCS_CURSORPOS | GCS_DELTASTART | GCS_RESULTREADSTR |
  GCS_RESULTREADCLAUSE | GCS_RESULTSTR | GCS_RESULTCLAUSE;
const IME_COMPOSITION_FLAGS = GCS_ALL | CS_INSERTCHAR | CS_NOMOVECARET;

export interface Win32InputWindow extends Window {
  readonly id: bigint;
  readonly hwnd: Deno.PointerObject;
  readonly devicePixelRatio: number;
}

interface WindowInputState {
  readonly activation: ImeActivationState;
  readonly association: Win32ImeAssociationState;
  readonly composition: CompositionState;
  compositionAttributes?: Uint8Array;
  compositionClauses?: Uint8Array;
  cancelingComposition: boolean;
  nativeCompositionDirty: boolean;
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
  readonly imeCharDecoder: WmCharDecoder;
  readonly insertCharAssembler: CsInsertCharAssembler;
  readonly insertOnType: InsertOnTypeFallbackState;
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
  readonly #compositionAdapterForContext?: (context: Deno.PointerObject) => ImmCompositionAdapter;
  readonly #keyboardLayoutAddress: (layout: Deno.PointerValue) => bigint | undefined;
  #preparedKey: PreparedKeyEvent | undefined;

  constructor(
    user32: User32Library,
    imm32: Imm32Library,
    enqueue: (event: UIEvent) => void,
    windowById: (id: bigint) => Win32InputWindow | undefined,
    compositionAdapterForContext?: (context: Deno.PointerObject) => ImmCompositionAdapter,
    keyboardLayoutAddress: (layout: Deno.PointerValue) => bigint | undefined = (layout) =>
      layout === null ? undefined : Deno.UnsafePointer.value(layout),
  ) {
    this.#user32 = user32;
    this.#imm32 = imm32;
    this.#enqueue = enqueue;
    this.#windowById = windowById;
    this.#compositionAdapterForContext = compositionAdapterForContext;
    this.#keyboardLayoutAddress = keyboardLayoutAddress;
  }

  attach(window: Win32InputWindow): void {
    if (this.#states.has(window)) return;
    const state: WindowInputState = {
      activation: new ImeActivationState(),
      association: new Win32ImeAssociationState(),
      composition: new CompositionState(),
      cancelingComposition: false,
      nativeCompositionDirty: false,
      logicalKeys: new PressedLogicalKeyCache<string>(),
      altGraphTextKeys: new Set<string>(),
      altGraphControlFilter: new AltGraphControlFilter(),
      charDecoder: new WmCharDecoder(),
      imeCharDecoder: new WmCharDecoder(),
      insertCharAssembler: new CsInsertCharAssembler(),
      insertOnType: new InsertOnTypeFallbackState(),
      resultEcho: new ResultEchoSuppressor(),
    };
    this.#states.set(window, state);
    try {
      // WM_CHAR remains available without an associated IMM context; native
      // composition is opt-in and is reconciled when the focused editor asks.
      const disassociated = state.association.reconcile(
        false,
        () => this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, 0) !== 0,
      );
      if (!disassociated) throw new Error("winding(win32): failed to disassociate the initial HIMC");
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
        this.#cancelComposition(window, state);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (this.#imm32.symbols.ImmAssociateContextEx(window.hwnd, null, 0) === 0) {
        throw new Error("winding(win32): failed to disassociate HIMC during detach");
      }
      state.association.reconcile(false, () => true);
      state.nativeCompositionDirty = false;
    } catch (error) {
      errors.push(error);
    }
    state.composition.reset();
    state.charDecoder.reset();
    state.imeCharDecoder.reset();
    state.insertCharAssembler.reset();
    state.insertOnType.cancel();
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
    const errors: unknown[] = [];
    if (state.activation.desired !== enabled) {
      if (!enabled) captureError(errors, () => this.#cancelComposition(window, state));
      state.activation.setDesired(enabled);
    }
    captureError(errors, () => this.#reconcileIme(window, state));
    throwCollected(errors, "Failed to change Win32 IME state");
  }

  setImeCursorArea(window: Win32InputWindow, x: number, y: number, width: number, height: number): void {
    const rectangle = validateImeCursorArea(x, y, width, height);
    if (rectangle === undefined) return;
    const state = this.#state(window);
    state.cursorArea = rectangle;
    if (state.activation.active) this.#applyImeCursorArea(window, state);
  }

  /** Reapply cached logical IME geometry after the HWND's effective DPI changes. */
  dpiChanged(window: Win32InputWindow): void {
    const state = this.#state(window);
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
    const errors: unknown[] = [];
    captureError(errors, () => this.#cancelComposition(window, state));
    state.activation.setFocused(false);
    captureError(errors, () => this.#reconcileIme(window, state));
    state.logicalKeys.clear();
    state.altGraphTextKeys.clear();
    state.altGraphControlFilter.reset();
    this.#enqueue({ type: "blur", window });
    throwCollected(errors, "Failed to blur Win32 IME state");
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
        if (!this.#acceptsNativeComposition(state)) return undefined;
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
        if (prepared !== undefined && !prepared.suppress) {
          for (const event of expandWin32KeyRepeats(prepared.event, lParam)) this.#enqueue(event);
        }
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
          this.#flushImeCharDecoder(window, state);
          this.#handleUniChar(window, state, Number(wParam), lParam);
          return 0n;
        }
        return undefined;
      case WM.INPUTLANGCHANGE:
        this.#altGraphLayouts.clear();
        for (const [inputWindow, inputState] of this.#states) {
          this.#flushCharDecoder(inputWindow, inputState);
          this.#flushImeCharDecoder(inputWindow, inputState);
          inputState.insertCharAssembler.reset();
          inputState.altGraphControlFilter.reset();
          inputState.altGraphTextKeys.clear();
        }
        return undefined;
      case WM.IME_STARTCOMPOSITION:
        if (window === undefined || state === undefined || !this.#acceptsNativeComposition(state)) return undefined;
        if (state.cancelingComposition) return 0n;
        // START names a new native session. Drop incomplete character units
        // instead of flushing stale data into the new session.
        state.charDecoder.reset();
        state.imeCharDecoder.reset();
        state.insertCharAssembler.reset();
        this.#queuePreedit(window, state.composition.restart());
        state.insertOnType.start();
        this.#clearCompositionMetadata(state);
        state.resultEcho.clear();
        this.#applyImeCursorArea(window, state);
        return 0n;
      case WM.IME_COMPOSITION:
        if (window === undefined || state === undefined || !this.#acceptsNativeComposition(state)) return undefined;
        if (state.cancelingComposition) return 0n;
        return this.#handleImeComposition(window, state, wParam, lParam) ? 0n : undefined;
      case WM.IME_ENDCOMPOSITION: {
        if (window === undefined || state === undefined || !this.#acceptsNativeComposition(state)) return undefined;
        state.insertCharAssembler.reset();
        if (state.cancelingComposition) {
          state.charDecoder.reset();
          state.imeCharDecoder.reset();
          state.insertOnType.cancel();
          this.#queuePreedit(window, state.composition.cancel());
          this.#clearCompositionMetadata(state);
          return 0n;
        }
        this.#flushCharDecoder(window, state);
        this.#flushImeCharDecoder(window, state);
        const compatibilityResult = state.insertOnType.finish();
        if (compatibilityResult === undefined) {
          this.#queuePreedit(window, state.composition.cancel());
        } else {
          // END does not say whether composition was accepted or canceled.
          // Explicit cancellation paths discard this fallback beforehand.
          this.#applyImeUpdate(window, state, { result: compatibilityResult });
        }
        this.#clearCompositionMetadata(state);
        return 0n;
      }
      case WM.IME_CHAR:
        if (window !== undefined && state !== undefined) {
          this.#handleImeChar(window, state, wParam, lParam);
          return 0n;
        }
        return undefined;
      case WM.IME_SETCONTEXT:
        if (window !== undefined && state !== undefined) {
          const errors: unknown[] = [];
          const activating = BigInt(wParam) !== 0n;
          if (activating && state.activation.desired) {
            captureError(errors, () => this.#reconcileIme(window, state));
          } else if (!activating) {
            captureError(errors, () => this.#cancelComposition(window, state));
            this.#setImeActive(window, state, false);
            captureError(errors, () => this.#reconcileImeAssociation(window, state));
          }
          const result = replayed ? 0n : this.#forwardImeSetContext(window, state, message, wParam, lParam);
          throwCollected(errors, "Failed to reconcile WM_IME_SETCONTEXT");
          return result;
        }
        return undefined;
      case WM.IME_REQUEST:
        // IMR_QUERYCHARPOSITION requires geometry for its requested UTF-16
        // composition offset and the editor's actual document rectangle.
        // Winding receives only one candidate/caret anchor, so even a request
        // that appears to name the caret cannot be proven current or complete.
        // Leave the structure untouched and delegate every request to
        // DefWindowProcW until the shared synchronous contract supplies both.
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
    const languageId = this.#keyboardLayoutLanguageId(layout);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const modifiers = keyboardModifiers(keyboardState);
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, false);

    const code = getDomCode(message.lParam);
    const identity = win32KeyIdentity(message.virtualKey, message.lParam);
    let key = logicalKeyFromVirtualKey(message.virtualKey, undefined, languageId);
    let translatedText: string | undefined;
    if (type === "keydown") {
      const translated = translateLogicalKey(
        message.virtualKey,
        message.lParam,
        keyboardState,
        this.#toUnicodeAdapter(layout),
        layoutHasAltGraph && modifiers.ctrlKey && modifiers.altKey,
        languageId,
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
      state.insertCharAssembler.reset();
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
    const rawLParam = BigInt.asUintN(64, BigInt(lParam));
    const forwardedBits = state.activation.desired ? rawLParam & ~BigInt(ISC_SHOWUICOMPOSITIONWINDOW) : rawLParam;
    const forwardedLParam = BigInt.asIntN(64, forwardedBits);
    return this.#user32.symbols.DefWindowProcW(
      window.hwnd,
      message,
      BigInt.asUintN(64, BigInt(wParam)),
      forwardedLParam,
    );
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

  #keyboardLayoutLanguageId(layout: Deno.PointerValue): number | undefined {
    return win32LanguageIdFromKeyboardLayout(this.#keyboardLayoutAddress(layout));
  }

  #layoutHasAltGraph(layout: Deno.PointerValue): boolean {
    if (layout === null) return false;
    const layoutId = Deno.UnsafePointer.value(layout);
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
      lParam: view.getBigInt64(24, true),
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
        lParam: BigInt.asIntN(64, BigInt(lParam)),
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
    const languageId = this.#keyboardLayoutLanguageId(layout);
    const layoutHasAltGraph = this.#layoutHasAltGraph(layout);
    const modifiers = keyboardModifiers(keyboardState);
    modifiers.altGraphKey = shouldExposeAltGraph(modifiers, layoutHasAltGraph, false);
    const code = getDomCode(lParam);
    const identity = win32KeyIdentity(Number(wParam), lParam);
    let key = logicalKeyFromVirtualKey(Number(wParam), undefined, languageId);
    let translatedText: string | undefined;
    if (type === "keydown") {
      const translated = translateLogicalKey(
        Number(wParam),
        lParam,
        keyboardState,
        this.#toUnicodeAdapter(layout),
        layoutHasAltGraph && modifiers.ctrlKey && modifiers.altKey,
        languageId,
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
      state.insertCharAssembler.reset();
      state.insertOnType.authoritative();
      state.composition.commit();
      this.#clearCompositionMetadata(state);
      const commit = createImeCommitEvent(window, update.result);
      if (commit !== undefined) this.#enqueue(commit);
    }
    if (update.preedit === undefined) return;
    if (update.preedit === null || update.preedit.text.length === 0) {
      state.insertCharAssembler.reset();
      state.insertOnType.cancel();
      this.#queuePreedit(window, state.composition.cancel());
      this.#clearCompositionMetadata(state);
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
      this.#applyDecodedChar(window, state, decoded, false);
    }
  }

  #handleImeChar(
    window: Win32InputWindow,
    state: WindowInputState,
    wParam: number | bigint,
    lParam: number | bigint,
  ): void {
    const repeatCount = decodeKeyLParam(lParam).repeatCount;
    for (const decoded of state.imeCharDecoder.push(wParam, repeatCount)) {
      this.#applyDecodedChar(window, state, decoded, true);
    }
  }

  #flushCharDecoder(window: Win32InputWindow, state: WindowInputState): void {
    for (const decoded of state.charDecoder.flush()) {
      this.#applyDecodedChar(window, state, decoded, false);
    }
  }

  #flushImeCharDecoder(window: Win32InputWindow, state: WindowInputState): void {
    for (const decoded of state.imeCharDecoder.flush()) {
      this.#applyDecodedChar(window, state, decoded, true);
    }
  }

  #applyDecodedChar(
    window: Win32InputWindow,
    state: WindowInputState,
    decoded: DecodedWmChar,
    conversionResult: boolean,
  ): void {
    if (state.cancelingComposition) return;
    if (state.resultEcho.consume(decoded.text, decoded.repeatCount)) return;
    const text = repeatedWmCharText(decoded);
    if (conversionResult) {
      this.#applyImeUpdate(window, state, { result: text });
      return;
    }
    if (state.insertOnType.active) {
      const preedit = state.insertOnType.update(text);
      if (preedit !== undefined) this.#applyImeUpdate(window, state, { preedit });
    } else if (!state.composition.active) {
      this.#applyImeUpdate(window, state, { result: text });
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
        if (this.#imm32.symbols.ImmReleaseContext(window.hwnd, context) === 0) {
          throw new Error("winding(win32): ImmReleaseContext failed");
        }
      },
      callback,
    );
  }

  #readCompositionString(context: Deno.PointerObject, index: number): string | undefined {
    return readImmUtf16(this.#compositionAdapter(context), index);
  }

  #readCompositionBytes(context: Deno.PointerObject, index: number): Uint8Array | undefined {
    return readImmBytes(this.#compositionAdapter(context), index);
  }

  #compositionAdapter(context: Deno.PointerObject): ImmCompositionAdapter {
    return this.#compositionAdapterForContext?.(context) ?? {
      getCompositionString: (compositionIndex, buffer) =>
        this.#imm32.symbols.ImmGetCompositionStringW(
          context,
          compositionIndex,
          buffer === undefined ? null : Deno.UnsafePointer.of(buffer),
          buffer?.byteLength ?? 0,
        ),
    };
  }

  #clearCompositionMetadata(state: WindowInputState): void {
    state.compositionAttributes = undefined;
    state.compositionClauses = undefined;
  }

  #handleImeComposition(
    window: Win32InputWindow,
    state: WindowInputState,
    wParam: number | bigint,
    lParam: number | bigint,
  ): boolean {
    const flags = Number(BigInt(lParam) & 0xffffffffn);
    if ((flags & IME_COMPOSITION_FLAGS) === 0) {
      state.insertCharAssembler.reset();
      this.#applyImeUpdate(window, state, { preedit: null });
      return true;
    }

    const transientInsert = (flags & CS_INSERTCHAR) !== 0 &&
      (flags & (GCS_COMPSTR | GCS_RESULTSTR)) === 0;
    if (!transientInsert) state.insertCharAssembler.reset();
    let insertedPreedit: { text: string; cursorRange?: readonly [number, number] } | undefined;
    if (transientInsert) {
      let text = state.composition.text;
      let cursorRange = state.composition.cursorRange ?? undefined;
      for (const scalar of state.insertCharAssembler.push(wParam, (flags & CS_NOMOVECARET) !== 0)) {
        const inserted = insertCompositionCharacter(text, cursorRange, scalar.text, scalar.noMoveCaret);
        text = inserted.text;
        cursorRange = inserted.cursorRange;
        insertedPreedit = inserted;
      }
    }
    if ((flags & GCS_ALL) === 0) {
      if (insertedPreedit !== undefined) {
        this.#clearCompositionMetadata(state);
        this.#applyImeUpdate(window, state, { preedit: insertedPreedit });
      }
      return true;
    }

    const response = this.#withImeContext(window, (context) => {
      let result: string | undefined;
      let preedit: { text: string; cursorRange?: readonly [number, number] } | null | undefined = insertedPreedit;
      let attributes = insertedPreedit === undefined ? state.compositionAttributes : undefined;
      let clauses = insertedPreedit === undefined ? state.compositionClauses : undefined;
      let metadataChanged = insertedPreedit !== undefined;
      if ((flags & GCS_RESULTSTR) !== 0) {
        result = this.#readCompositionString(context, GCS_RESULTSTR);
        if (result === undefined) return null;
      }

      let text = insertedPreedit?.text ?? state.composition.text;
      if ((flags & GCS_COMPSTR) !== 0) {
        const compositionText = this.#readCompositionString(context, GCS_COMPSTR);
        if (compositionText === undefined) return null;
        text = compositionText;
        attributes = undefined;
        clauses = undefined;
        metadataChanged = true;
      }
      if ((flags & GCS_COMPATTR) !== 0) {
        attributes = this.#readCompositionBytes(context, GCS_COMPATTR);
        metadataChanged = true;
      }
      if ((flags & GCS_COMPCLAUSE) !== 0) {
        clauses = this.#readCompositionBytes(context, GCS_COMPCLAUSE);
        metadataChanged = true;
      }

      if ((flags & (GCS_COMPSTR | GCS_CURSORPOS | GCS_COMPATTR | GCS_COMPCLAUSE)) !== 0) {
        const cursorPosition = this.#imm32.symbols.ImmGetCompositionStringW(context, GCS_CURSORPOS, null, 0);
        const cursorRange = immCompositionRangeToUtf8(text, cursorPosition, attributes, clauses);
        preedit = text.length === 0 ? null : { text, ...(cursorRange === undefined ? {} : { cursorRange }) };
      }
      return { update: { result, preedit }, attributes, clauses, metadataChanged };
    });
    if (response === undefined || response === null) {
      state.insertCharAssembler.reset();
      return false;
    }
    const update = response.update;
    if ((flags & (GCS_COMPSTR | GCS_RESULTSTR)) !== 0) state.insertOnType.authoritative();
    if (update.result !== undefined && isCommitText(update.result)) state.resultEcho.expect(update.result);
    this.#applyImeUpdate(window, state, update);
    if (response.metadataChanged && update.preedit !== undefined && update.preedit !== null) {
      state.compositionAttributes = response.attributes;
      state.compositionClauses = response.clauses;
    }
    return true;
  }

  #setImeActive(window: Win32InputWindow, state: WindowInputState, active: boolean): void {
    const transition = state.activation.markActive(active);
    if (transition !== undefined) this.#enqueue(createImeActivationEvent(window, transition));
  }

  /** START is not activation proof; delayed composition traffic must delegate. */
  #acceptsNativeComposition(state: WindowInputState): boolean {
    return state.activation.desired && state.activation.focused && state.activation.active &&
      state.association.associated;
  }

  #reconcileIme(window: Win32InputWindow, state: WindowInputState): void {
    this.#reconcileImeAssociation(window, state);
    const transition = state.activation.reconcile({
      activate: () => state.association.associated,
      deactivate: () => {},
    });
    if (transition !== undefined) this.#enqueue(createImeActivationEvent(window, transition));
    if (state.activation.active) this.#applyImeCursorArea(window, state);
  }

  #reconcileImeAssociation(window: Win32InputWindow, state: WindowInputState): void {
    const apply = (associate: boolean) => {
      const changed = this.#imm32.symbols.ImmAssociateContextEx(
        window.hwnd,
        null,
        associate ? IACE_DEFAULT : 0,
      ) !== 0;
      if (changed && !associate) state.nativeCompositionDirty = false;
      return changed;
    };
    if (state.nativeCompositionDirty && !state.association.associated) {
      state.nativeCompositionDirty = false;
    }
    if (
      state.activation.shouldBeActive && state.nativeCompositionDirty &&
      !state.association.reconcile(false, apply)
    ) {
      throw new Error("winding(win32): failed to clean a dirty HIMC association");
    }
    if (!state.association.reconcile(state.activation.shouldBeActive, apply)) {
      throw new Error(
        state.activation.shouldBeActive
          ? "winding(win32): failed to associate the HIMC"
          : "winding(win32): failed to disassociate the HIMC",
      );
    }
    if (!state.association.associated) state.nativeCompositionDirty = false;
  }

  #cancelComposition(window: Win32InputWindow, state: WindowInputState): void {
    const cancelNativeComposition = state.composition.active;
    state.insertOnType.cancel();
    state.insertCharAssembler.reset();
    if (cancelNativeComposition) {
      // ImmNotifyIME can synchronously reenter the WndProc. Suppress both
      // character streams until native cancellation and local cleanup finish.
      state.cancelingComposition = true;
      state.charDecoder.reset();
      state.imeCharDecoder.reset();
    }
    let cancelError: Error | undefined;
    if (cancelNativeComposition) {
      try {
        const contextUsed = this.#withImeContext(window, (context) => {
          if (this.#imm32.symbols.ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0) === 0) {
            throw new Error("winding(win32): ImmNotifyIME cancellation failed");
          }
          return true;
        });
        if (contextUsed !== true) throw new Error("winding(win32): no HIMC was available for cancellation");
        state.nativeCompositionDirty = false;
      } catch (error) {
        state.nativeCompositionDirty = true;
        cancelError = error instanceof Error ? error : new Error(String(error));
      }
    }
    try {
      if (cancelNativeComposition) {
        state.charDecoder.reset();
        state.imeCharDecoder.reset();
      } else {
        this.#flushCharDecoder(window, state);
        this.#flushImeCharDecoder(window, state);
      }
      state.insertOnType.cancel();
      state.insertCharAssembler.reset();
      this.#queuePreedit(window, state.composition.cancel());
      this.#clearCompositionMetadata(state);
      state.resultEcho.clear();
    } finally {
      state.cancelingComposition = false;
    }
    if (cancelError !== undefined) throw cancelError;
  }

  #applyImeCursorArea(window: Win32InputWindow, state: WindowInputState): void {
    const logical = state.cursorArea;
    if (logical === undefined) return;
    const scale = window.devicePixelRatio;
    const rectangle = normalizeImeCursorArea(
      logical.x * scale,
      logical.y * scale,
      logical.width * scale,
      logical.height * scale,
    );
    if (rectangle === undefined) return;
    const applied = this.#withImeContext(window, (context) => {
      const errors: unknown[] = [];
      for (const index of IME_CANDIDATE_LIST_INDICES) {
        captureError(errors, () => {
          if (this.#imm32.symbols.ImmSetCandidateWindow(context, encodeCandidateForm(rectangle, index)) === 0) {
            throw new Error(`winding(win32): ImmSetCandidateWindow failed for candidate-list index ${index}`);
          }
        });
      }
      captureError(errors, () => {
        if (this.#imm32.symbols.ImmSetCompositionWindow(context, encodeCompositionForm(rectangle)) === 0) {
          throw new Error("winding(win32): ImmSetCompositionWindow failed");
        }
      });
      throwCollected(errors, "Failed to position Win32 IME windows");
      return true;
    });
    if (applied !== true) throw new Error("winding(win32): no HIMC was available for IME placement");
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
      editDisposition: win32KeyEditDisposition(keycode, key, isComposing, modifiers, text, systemMessage),
    })
    : createKeyUpEvent(init);
}

function throwCollected(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function captureError(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}
