/** Pure Wayland keyboard, XKB Compose, and repeat state. */

import type { KeyEditDisposition, KeyModifiers } from "../types.ts";
import { normalizeKeyboardText, PressedLogicalKeyCache } from "../input/mod.ts";
import { logicalKeyFromKeysym } from "../linux/mod.ts";

export type EnvironmentReader = (name: "LC_ALL" | "LC_CTYPE" | "LANG") => string | undefined;

function readProcessEnvironment(name: "LC_ALL" | "LC_CTYPE" | "LANG"): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

export function resolveComposeLocale(readEnvironment: EnvironmentReader = readProcessEnvironment): string {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    let value: string | undefined;
    try {
      value = readEnvironment(name);
    } catch {
      continue;
    }
    if (value !== undefined && value.length > 0) return value;
  }
  return "C";
}

export function toXkbKeycode(rawKeycode: number): number {
  return rawKeycode + 8;
}

export const ComposeFeedResult = { IGNORED: 0, ACCEPTED: 1 } as const;
export const ComposeStatus = { NOTHING: 0, COMPOSING: 1, COMPOSED: 2, CANCELLED: 3 } as const;

export interface XkbKeyTranslator {
  keysymForKeycode(xkbKeycode: number): number;
  utf8ForKeycode(xkbKeycode: number): string;
  utf8ForKeysym(keysym: number): string;
}

export interface ComposeAdapter {
  feed(keysym: number): number;
  status(): number;
  utf8(): string;
  reset(): void;
}

export type KeyPhase = "press" | "release" | "repeat";

export interface TranslatedKey {
  readonly rawKeycode: number;
  readonly xkbKeycode: number;
  readonly keysym: number;
  readonly key: string;
  readonly text?: string;
  readonly isComposing: boolean;
}

export interface WaylandProtocolKeyTransition {
  readonly rawKeycode: number;
  readonly pressed: boolean;
}

export interface WaylandEnteredKeyBatch {
  readonly heldKeys: readonly number[];
  readonly deferredTransitions: readonly WaylandProtocolKeyTransition[];
}

/** Hold the enter key array until its mandatory following modifiers event supplies the layout. */
export class WaylandEnterKeyBatch {
  #heldKeys: number[] | undefined;
  #deferredTransitions: WaylandProtocolKeyTransition[] = [];

  get awaitingModifiers(): boolean {
    return this.#heldKeys !== undefined;
  }

  begin(heldKeys: readonly number[]): void {
    this.#heldKeys = [...heldKeys];
    this.#deferredTransitions = [];
  }

  defer(transition: WaylandProtocolKeyTransition): boolean {
    if (this.#heldKeys === undefined) return false;
    this.#deferredTransitions.push(transition);
    return true;
  }

  complete(): WaylandEnteredKeyBatch | undefined {
    const heldKeys = this.#heldKeys;
    if (heldKeys === undefined) return undefined;
    const result = {
      heldKeys,
      deferredTransitions: this.#deferredTransitions,
    };
    this.reset();
    return result;
  }

  reset(): void {
    this.#heldKeys = undefined;
    this.#deferredTransitions = [];
  }
}

type ProvisionalModifier = "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "capsLock" | "altGraphKey";

export interface WaylandResolvedKeyTransition {
  readonly key: string;
  readonly modifiers: KeyModifiers;
}

/**
 * Retains pressed logical keys and overlays physical modifier transitions until the compositor's
 * following aggregate modifiers event arrives.
 */
export class WaylandKeyTransitionState {
  readonly #logicalKeys = new PressedLogicalKeyCache<number>();
  readonly #heldModifiers = new Map<number, ProvisionalModifier>();
  readonly #provisional = new Map<ProvisionalModifier, boolean>();
  #authoritative = emptyModifiers();

  get modifiers(): KeyModifiers {
    const shiftKey = this.#value("shiftKey");
    const ctrlKey = this.#value("ctrlKey");
    const altKey = this.#value("altKey");
    const metaKey = this.#value("metaKey");
    const capsLock = this.#value("capsLock");
    const altGraphKey = this.#value("altGraphKey");
    return {
      shiftKey,
      ctrlKey,
      altKey,
      metaKey,
      accelKey: ctrlKey && !altGraphKey,
      capsLock,
      altGraphKey,
    };
  }

  get pressedKeyCount(): number {
    return this.#logicalKeys.size;
  }

  confirmModifiers(modifiers: KeyModifiers): void {
    this.#authoritative = { ...modifiers };
    this.#provisional.clear();
  }

  seedHeldKeys(rawKeycodes: readonly number[], resolve: (rawKeycode: number) => string): void {
    for (const rawKeycode of rawKeycodes) {
      const key = this.#logicalKeys.press(rawKeycode, resolve(rawKeycode));
      const modifier = provisionalModifierForKey(key);
      if (modifier !== undefined) this.#heldModifiers.set(rawKeycode, modifier);
    }
  }

  resolve(
    rawKeycode: number,
    phase: KeyPhase,
    fallback: string | undefined,
  ): WaylandResolvedKeyTransition {
    const key = phase === "release"
      ? this.#logicalKeys.release(rawKeycode, fallback)
      : this.#logicalKeys.press(rawKeycode, fallback);
    this.#applyModifierTransition(rawKeycode, phase, key);
    return { key, modifiers: this.modifiers };
  }

  reset(): void {
    this.#logicalKeys.clear();
    this.#heldModifiers.clear();
    this.#provisional.clear();
    this.#authoritative = emptyModifiers();
  }

