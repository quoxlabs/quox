/** Native text-input-v3 focus, activation, batching, and proxy ownership. */

import type { UIEvent } from "../types.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import {
  createImeActivationEvent,
  createImeCommitEvent,
  createImeDeleteSurroundingEvent,
  createImePreeditEvent,
} from "../input/mod.ts";
import { WlOp } from "./ffi.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  makeVtable,
  nullableCString,
  TEXT_INPUT_V3_EVENT_SIGNATURES,
  throwCleanupErrors,
  type WaylandNativeLibrary,
  type WaylandNoopCallbacks,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";
import {
  type TextInputEdit,
  TextInputV3Batch,
  TextInputV3SerialGate,
  type WaylandSurroundingTextState,
} from "./text_input.ts";
import type { WaylandWindow } from "./window.ts";

export interface WaylandTextInputHost {
  readonly wl: WaylandNativeLibrary;
  readonly zwpTextInputIface: Deno.PointerObject;
  readonly noops: WaylandNoopCallbacks;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
  windowForSurface(surface: Deno.PointerValue): WaylandWindow | null;
  keyboardFocus(): WaylandWindow | null;
  windows(): Iterable<WaylandWindow>;
  resetLocalCompose(): void;
  flushDisplay(context: string): void;
}

/** Apply one compositor-owned text-input batch and abandon any pending local key composition. */
export function emitWaylandTextInputEdits(
  host: Pick<WaylandTextInputHost, "pushEvent" | "resetLocalCompose">,
  window: WaylandWindow,
  edits: readonly TextInputEdit[],
): void {
  // A native edit means the text service owned the corresponding key sequence. Drop any
  // locally pending dead-key sequence before applying it, while continuing to use local
  // Compose for ordinary wl_keyboard events that the text service did not consume.
  if (edits.length > 0) host.resetLocalCompose();
  for (const edit of edits) {
    switch (edit.type) {
      case "preedit": {
        const update = edit.text.length === 0
          ? window.composition.cancel()
          : window.composition.update(edit.text, edit.cursorRange);
        if (update !== undefined) {
          host.pushEvent(createImePreeditEvent(window, update.text, update.cursorRange));
        }
        break;
      }
      case "deleteSurrounding": {
        const event = createImeDeleteSurroundingEvent(window, edit.beforeBytes, edit.afterBytes);
        if (event !== undefined) host.pushEvent(event);
        break;
      }
      case "commit": {
        const event = createImeCommitEvent(window, edit.text);
        if (event !== undefined) {
          window.composition.commit();
          host.pushEvent(event);
        }
        break;
      }
      default:
        assertNever(edit);
    }
  }
}

export class WaylandTextInputController {
  #manager: Deno.PointerObject | null = null;
  #seat: Deno.PointerObject | null = null;
  #input: Deno.PointerObject | null = null;
  #focus: WaylandWindow | null = null;
  #enabledWindow: WaylandWindow | null = null;
  readonly #batch = new TextInputV3Batch();
  readonly #serialGate = new TextInputV3SerialGate();
  readonly #listeners: AnyCallback[] = [];
  #vtable: BigUint64Array<ArrayBuffer> | undefined;
  #closed = false;

  constructor(readonly host: WaylandTextInputHost) {}

  bindManager(manager: Deno.PointerObject): boolean {
    if (this.#closed) {
      this.#destroyManager(manager);
      return false;
    }
    if (this.#manager) {
      this.#destroyManager(manager);
      return false;
    }
    this.#manager = manager;
    this.#maybeInitialize();
    return true;
  }

