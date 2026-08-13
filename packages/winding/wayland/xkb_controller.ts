/** Native xkbcommon ownership and keyboard transition state for Wayland. */

import type { KeyModifiers } from "../types.ts";
import { PressedLogicalKeyCache } from "../input/mod.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { type xkbSymbols } from "./ffi.ts";
import {
  type ComposeAdapter,
  KeyRepeatController,
  resolveComposeLocale,
  type TranslatedKey,
  translateKey,
  type XkbKeyTranslator,
} from "./keyboard.ts";
import {
  collectCleanupError,
  type LibcLibrary,
  MAP_FAILED,
  MAP_PRIVATE,
  PROT_READ,
  throwCleanupErrors,
} from "./protocol.ts";

const WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 = 1;
const XKB_CONTEXT_NO_FLAGS = 0;
const XKB_KEYMAP_FORMAT_TEXT_V1 = 1;
const XKB_KEYMAP_COMPILE_NO_FLAGS = 0;
const XKB_STATE_MODS_EFFECTIVE = 1 << 3;
const XKB_COMPOSE_COMPILE_NO_FLAGS = 0;
const XKB_COMPOSE_STATE_NO_FLAGS = 0;
const XKB_SHIFT_MASK = 1 << 0;
const XKB_LOCK_MASK = 1 << 1;
const XKB_CONTROL_MASK = 1 << 2;
const XKB_ALT_MASK = 1 << 3;
const XKB_META_MASK = 1 << 6;
const XKB_MOD_SHIFT = cStr("Shift");
const XKB_MOD_CONTROL = cStr("Control");
const XKB_MOD_ALT = cStr("Mod1");
const XKB_MOD_META = cStr("Mod4");
const XKB_MOD_LEVEL_THREE = cStr("LevelThree");
const XKB_MOD5 = cStr("Mod5");
const XKB_MOD_LOCK = cStr("Lock");

type XkbLibrary = Deno.DynamicLibrary<typeof xkbSymbols>;
export type WaylandKeyPhase = "press" | "release" | "repeat";

export class WaylandXkbController {
  readonly #context: Deno.PointerObject;
  #composeTable: Deno.PointerObject | null = null;
  #composeState: Deno.PointerObject | null = null;
  #keymap: Deno.PointerObject | null = null;
  #state: Deno.PointerObject | null = null;
  #modifiers = modifiersFromMask(0);
  readonly #repeat = new KeyRepeatController();
  readonly #pressedKeys = new PressedLogicalKeyCache<number>();
  #closed = false;