  #applyModifierTransition(rawKeycode: number, phase: KeyPhase, key: string): void {
    if (phase === "repeat") return;
    const retainedModifier = this.#heldModifiers.get(rawKeycode);
    const modifier = retainedModifier ?? provisionalModifierForKey(key);
    if (modifier === undefined) return;

    if (phase === "press") {
      const initialPress = retainedModifier === undefined;
      this.#heldModifiers.set(rawKeycode, modifier);
      if (modifier === "capsLock") {
        if (initialPress) this.#provisional.set(modifier, !this.#value(modifier));
      } else {
        this.#provisional.set(modifier, this.#hasHeldModifier(modifier));
      }
      return;
    }

    this.#heldModifiers.delete(rawKeycode);
    // CapsLock describes the lock, not whether its physical key remains down.
    if (modifier !== "capsLock") {
      this.#provisional.set(modifier, this.#hasHeldModifier(modifier));
    }
  }

  #hasHeldModifier(modifier: ProvisionalModifier): boolean {
    for (const held of this.#heldModifiers.values()) {
      if (held === modifier) return true;
    }
    return false;
  }

  #value(modifier: ProvisionalModifier): boolean {
    return this.#provisional.get(modifier) ?? this.#authoritative[modifier];
  }
}

function provisionalModifierForKey(key: string): ProvisionalModifier | undefined {
  switch (key) {
    case "Shift":
      return "shiftKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
      return "altKey";
    case "Meta":
      return "metaKey";
    case "CapsLock":
      return "capsLock";
    case "AltGraph":
      return "altGraphKey";
    default:
      return undefined;
  }
}

function emptyModifiers(): KeyModifiers {
  return {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  };
}

export function waylandKeyEditDisposition(
  key: string,
  text: string | undefined,
  composing: boolean,
  modifiers: KeyModifiers,
): KeyEditDisposition {
  if (composing || key === "Dead") return "text-input";
  if (
    text !== undefined &&
    (modifiers.altGraphKey || (!modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey))
  ) return "text-input";
  return "key-default";
}

export function translateKey(
  rawKeycode: number,
  phase: KeyPhase,
  translator: XkbKeyTranslator,
  compose?: ComposeAdapter,
): TranslatedKey {
  const xkbKeycode = toXkbKeycode(rawKeycode);
  const keysym = translator.keysymForKeycode(xkbKeycode);
  const key = logicalKeyFromKeysym(keysym, translator.utf8ForKeysym(keysym));
  const base: TranslatedKey = { rawKeycode, xkbKeycode, keysym, key, isComposing: false };

  if (phase === "release") return base;
  if (!compose) return translatedKeyWithText(base, translator.utf8ForKeycode(xkbKeycode));

  const feedResult = compose.feed(keysym);
  const status = compose.status();
  if (feedResult !== ComposeFeedResult.ACCEPTED) {
    return { ...base, isComposing: status === ComposeStatus.COMPOSING };
  }
  switch (status) {
    case ComposeStatus.NOTHING:
      return translatedKeyWithText(base, translator.utf8ForKeycode(xkbKeycode));
    case ComposeStatus.COMPOSING:
      return { ...base, isComposing: true };
    case ComposeStatus.COMPOSED: {
      const text = compose.utf8();
      compose.reset();
      const committed = normalizeKeyboardText(text);
      return committed === undefined ? base : { ...base, key: committed, text: committed };
    }
    case ComposeStatus.CANCELLED:
      compose.reset();
      return base;
    default:
      return base;
  }
}

/** Translate an ordinary wl_keyboard event through local Compose when it is available. */
export function translateWlKeyboardKey(
  rawKeycode: number,
  phase: KeyPhase,
  translator: XkbKeyTranslator,
  compose?: ComposeAdapter,
): TranslatedKey {
  return translateKey(rawKeycode, phase, translator, compose);
}

function translatedKeyWithText(base: TranslatedKey, text: string): TranslatedKey {
  const committed = normalizeKeyboardText(text);
  return committed === undefined ? base : { ...base, text: committed };
}

export type MonotonicNow = () => number;

export class KeyRepeatController {
  readonly #now: MonotonicNow;
  #rate = 0;
  #delay = 0;
  #keycode: number | undefined;
  #nextDeadline: number | undefined;

  constructor(now: MonotonicNow = () => performance.now()) {
    this.#now = now;
  }

  get activeKeycode(): number | undefined {
    return this.#keycode;
  }

  get nextDeadline(): number | undefined {
    return this.#nextDeadline;
  }

  setRepeatInfo(rate: number, delay: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      this.#rate = 0;
      this.cancel();
      return;
    }
    this.#rate = rate;
    this.#delay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    if (this.#keycode !== undefined) this.#nextDeadline = this.#now() + this.#delay;
  }

  press(rawKeycode: number, repeatable: boolean): void {
    if (!repeatable || this.#rate <= 0) return;
    this.#keycode = rawKeycode;
    this.#nextDeadline = this.#now() + this.#delay;
  }

  release(rawKeycode: number): void {
    if (rawKeycode === this.#keycode) this.cancel();
  }

  cancel(): void {
    this.#keycode = undefined;
    this.#nextDeadline = undefined;
  }

  poll(): number | undefined {
    const keycode = this.#keycode;
    const deadline = this.#nextDeadline;
    if (keycode === undefined || deadline === undefined || this.#rate <= 0) return undefined;
    const now = this.#now();
    if (!Number.isFinite(now) || now < deadline) return undefined;
    const interval = 1000 / this.#rate;
    const missedIntervals = Math.floor((now - deadline) / interval);
    const nextDeadline = deadline + (missedIntervals + 1) * interval;
    this.#nextDeadline = Number.isFinite(nextDeadline) && nextDeadline > now ? nextDeadline : now + interval;
    return keycode;
  }
}
