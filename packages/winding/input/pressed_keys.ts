import { normalizeLogicalKey } from "./keyboard.ts";

/**
 * Retains the logical key resolved on initial press so repeat and release events
 * stay stable across modifier or keyboard-layout changes.
 */
export class PressedLogicalKeyCache<Identity = number> {
  readonly #keys = new Map<Identity, string>();

  get size(): number {
    return this.#keys.size;
  }

  has(identity: Identity): boolean {
    return this.#keys.has(identity);
  }

  /** Remember an initial key, or return the key already retained for a repeat. */
  press(identity: Identity, key: string | undefined): string {
    const retained = this.#keys.get(identity);
    if (retained !== undefined) return retained;
    const resolved = normalizeLogicalKey(key);
    this.#keys.set(identity, resolved);
    return resolved;
  }

  /** Release and return the retained key, falling back to the current lookup. */
  release(identity: Identity, fallback?: string): string {
    const retained = this.#keys.get(identity);
    this.#keys.delete(identity);
    return retained ?? normalizeLogicalKey(fallback);
  }

  clear(): void {
    this.#keys.clear();
  }
}
