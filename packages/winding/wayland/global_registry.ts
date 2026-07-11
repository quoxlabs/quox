/** Registry-name-aware ownership for the singleton globals used by the Wayland backend. */

export const WAYLAND_GLOBAL_INTERFACES = [
  "wl_compositor",
  "wl_shm",
  "wl_seat",
  "xdg_wm_base",
  "wp_cursor_shape_manager_v1",
  "zwp_text_input_manager_v3",
] as const;

export type WaylandGlobalInterface = typeof WAYLAND_GLOBAL_INTERFACES[number];

export interface WaylandGlobalOffer {
  name: number;
  interface: WaylandGlobalInterface;
  offeredVersion: number;
}

export interface BoundWaylandGlobal<Binding> extends WaylandGlobalOffer {
  binding: Binding;
}

export function isWaylandGlobalInterface(value: string): value is WaylandGlobalInterface {
  return (WAYLAND_GLOBAL_INTERFACES as readonly string[]).includes(value);
}

/**
 * Keeps exactly one active binding for each supported interface. The first successful binding
 * remains selected until its registry name is removed; unbound duplicates are retained as
 * deterministic replacement candidates rather than leaking extra native proxies.
 */
export class WaylandGlobalRegistry<Binding> {
  readonly #offers = new Map<number, WaylandGlobalOffer>();
  readonly #active = new Map<WaylandGlobalInterface, BoundWaylandGlobal<Binding>>();

  constructor(
    readonly bind: (offer: WaylandGlobalOffer) => Binding | null,
    readonly release: (global: BoundWaylandGlobal<Binding>) => void,
  ) {}

  announce(offer: WaylandGlobalOffer): void {
    if (this.#offers.has(offer.name)) return;
    this.#offers.set(offer.name, offer);
    this.#activateNext(offer.interface);
  }

  remove(name: number): void {
    const offer = this.#offers.get(name);
    if (!offer) return;
    this.#offers.delete(name);

    const active = this.#active.get(offer.interface);
    if (active?.name !== name) return;
    this.#active.delete(offer.interface);

    let releaseError: unknown;
    try {
      this.release(active);
    } catch (error) {
      releaseError = error;
    }
    this.#activateNext(offer.interface);
    if (releaseError !== undefined) throw releaseError;
  }

  active(interfaceName: WaylandGlobalInterface): BoundWaylandGlobal<Binding> | undefined {
    return this.#active.get(interfaceName);
  }

  close(): void {
    const active = [...this.#active.values()].reverse();
    this.#active.clear();
    this.#offers.clear();

    const errors: unknown[] = [];
    for (const global of active) {
      try {
        this.release(global);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "failed to release Wayland globals");
  }

  #activateNext(interfaceName: WaylandGlobalInterface): void {
    if (this.#active.has(interfaceName)) return;
    const candidates = [...this.#offers.values()]
      .filter((offer) => offer.interface === interfaceName)
      .sort((left, right) => left.name - right.name);

    for (const offer of candidates) {
      const binding = this.bind(offer);
      if (binding === null) continue;
      this.#active.set(interfaceName, { ...offer, binding });
      return;
    }
  }
}
