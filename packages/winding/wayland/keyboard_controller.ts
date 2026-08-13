/** wl_keyboard proxy, focus, repeat, and canonical semantic event routing. */

import type { UIEvent } from "../types.ts";
import { createKeyDownEvent, createKeyUpEvent, createTextInputEvent } from "../input/mod.ts";
import { domCodeFromEvdev } from "../linux/mod.ts";
import { WlOp, type xkbSymbols } from "./ffi.ts";
import { waylandKeyEditDisposition } from "./keyboard.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  type LibcLibrary,
  makeVtable,
  readEventCount,
  throwCleanupErrors,
  type WaylandNativeLibrary,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";
import type { WaylandWindow } from "./window.ts";
import { WaylandXkbController } from "./xkb_controller.ts";

export interface WaylandKeyboardHost {
  readonly wl: WaylandNativeLibrary;
  readonly xkb: Deno.DynamicLibrary<typeof xkbSymbols>;
  readonly libc: LibcLibrary;
  readonly keyboardIface: Deno.PointerObject;
  readonly noop: AnyCallback;
  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void;
  pushEvent(event: UIEvent): void;
  windowForSurface(surface: Deno.PointerValue): WaylandWindow | null;
}

export class WaylandKeyboardController {
  readonly #input: WaylandXkbController;
  #keyboard: Deno.PointerObject | null = null;
  #focus: WaylandWindow | null = null;
  #listeners: AnyCallback[] = [];
  #vtable: BigUint64Array<ArrayBuffer> | undefined;
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

  acquire(seat: Deno.PointerObject): void {
    if (this.#closed || this.#keyboard) return;
    const symbols = this.host.wl.symbols;
    const keyboard = symbols.wl_proxy_marshal_array_flags(
      seat,
      WlOp.SEAT_GET_KEYBOARD,
      this.host.keyboardIface,
      symbols.wl_proxy_get_version(seat),
      0,
      args(0n),
    );
    if (!keyboard) return;
    this.#keyboard = keyboard;
    this.#installListeners(keyboard);
  }

  removeWindow(window: WaylandWindow): void {
    if (this.#focus !== window) return;
    this.#focus = null;
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
    collectCleanupError(errors, () => this.#input.setRepeatInfo(0, 0));
    collectCleanupError(errors, () => this.#input.resetTransientState());
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
    if (focusedWindow) this.host.pushEvent({ type: "blur", window: focusedWindow });
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
        this.#input.loadKeymap(format, fd, size);
      }),
    );
    const enter = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer", "pointer"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, surface) => {
        const window = this.host.windowForSurface(surface);
        if (!window || this.#focus === window) return;
        if (this.#focus) {
          const previous = this.#focus;
          this.#focus = null;
          this.host.pushEvent({ type: "blur", window: previous });
        }
        this.#input.resetTransientState();
        this.#focus = window;
        this.host.pushEvent({ type: "focus", window });
      }),
    );
    const leave = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, surface) => {
        const window = this.host.windowForSurface(surface);
        if (!window || this.#focus !== window) return;
        this.#input.resetTransientState();
        this.#focus = null;
        this.host.pushEvent({ type: "blur", window });
      }),
    );
    const key = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, _time, rawKeycode, state) => {
        if (state) {
          if (!this.#focus) return;
          this.#emitKey(rawKeycode, "press");
          this.#input.pressRepeat(rawKeycode);
        } else {
          this.#input.releaseRepeat(rawKeycode);
          this.#emitKey(rawKeycode, "release");
        }
      }),
    );
    const modifiers = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32", "u32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, _serial, depressed, latched, locked, group) => {
        this.#input.updateModifiers(depressed, latched, locked, group);
      }),
    );
    const repeatInfo = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32"], result: "void" },
      this.host.guardCallback((_data, _keyboard, rate, delay) => {
        this.#input.setRepeatInfo(rate, delay);
      }),
    );
    this.#listeners = [keymap, enter, leave, key, modifiers, repeatInfo];
    this.#vtable = makeVtable(
      this.#listeners,
      readEventCount(Deno.UnsafePointer.value(this.host.keyboardIface)),
      this.host.noop,
    );
    this.host.wl.symbols.wl_proxy_add_listener(keyboard, Deno.UnsafePointer.of(this.#vtable), null);
  }

  #emitKey(rawKeycode: number, phase: "press" | "release" | "repeat"): void {
    const window = this.#focus;
    if (!window) return;
    const translated = this.#input.translate(rawKeycode, phase, true);
    const modifiers = this.#input.modifiers;
    const code = domCodeFromEvdev(rawKeycode);
    if (phase === "release") {
      this.host.pushEvent(createKeyUpEvent({
        window,
        keycode: rawKeycode,
        code,
        key: this.#input.releaseLogical(rawKeycode, translated.key),
        ...modifiers,
      }));
      return;
    }

    const key = this.#input.pressLogical(rawKeycode, translated.key);
    const disposition = waylandKeyEditDisposition(
      key,
      translated.text,
      translated.composePending,
      modifiers,
    );
    this.host.pushEvent(createKeyDownEvent({
      window,
      keycode: rawKeycode,
      code,
      key,
      repeat: phase === "repeat",
      editDisposition: disposition,
      ...modifiers,
    }));

    if (translated.composePending) return;
    if (translated.text !== undefined && disposition === "text-input") {
      const commit = createTextInputEvent(window, translated.text);
      if (commit !== undefined) this.host.pushEvent(commit);
    }
  }
}