  constructor(readonly xkb: XkbLibrary, readonly libc: LibcLibrary) {
    const context = xkb.symbols.xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!context) throw new Error("winding failed to create xkb context");
    this.#context = context;
    this.#initCompose();
  }

  get modifiers(): KeyModifiers {
    return this.#modifiers;
  }

  translate(rawKeycode: number, phase: WaylandKeyPhase, useCompose: boolean): TranslatedKey {
    const translator = this.#translator();
    if (!translator) {
      return {
        rawKeycode,
        xkbKeycode: rawKeycode + 8,
        keysym: 0,
        key: "Unidentified",
        composePending: false,
      };
    }
    return translateKey(rawKeycode, phase, translator, useCompose ? this.#composeAdapter() : undefined);
  }

  pressLogical(rawKeycode: number, logicalKey: string): string {
    return this.#pressedKeys.press(rawKeycode, logicalKey);
  }

  releaseLogical(rawKeycode: number, fallback: string): string {
    return this.#pressedKeys.release(rawKeycode, fallback);
  }

  keyRepeats(rawKeycode: number): boolean {
    return this.#keymap ? this.xkb.symbols.xkb_keymap_key_repeats(this.#keymap, rawKeycode + 8) > 0 : false;
  }

  setRepeatInfo(rate: number, delay: number): void {
    this.#repeat.setRepeatInfo(rate, delay);
  }

  pressRepeat(rawKeycode: number): void {
    this.#repeat.press(rawKeycode, this.keyRepeats(rawKeycode));
  }

  releaseRepeat(rawKeycode: number): void {
    this.#repeat.release(rawKeycode);
  }

  pollRepeat(): number | undefined {
    return this.#repeat.poll();
  }

  resetTransientState(): void {
    this.#repeat.cancel();
    this.#pressedKeys.clear();
    this.resetCompose();
  }

  resetCompose(): void {
    if (this.#composeState) this.xkb.symbols.xkb_compose_state_reset(this.#composeState);
  }

  loadKeymap(format: number, fd: number, size: number): void {
    try {
      if (format !== WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 || size === 0) return;
      const byteLength = BigInt(size);
      const mapped = this.libc.symbols.mmap(null, byteLength, PROT_READ, MAP_PRIVATE, fd, 0n);
      if (!mapped || Deno.UnsafePointer.value(mapped) === MAP_FAILED) return;
      try {
        const keymap = this.xkb.symbols.xkb_keymap_new_from_buffer(
          this.#context,
          mapped,
          byteLength,
          XKB_KEYMAP_FORMAT_TEXT_V1,
          XKB_KEYMAP_COMPILE_NO_FLAGS,
        );
        if (!keymap) return;
        const state = this.xkb.symbols.xkb_state_new(keymap);
        if (!state) {
          this.xkb.symbols.xkb_keymap_unref(keymap);
          return;
        }
        this.#replaceKeymap(keymap, state);
      } finally {
        this.libc.symbols.munmap(mapped, byteLength);
      }
    } finally {
      this.libc.symbols.close(fd);
    }
  }

  updateModifiers(depressed: number, latched: number, locked: number, group: number): void {
    if (!this.#state) {
      this.#modifiers = modifiersFromMask(depressed | latched | locked);
      return;
    }
    this.xkb.symbols.xkb_state_update_mask(this.#state, depressed, latched, locked, 0, 0, group);
    const active = (name: Uint8Array): boolean =>
      this.xkb.symbols.xkb_state_mod_name_is_active(
        this.#state!,
        name,
        XKB_STATE_MODS_EFFECTIVE,
      ) > 0;
    const ctrlKey = active(XKB_MOD_CONTROL);
    const altGraphKey = active(XKB_MOD_LEVEL_THREE) || active(XKB_MOD5);
    this.#modifiers = {
      shiftKey: active(XKB_MOD_SHIFT),
      ctrlKey,
      altKey: active(XKB_MOD_ALT),
      metaKey: active(XKB_MOD_META),
      accelKey: ctrlKey && !altGraphKey,
      capsLock: active(XKB_MOD_LOCK),
      altGraphKey,
    };
  }

  clearKeymap(): void {
    this.resetTransientState();
    if (this.#state) this.xkb.symbols.xkb_state_unref(this.#state);
    if (this.#keymap) this.xkb.symbols.xkb_keymap_unref(this.#keymap);
    this.#state = null;
    this.#keymap = null;
    this.#modifiers = modifiersFromMask(0);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.clearKeymap());
    if (this.#composeState) {
      collectCleanupError(errors, () => this.xkb.symbols.xkb_compose_state_unref(this.#composeState!));
      this.#composeState = null;
    }
    if (this.#composeTable) {
      collectCleanupError(errors, () => this.xkb.symbols.xkb_compose_table_unref(this.#composeTable!));
      this.#composeTable = null;
    }
    collectCleanupError(errors, () => this.xkb.symbols.xkb_context_unref(this.#context));
    throwCleanupErrors("winding failed to close xkb state", errors);
  }

  #initCompose(): void {
    const create = (locale: string): boolean => {
      const table = this.xkb.symbols.xkb_compose_table_new_from_locale(
        this.#context,
        cStr(locale),
        XKB_COMPOSE_COMPILE_NO_FLAGS,
      );
      if (!table) return false;
      const state = this.xkb.symbols.xkb_compose_state_new(table, XKB_COMPOSE_STATE_NO_FLAGS);
      if (!state) {
        this.xkb.symbols.xkb_compose_table_unref(table);
        return false;
      }
      this.#composeTable = table;
      this.#composeState = state;
      return true;
    };
    const locale = resolveComposeLocale();
    if (!create(locale) && locale !== "C") create("C");
  }

  #replaceKeymap(keymap: Deno.PointerObject, state: Deno.PointerObject): void {
    this.resetTransientState();
    if (this.#state) this.xkb.symbols.xkb_state_unref(this.#state);
    if (this.#keymap) this.xkb.symbols.xkb_keymap_unref(this.#keymap);
    this.#keymap = keymap;
    this.#state = state;
    this.#modifiers = modifiersFromMask(0);
  }

  #readSizedUtf8(read: (buffer: Deno.PointerValue, size: bigint) => number): string {
    const required = read(null, 0n);
    if (required <= 0) return "";
    const buffer = new Uint8Array(required + 1) as Uint8Array<ArrayBuffer>;
    const written = read(Deno.UnsafePointer.of(buffer), BigInt(buffer.byteLength));
    if (written <= 0) return "";
    return new TextDecoder().decode(buffer.subarray(0, Math.min(written, required)));
  }

  #utf8ForKeysym(keysym: number): string {
    const buffer = new Uint8Array(8) as Uint8Array<ArrayBuffer>;
    const written = this.xkb.symbols.xkb_keysym_to_utf8(
      keysym,
      Deno.UnsafePointer.of(buffer),
      BigInt(buffer.byteLength),
    );
    if (written <= 1) return "";
    return new TextDecoder().decode(buffer.subarray(0, written - 1));
  }

  #translator(): XkbKeyTranslator | undefined {
    const state = this.#state;
    if (!state) return undefined;
    return {
      keysymForKeycode: (keycode) => this.xkb.symbols.xkb_state_key_get_one_sym(state, keycode),
      utf8ForKeycode: (keycode) =>
        this.#readSizedUtf8((buffer, size) => this.xkb.symbols.xkb_state_key_get_utf8(state, keycode, buffer, size)),
      utf8ForKeysym: (keysym) => this.#utf8ForKeysym(keysym),
    };
  }

  #composeAdapter(): ComposeAdapter | undefined {
    const state = this.#composeState;
    if (!state) return undefined;
    return {
      feed: (keysym) => this.xkb.symbols.xkb_compose_state_feed(state, keysym),
      status: () => this.xkb.symbols.xkb_compose_state_get_status(state),
      utf8: () =>
        this.#readSizedUtf8((buffer, size) => this.xkb.symbols.xkb_compose_state_get_utf8(state, buffer, size)),
      reset: () => this.xkb.symbols.xkb_compose_state_reset(state),
    };
  }
}

function modifiersFromMask(mask: number): KeyModifiers {
  const ctrlKey = (mask & XKB_CONTROL_MASK) !== 0;
  return {
    shiftKey: (mask & XKB_SHIFT_MASK) !== 0,
    ctrlKey,
    altKey: (mask & XKB_ALT_MASK) !== 0,
    metaKey: (mask & XKB_META_MASK) !== 0,
    accelKey: ctrlKey,
    capsLock: (mask & XKB_LOCK_MASK) !== 0,
    altGraphKey: false,
  };
}
