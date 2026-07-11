import { normalizeLogicalKey } from "./keyboard.ts";

/**
 * Tracks physical pressed identities for repeat detection. The last resolved key is retained
 * only as a best-effort release fallback for backends which cannot resolve key-up independently.
 */
export class PressedLogicalKeyCache<Identity = number> {
  readonly #keys = new Map<Identity, string>();

  get size(): number {
    return this.#keys.size;
  }

  has(identity: Identity): boolean {
    return this.#keys.has(identity);
  }

  /** Return the most recent logical key, for a backend-specific fallback such as dead keys. */
  get(identity: Identity): string | undefined {
    return this.#keys.get(identity);
  }

  /** Mark a physical key pressed and use the logical value resolved for this occurrence. */
  press(identity: Identity, key: string | undefined): string {
    const resolved = normalizeLogicalKey(key);
    this.#keys.set(identity, resolved);
    return resolved;
  }

  /** Release a physical key, preferring a current lookup over the retained fallback. */
  release(identity: Identity, current?: string): string {
    const retained = this.#keys.get(identity);
    this.#keys.delete(identity);
    return current === undefined ? retained ?? "Unidentified" : normalizeLogicalKey(current);
  }

  clear(): void {
    this.#keys.clear();
  }
}