  unbindManager(manager: Deno.PointerObject): void {
    if (this.#manager !== manager) return;
    this.#manager = null;
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.#releaseInput());
    collectCleanupError(errors, () => this.#destroyManager(manager));
    throwCleanupErrors("winding failed to release the Wayland text-input manager", errors);
  }

  setSeat(seat: Deno.PointerObject | null): void {
    if (this.#closed) return;
    if (this.#seat === seat) return;
    this.#releaseInput();
    this.#seat = seat;
    this.#maybeInitialize();
  }

  registerWindow(window: WaylandWindow): void {
    window.imeActivation.setAvailable(this.#input !== null);
  }

  removeWindow(window: WaylandWindow): void {
    const errors: unknown[] = [];
    collectCleanupError(errors, () => window.imeActivation.setDesired(false));
    collectCleanupError(errors, () => window.imeActivation.setFocused(false));
    if (this.#focus === window || this.#enabledWindow === window) {
      this.#serialGate.reset();
      collectCleanupError(errors, () => this.#reconcile(window, true));
      if (this.#focus === window) this.#focus = null;
      if (this.#enabledWindow === window) this.#enabledWindow = null;
    }
    collectCleanupError(errors, () => window.imeActivation.setAvailable(false));
    collectCleanupError(errors, () => window.imeActivation.reset());
    collectCleanupError(errors, () => window.composition.reset());
    throwCleanupErrors("winding failed to detach Wayland text input", errors);
  }

  syncWindow(window: WaylandWindow, sendProtocol = true): void {
    window.imeActivation.setAvailable(this.#input !== null);
    window.imeActivation.setFocused(
      this.host.keyboardFocus() === window && this.#focus === window,
    );
    this.#reconcile(window, sendProtocol);
  }

  updateCursorArea(window: WaylandWindow): void {
    const area = window.imeCursorArea;
    if (!area || this.#enabledWindow !== window || this.#focus !== window || !this.#input) return;
    this.#serialGate.sendState(() => {
      this.#sendCursorArea(area);
      this.#commitState();
      this.host.flushDisplay("updating the text-input cursor rectangle");
    });
  }

  updateSurroundingText(window: WaylandWindow): void {
    const surrounding = window.imeSurroundingText;
    if (!surrounding || this.#enabledWindow !== window || this.#focus !== window || !this.#input) return;
    this.#serialGate.sendState(() => {
      this.#sendSurroundingText(surrounding);
      this.#commitState();
      this.host.flushDisplay("updating text-input surrounding text");
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    this.#seat = null;
    collectCleanupError(errors, () => this.#releaseInput());
    const manager = this.#manager;
    this.#manager = null;
    if (manager) collectCleanupError(errors, () => this.#destroyManager(manager));
    throwCleanupErrors("winding failed to close Wayland text input", errors);
  }

  #releaseInput(): void {
    const input = this.#input;
    const affectedWindow = this.#enabledWindow ?? this.#focus;
    this.#input = null;
    this.#focus = null;
    this.#enabledWindow = null;
    this.#serialGate.reset();
    const listeners = this.#listeners.splice(0);
    this.#vtable = undefined;

    const errors: unknown[] = [];
    if (affectedWindow) {
      collectCleanupError(errors, () => this.#emitEdits(affectedWindow, this.#batch.resetProtocolState()));
      collectCleanupError(errors, () => {
        const clear = affectedWindow.composition.cancel();
        if (clear !== undefined) {
          this.host.pushEvent(createImePreeditEvent(affectedWindow, clear.text, clear.cursorRange));
        }
      });
    } else {
      collectCleanupError(errors, () => this.#batch.resetProtocolState());
    }
    for (const window of this.host.windows()) {
      collectCleanupError(errors, () => window.imeActivation.setFocused(false));
      collectCleanupError(errors, () => window.imeActivation.setAvailable(false));
      collectCleanupError(errors, () => {
        const transition = window.imeActivation.forceInactive();
        if (transition !== undefined) this.host.pushEvent(createImeActivationEvent(window, transition));
      });
    }
    if (input) {
      collectCleanupError(errors, () => {
        this.host.wl.symbols.wl_proxy_marshal_array_flags(
          input,
          WlOp.ZWP_TEXT_INPUT_DESTROY,
          null,
          this.host.wl.symbols.wl_proxy_get_version(input),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    for (const callback of listeners) {
      collectCleanupError(errors, () => callback.close());
    }
    throwCleanupErrors("winding failed to release Wayland text input", errors);
  }

  #maybeInitialize(): void {
    if (this.#input || !this.#manager || !this.#seat) return;
    const symbols = this.host.wl.symbols;
    const input = symbols.wl_proxy_marshal_array_flags(
      this.#manager,
      WlOp.ZWP_TEXT_INPUT_MANAGER_GET_TEXT_INPUT,
      this.host.zwpTextInputIface,
      symbols.wl_proxy_get_version(this.#manager),
      0,
      args(0n, Deno.UnsafePointer.value(this.#seat)),
    );
    if (!input) return;
    this.#input = input;
    for (const window of this.host.windows()) window.imeActivation.setAvailable(true);
    this.#installListeners(input);
  }

  #installListeners(input: Deno.PointerObject): void {
    const enter = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _input, surface) => {
        if (this.#input !== input) return;
        const window = this.host.windowForSurface(surface);
        if (window !== null && window === this.#focus) {
          this.syncWindow(window, true);
          return;
        }
        this.#serialGate.reset();
        const previous = this.#enabledWindow ?? this.#focus;
        this.#focus = null;
        if (previous) this.syncWindow(previous, false);
        else this.#batch.resetEdits();
        this.#focus = window;
        if (window) this.syncWindow(window, true);
      }),
    );
    this.#listeners.push(enter);
    const leave = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _input, surface) => {
        if (this.#input !== input) return;
        const window = this.host.windowForSurface(surface);
        if (!window || window !== this.#focus) return;
        this.#serialGate.reset();
        this.#focus = null;
        this.syncWindow(window, false);
      }),
    );
    this.#listeners.push(leave);
    const preedit = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer", "i32", "i32"], result: "void" },
      this.host.guardCallback((_data, _input, text, cursorBegin, cursorEnd) => {
        if (this.#input !== input) return;
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        const value = nullableCString(text);
        this.#batch.setPreedit(value, cursorBegin, cursorEnd);
        if (value !== null && value.length > 0) this.#focus.composition.start();
      }),
    );
    this.#listeners.push(preedit);
    const commit = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _input, text) => {
        if (this.#input !== input) return;
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        this.#batch.setCommit(nullableCString(text));
      }),
    );
    this.#listeners.push(commit);
    const deletion = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _input, beforeBytes, afterBytes) => {
        if (this.#input !== input) return;
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        this.#batch.setDeleteSurrounding(beforeBytes, afterBytes);
      }),
    );
    this.#listeners.push(deletion);
    const done = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.host.guardCallback((_data, _input, serial) => {
        if (this.#input !== input) return;
        const window = this.#enabledWindow;
        if (!window || window !== this.#focus) {
          this.#serialGate.reset();
          this.#batch.resetEdits();
          return;
        }
        const result = this.#batch.done(serial);
        this.#serialGate.handleDone(result.serialMatches, () => this.#emitEdits(window, result.edits));
      }),
    );
    this.#listeners.push(done);
    this.#vtable = makeVtable(
      [enter, leave, preedit, commit, deletion, done],
      TEXT_INPUT_V3_EVENT_SIGNATURES,
      this.host.noops,
    );
    if (this.host.wl.symbols.wl_proxy_add_listener(input, Deno.UnsafePointer.of(this.#vtable), null) !== 0) {
      throw new Error("winding failed to listen to Wayland text input");
    }
  }

  #reconcile(window: WaylandWindow, sendProtocol: boolean): void {
    const transition = window.imeActivation.reconcile({
      activate: () => {
        if (
          !this.#input || this.host.keyboardFocus() !== window || this.#focus !== window ||
          this.#enabledWindow !== null
        ) return false;
        this.#serialGate.reset();
        this.host.resetLocalCompose();
        const clear = window.composition.cancel();
        if (clear !== undefined) {
          this.host.pushEvent(createImePreeditEvent(window, clear.text, clear.cursorRange));
        }
        this.host.wl.symbols.wl_proxy_marshal_array_flags(
          this.#input,
          WlOp.ZWP_TEXT_INPUT_ENABLE,
          null,
          1,
          0,
          args(),
        );
        this.#sendFullState(window);
        this.#commitState();
        this.#enabledWindow = window;
        this.host.flushDisplay("enabling text input");
        return true;
      },
      deactivate: () => {
        this.#serialGate.reset();
        this.#emitEdits(window, this.#batch.resetEdits());
        const clear = window.composition.cancel();
        if (clear !== undefined) {
          this.host.pushEvent(createImePreeditEvent(window, clear.text, clear.cursorRange));
        }
        if (sendProtocol && this.#input && this.#focus === window) {
          this.host.wl.symbols.wl_proxy_marshal_array_flags(
            this.#input,
            WlOp.ZWP_TEXT_INPUT_DISABLE,
            null,
            1,
            0,
            args(),
          );
          this.#commitState();
          this.host.flushDisplay("disabling text input");
        }
        if (this.#enabledWindow === window) this.#enabledWindow = null;
      },
    });
    if (transition !== undefined) {
      this.host.pushEvent(createImeActivationEvent(window, transition));
    }
  }

  #sendCursorArea(area: { x: number; y: number; width: number; height: number }): void {
    if (!this.#input) return;
    this.host.wl.symbols.wl_proxy_marshal_array_flags(
      this.#input,
      WlOp.ZWP_TEXT_INPUT_SET_CURSOR_RECTANGLE,
      null,
      1,
      0,
      args(BigInt(area.x), BigInt(area.y), BigInt(area.width), BigInt(area.height)),
    );
  }

  #sendFullState(window: WaylandWindow): void {
    if (window.imeSurroundingText) this.#sendSurroundingText(window.imeSurroundingText);
    if (window.imeCursorArea) this.#sendCursorArea(window.imeCursorArea);
  }

  #resendFullState(window: WaylandWindow): void {
    if (!this.#input || this.#enabledWindow !== window || this.#focus !== window) return;
    this.#sendFullState(window);
    this.#commitState();
    this.host.flushDisplay("resynchronizing text-input state");
  }

  /** Send deferred state only after the application has consumed every edit in the done batch. */
  flushPendingState(): void {
    this.#serialGate.finishRecovery(() => {
      const window = this.#enabledWindow;
      if (!window || window !== this.#focus) return;
      this.#resendFullState(window);
    });
  }

  #sendSurroundingText(surrounding: WaylandSurroundingTextState): void {
    if (!this.#input) return;
    const text = cStr(surrounding.wireText);
    this.host.wl.symbols.wl_proxy_marshal_array_flags(
      this.#input,
      WlOp.ZWP_TEXT_INPUT_SET_SURROUNDING_TEXT,
      null,
      1,
      0,
      args(
        Deno.UnsafePointer.value(Deno.UnsafePointer.of(text)),
        BigInt(surrounding.cursorBytes),
        BigInt(surrounding.anchorBytes),
      ),
    );
  }

  #commitState(): void {
    if (!this.#input || this.#serialGate.blocksState) return;
    this.host.wl.symbols.wl_proxy_marshal_array_flags(
      this.#input,
      WlOp.ZWP_TEXT_INPUT_COMMIT,
      null,
      1,
      0,
      args(),
    );
    this.#batch.recordClientCommit();
  }

  #emitEdits(window: WaylandWindow, edits: TextInputEdit[]): void {
    emitWaylandTextInputEdits(this.host, window, edits);
  }

  #destroyManager(manager: Deno.PointerObject): void {
    this.host.wl.symbols.wl_proxy_marshal_array_flags(
      manager,
      WlOp.ZWP_TEXT_INPUT_MANAGER_DESTROY,
      null,
      1,
      WL_MARSHAL_FLAG_DESTROY,
      args(),
    );
  }
}

function assertNever(_value: never): never {
  throw new TypeError("Unsupported Wayland text-input edit");
}
