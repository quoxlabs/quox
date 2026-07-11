/** Pure Wayland keyboard, XKB Compose, and repeat state. */

import type { KeyEditDisposition, KeyModifiers } from "../types.ts";
import { normalizeCommittedText } from "../input/mod.ts";
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
      const committed = normalizeCommittedText(text);
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
  const committed = normalizeCommittedText(text);
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
