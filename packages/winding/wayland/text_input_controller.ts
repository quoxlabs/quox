/** Native text-input-v3 focus, activation, batching, and proxy ownership. */

import type { UIEvent } from "../types.ts";
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
  readEventCount,
  throwCleanupErrors,
  type WaylandNativeLibrary,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";
import { type TextInputEdit, TextInputV3Batch } from "./text_input.ts";
import type { WaylandWindow } from "./window.ts";

export interface WaylandTextInputHost {
  readonly wl: WaylandNativeLibrary;
  readonly display: Deno.PointerObject;
  readonly zwpTextInputIface: Deno.PointerObject;
  readonly noop: AnyCallback;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
  windowForSurface(surface: Deno.PointerValue): WaylandWindow | null;
  keyboardFocus(): WaylandWindow | null;
  windows(): Iterable<WaylandWindow>;
  resetLocalCompose(): void;
}

export class WaylandTextInputController {
  #manager: Deno.PointerObject | null = null;
  #seat: Deno.PointerObject | null = null;
  #input: Deno.PointerObject | null = null;
  #focus: WaylandWindow | null = null;
  #enabledWindow: WaylandWindow | null = null;
  readonly #batch = new TextInputV3Batch();
  readonly #listeners: AnyCallback[] = [];
  #vtable: BigUint64Array<ArrayBuffer> | undefined;
  #closed = false;

  constructor(readonly host: WaylandTextInputHost) {}

  bindManager(manager: Deno.PointerObject): void {
    if (this.#closed) {
      this.#destroyManager(manager);
      return;
    }
    if (this.#manager) {
      this.#destroyManager(manager);
      return;
    }
    this.#manager = manager;
    this.#maybeInitialize();
  }

  setSeat(seat: Deno.PointerObject): void {
    if (this.#closed) return;
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
    this.#sendCursorArea(area);
    this.#commitState();
    this.host.wl.symbols.wl_display_flush(this.host.display);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    this.#focus = null;
    this.#enabledWindow = null;
    this.#seat = null;
    collectCleanupError(errors, () => this.#batch.resetEdits());

    const input = this.#input;
    this.#input = null;
    if (input) {
      collectCleanupError(errors, () => {
        this.host.wl.symbols.wl_proxy_marshal_array_flags(
          input,
          WlOp.ZWP_TEXT_INPUT_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    const manager = this.#manager;
    this.#manager = null;
    if (manager) collectCleanupError(errors, () => this.#destroyManager(manager));
    for (const callback of this.#listeners) {
      collectCleanupError(errors, () => callback.close());
    }
    this.#listeners.length = 0;
    this.#vtable = undefined;
    throwCleanupErrors("winding failed to close Wayland text input", errors);
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
        const window = this.host.windowForSurface(surface);
        if (window !== null && window === this.#focus) {
          this.syncWindow(window, true);
          return;
        }
        const previous = this.#enabledWindow ?? this.#focus;
        this.#focus = null;
        if (previous) this.syncWindow(previous, false);
        else this.#batch.resetEdits();
        this.#focus = window;
        if (window) this.syncWindow(window, true);
      }),
    );
    const leave = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _input, surface) => {
        const window = this.host.windowForSurface(surface);
        if (!window || window !== this.#focus) return;
        this.#focus = null;
        this.syncWindow(window, false);
      }),
    );
    const preedit = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer", "i32", "i32"], result: "void" },
      this.host.guardCallback((_data, _input, text, cursorBegin, cursorEnd) => {
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        const value = nullableCString(text);
        this.#batch.setPreedit(value, cursorBegin, cursorEnd);
        if (value !== null && value.length > 0) this.#focus.composition.start();
      }),
    );
    const commit = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _input, text) => {
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        this.#batch.setCommit(nullableCString(text));
      }),
    );
    const deletion = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _input, beforeBytes, afterBytes) => {
        if (!this.#focus || this.#enabledWindow !== this.#focus) return;
        this.#batch.setDeleteSurrounding(beforeBytes, afterBytes);
      }),
    );
    const done = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.host.guardCallback((_data, _input, serial) => {
        const window = this.#enabledWindow;
        if (!window || window !== this.#focus) {
          this.#batch.resetEdits();
          return;
        }
        this.#emitEdits(window, this.#batch.done(serial).edits);
      }),
    );
    this.#listeners.push(enter, leave, preedit, commit, deletion, done);
    this.#vtable = makeVtable(
      [enter, leave, preedit, commit, deletion, done],
      readEventCount(Deno.UnsafePointer.value(this.host.zwpTextInputIface)),
      this.host.noop,
    );
    this.host.wl.symbols.wl_proxy_add_listener(input, Deno.UnsafePointer.of(this.#vtable), null);
  }

  #reconcile(window: WaylandWindow, sendProtocol: boolean): void {
    const transition = window.imeActivation.reconcile({
      activate: () => {
        if (
          !this.#input || this.host.keyboardFocus() !== window || this.#focus !== window ||
          this.#enabledWindow !== null
        ) return false;
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
        if (window.imeCursorArea) this.#sendCursorArea(window.imeCursorArea);
        this.#commitState();
        this.#enabledWindow = window;
        this.host.wl.symbols.wl_display_flush(this.host.display);
        return true;
      },
      deactivate: () => {
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
          this.host.wl.symbols.wl_display_flush(this.host.display);
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

  #commitState(): void {
    if (!this.#input) return;
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
    for (const edit of edits) {
      switch (edit.type) {
        case "preedit": {
          const update = edit.text.length === 0
            ? window.composition.cancel()
            : window.composition.update(edit.text, edit.cursorRange);
          if (update !== undefined) {
            this.host.pushEvent(createImePreeditEvent(window, update.text, update.cursorRange));
          }
          break;
        }
        case "deleteSurrounding": {
          const event = createImeDeleteSurroundingEvent(window, edit.beforeBytes, edit.afterBytes);
          if (event !== undefined) this.host.pushEvent(event);
          break;
        }
        case "commit": {
          window.composition.commit();
          const event = createImeCommitEvent(window, edit.text);
          if (event !== undefined) this.host.pushEvent(event);
          break;
        }
        default:
          assertNever(edit);
      }
    }
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
