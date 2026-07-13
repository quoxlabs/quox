/** wl_keyboard proxy, focus, repeat, and canonical semantic event routing. */

import type { KeyModifiers, UIEvent } from "../types.ts";
import { createImeCommitEvent, createImePreeditEvent, createKeyDownEvent, createKeyUpEvent } from "../input/mod.ts";
import { domCodeFromEvdev, keyLocationHintForKeysym } from "../linux/mod.ts";
import { WlOp, type xkbSymbols } from "./ffi.ts";
import { WaylandEnterKeyBatch, waylandKeyEditDisposition } from "./keyboard.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  KEYBOARD_EVENT_SIGNATURES,
  type LibcLibrary,
  makeVtable,
  readWlArrayU32,
  throwCleanupErrors,
  type WaylandNativeLibrary,
  type WaylandNoopCallbacks,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";
import type { WaylandWindow } from "./window.ts";
import { WaylandXkbController } from "./xkb_controller.ts";

export interface WaylandKeyboardHost {
  readonly wl: WaylandNativeLibrary;
  readonly xkb: Deno.DynamicLibrary<typeof xkbSymbols>;
  readonly libc: LibcLibrary;
  readonly keyboardIface: Deno.PointerObject;
  readonly noops: WaylandNoopCallbacks;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
  windowForSurface(surface: Deno.PointerValue): WaylandWindow | null;
  syncTextInput(window: WaylandWindow): void;
}

export class WaylandKeyboardController {
  readonly #input: WaylandXkbController;
  #keyboard: Deno.PointerObject | null = null;
  #focus: WaylandWindow | null = null;
  #listeners: AnyCallback[] = [];
  #vtable: BigUint64Array<ArrayBuffer> | undefined;
  readonly #enterKeys = new WaylandEnterKeyBatch();
  #closed = false;

  constructor(readonly host: WaylandKeyboardHost) {
    this.#input = new WaylandXkbController(host.xkb, host.libc);
  }

  get focus(): WaylandWindow | null {
    return this.#focus;
  }

  get active(): boolean {
    return this.#keyboard !== null;
  }

  get modifiers(): KeyModifiers {
    return this.#input.modifiers;
  }

  acquire(seat: Deno.PointerObject): boolean {
    if (this.#closed || this.#keyboard) return false;
    const symbols = this.host.wl.symbols;
    const keyboard = symbols.wl_proxy_marshal_array_flags(
      seat,
      WlOp.SEAT_GET_KEYBOARD,
      this.host.keyboardIface,
      symbols.wl_proxy_get_version(seat),
      0,
      args(0n),
    );
    if (!keyboard) return false;
    this.#keyboard = keyboard;
    try {
      this.#installListeners(keyboard);
      return true;
    } catch (error) {
      try {
        this.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to acquire and unwind the Wayland keyboard");
      }
      throw error;
    }
  }

  resetCompose(): void {
    this.#input.resetCompose();
  }

  removeWindow(window: WaylandWindow): void {
    if (this.#focus !== window) return;
    this.#focus = null;
    this.#enterKeys.reset();
    this.#input.resetTransientState();
  }

  enqueueDueRepeat(): void {
    const rawKeycode = this.#input.pollRepeat();
    if (rawKeycode === undefined) return;
    if (!this.#focus) {
      this.#input.resetTransientState();
      return;
    }
    this.#emitKey(rawKeycode, "repeat");
  }

  release(): void {
    const keyboard = this.#keyboard;
    if (!keyboard) return;
    this.#keyboard = null;
    const focusedWindow = this.#focus;
    this.#focus = null;
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.#enterKeys.reset());
    collectCleanupError(errors, () => this.#input.setRepeatInfo(0, 0));
    collectCleanupError(errors, () => this.#input.resetTransientState());
    if (focusedWindow) {
      collectCleanupError(errors, () => this.host.syncTextInput(focusedWindow));
    }
    collectCleanupError(errors, () => {
      const version = this.host.wl.symbols.wl_proxy_get_version(keyboard);
      if (version >= 3) {
        this.host.wl.symbols.wl_proxy_marshal_array_flags(
          keyboard,
          WlOp.KEYBOARD_RELEASE,
          null,
          version,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      } else {
        this.host.wl.symbols.wl_proxy_destroy(keyboard);
      }
    });
    collectCleanupError(errors, () => this.#input.clearKeymap());
    if (focusedWindow) {
      const clear = focusedWindow.composition.cancel();
      if (clear !== undefined) {
        this.host.pushEvent(createImePreeditEvent(focusedWindow, clear.text, clear.cursorRange));
      }
      this.host.pushEvent({ type: "blur", window: focusedWindow });
    }
    for (const callback of this.#listeners) {
      collectCleanupError(errors, () => callback.close());
    }
    this.#listeners = [];
    this.#vtable = undefined;
    throwCleanupErrors("winding failed to release Wayland keyboard", errors);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.release());
    collectCleanupError(errors, () => this.#input.close());
    throwCleanupErrors("winding failed to close Wayland keyboard", errors);
  }

  #installListeners(keyboard: Deno.PointerObject): void {
    const keymap = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "i32", "u32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, format, fd, size) => {
        if (this.#keyboard !== keyboard) {
          if (fd >= 0) this.host.libc.symbols.close(fd);
          return;
        }
        this.#enterKeys.reset();
        this.#input.loadKeymap(format, fd, size);
      }),
    );
    this.#listeners.push(keymap);
    const enter = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, surface, keys) => {
        if (this.#keyboard !== keyboard) return;
        const window = this.host.windowForSurface(surface);
        if (!window || this.#focus === window) return;
        if (this.#focus) {
          const previous = this.#focus;
          this.#focus = null;
          this.host.syncTextInput(previous);
          const clear = previous.composition.cancel();
          if (clear !== undefined) {
            this.host.pushEvent(createImePreeditEvent(previous, clear.text, clear.cursorRange));
          }
          this.host.pushEvent({ type: "blur", window: previous });
        }
        this.#input.resetTransientState();
        this.#enterKeys.begin(readWlArrayU32(keys));
        this.#focus = window;
        this.host.pushEvent({ type: "focus", window });
        this.host.syncTextInput(window);
      }),
    );
    this.#listeners.push(enter);
    const leave = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, surface) => {
        if (this.#keyboard !== keyboard) return;
        const window = this.host.windowForSurface(surface);
        if (!window || this.#focus !== window) return;
        this.#enterKeys.reset();
        this.#input.resetTransientState();
        this.#focus = null;
        this.host.syncTextInput(window);
        const clear = window.composition.cancel();
        if (clear !== undefined) {
          this.host.pushEvent(createImePreeditEvent(window, clear.text, clear.cursorRange));
        }
        this.host.pushEvent({ type: "blur", window });
      }),
    );
    this.#listeners.push(leave);
    const key = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, _time, rawKeycode, state) => {
        if (this.#keyboard !== keyboard) return;
        const transition = { rawKeycode, pressed: state !== 0 };
        if (this.#enterKeys.defer(transition)) return;
        this.#dispatchProtocolKey(transition.rawKeycode, transition.pressed);
      }),
    );
    this.#listeners.push(key);
    const modifiers = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, depressed, latched, locked, group) => {
        if (this.#keyboard !== keyboard) return;
        this.#input.updateModifiers(depressed, latched, locked, group);
        const entered = this.#enterKeys.complete();
        if (entered === undefined) return;
        this.#input.seedHeldKeys(entered.heldKeys);
        for (const transition of entered.deferredTransitions) {
          this.#dispatchProtocolKey(transition.rawKeycode, transition.pressed);
        }
      }),
    );
    this.#listeners.push(modifiers);
    const repeatInfo = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, rate, delay) => {
        if (this.#keyboard !== keyboard) return;
        this.#input.setRepeatInfo(rate, delay);
      }),
    );
    this.#listeners.push(repeatInfo);
    this.#vtable = makeVtable(
      this.#listeners,
      KEYBOARD_EVENT_SIGNATURES,
      this.host.noops,
    );
    if (this.host.wl.symbols.wl_proxy_add_listener(keyboard, Deno.UnsafePointer.of(this.#vtable), null) !== 0) {
      throw new Error("winding failed to listen to the Wayland keyboard");
    }
  }

  #dispatchProtocolKey(rawKeycode: number, pressed: boolean): void {
    if (pressed) {
      if (!this.#focus) return;
      this.#emitKey(rawKeycode, "press");
      this.#input.pressRepeat(rawKeycode);
      return;
    }
    this.#input.releaseRepeat(rawKeycode);
    this.#emitKey(rawKeycode, "release");
  }

  #emitKey(rawKeycode: number, phase: "press" | "release" | "repeat"): void {
    const window = this.#focus;
    if (!window) return;
    const wasComposing = window.composition.active;
    const translated = this.#input.translateDeliveredKey(rawKeycode, phase);
    const resolved = this.#input.resolveLogicalTransition(rawKeycode, phase, translated.key);
    const modifiers = resolved.modifiers;
    const code = domCodeFromEvdev(rawKeycode);
    if (phase === "release") {
      this.host.pushEvent(createKeyUpEvent({
        window,
        keycode: rawKeycode,
        code,
        key: resolved.key,
        location: keyLocationHintForKeysym(translated.keysym),
        isComposing: wasComposing,
        ...modifiers,
      }));
      return;
    }

    const key = resolved.key;
    const disposition = waylandKeyEditDisposition(
      key,
      translated.text,
      wasComposing || translated.isComposing,
      modifiers,
    );
    this.host.pushEvent(createKeyDownEvent({
      window,
      keycode: rawKeycode,
      code,
      key,
      location: keyLocationHintForKeysym(translated.keysym),
      isComposing: wasComposing,
      repeat: phase === "repeat",
      editDisposition: disposition,
      ...modifiers,
    }));

    if (translated.isComposing) {
      window.composition.start();
      return;
    }
    if (translated.text !== undefined && disposition === "text-input") {
      window.composition.commit();
      const commit = createImeCommitEvent(window, translated.text);
      if (commit !== undefined) this.host.pushEvent(commit);
      return;
    }
    if (wasComposing) {
      const clear = window.composition.cancel();
      if (clear !== undefined) {
        this.host.pushEvent(createImePreeditEvent(window, clear.text, clear.cursorRange));
      }
    }
  }
}
