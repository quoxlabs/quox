/** Pure state and arithmetic for the optional fractional-scale + viewporter pair. */

export const WAYLAND_FRACTIONAL_SCALE_DENOMINATOR = 120;
export const WAYLAND_INT32_MAX = 0x7fff_ffff;

export type WaylandFractionalScaleChildGeneration = symbol;
export type WaylandFractionalScaleManagerKind = "fractional-scale" | "viewporter";

export interface WaylandFractionalScaleManagerBinding<Manager> {
  readonly manager: Manager;
  readonly version: number;
  readonly generation: symbol;
}

export interface WaylandFractionalScaleManagerPair<Manager> {
  readonly fractionalScale: WaylandFractionalScaleManagerBinding<Manager>;
  readonly viewporter: WaylandFractionalScaleManagerBinding<Manager>;
}

/** Keeps manager replacements distinct without coupling child lifetime to either global. */
export class WaylandFractionalScaleManagerState<Manager> {
  #fractionalScale: WaylandFractionalScaleManagerBinding<Manager> | undefined;
  #viewporter: WaylandFractionalScaleManagerBinding<Manager> | undefined;

  get current(): WaylandFractionalScaleManagerPair<Manager> | undefined {
    if (this.#fractionalScale === undefined || this.#viewporter === undefined) return undefined;
    return { fractionalScale: this.#fractionalScale, viewporter: this.#viewporter };
  }

  bind(
    kind: WaylandFractionalScaleManagerKind,
    manager: Manager,
    version: number,
  ): WaylandFractionalScaleManagerBinding<Manager> {
    const binding = {
      manager,
      version,
      generation: Symbol(`Wayland ${kind} manager`),
    };
    if (kind === "fractional-scale") this.#fractionalScale = binding;
    else this.#viewporter = binding;
    return binding;
  }

  unbind(
    kind: WaylandFractionalScaleManagerKind,
    manager: Manager,
  ): WaylandFractionalScaleManagerBinding<Manager> | undefined {
    const binding = kind === "fractional-scale" ? this.#fractionalScale : this.#viewporter;
    if (binding === undefined || binding.manager !== manager) return undefined;
    if (kind === "fractional-scale") this.#fractionalScale = undefined;
    else this.#viewporter = undefined;
    return binding;
  }
}

export interface WaylandFractionalFramebufferSize {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly numerator: number;
}

/**
 * Rounds a positive toplevel size halfway away from zero without losing precision in a JS
 * multiplication. Returns undefined when any result cannot cross a signed Wayland `int`.
 */
export function calculateWaylandFractionalFramebufferSize(
  logicalWidth: number,
  logicalHeight: number,
  numerator: number,
): WaylandFractionalFramebufferSize | undefined {
  if (
    !isPositiveWaylandInt(logicalWidth) ||
    !isPositiveWaylandInt(logicalHeight) ||
    !isValidWaylandFractionalScaleNumerator(numerator)
  ) return undefined;

  const scale = BigInt(numerator);
  const denominator = BigInt(WAYLAND_FRACTIONAL_SCALE_DENOMINATOR);
  const half = denominator / 2n;
  const width = (BigInt(logicalWidth) * scale + half) / denominator;
  const height = (BigInt(logicalHeight) * scale + half) / denominator;
  if (width < 1n || height < 1n || width > BigInt(WAYLAND_INT32_MAX) || height > BigInt(WAYLAND_INT32_MAX)) {
    return undefined;
  }
  return {
    width: Number(width),
    height: Number(height),
    devicePixelRatio: numerator / WAYLAND_FRACTIONAL_SCALE_DENOMINATOR,
    numerator,
  };
}

export function isValidWaylandFractionalScaleNumerator(numerator: number): boolean {
  return Number.isSafeInteger(numerator) && numerator > 0 && numerator <= 0xffff_ffff;
}

/** Tracks exactly one paired set of surface children independently from manager removal. */
export class WaylandFractionalScaleLifecycle {
  #generation: WaylandFractionalScaleChildGeneration | undefined;
  #managerGenerations: readonly [symbol, symbol] | undefined;
  #active = false;
  #blocked = false;
  #preferredNumerator: number | undefined;

  get activeGeneration(): WaylandFractionalScaleChildGeneration | undefined {
    return this.#generation;
  }

  get managerGenerations(): readonly [symbol, symbol] | undefined {
    return this.#managerGenerations;
  }

  get active(): boolean {
    return this.#active;
  }

  get preferredNumerator(): number | undefined {
    return this.#preferredNumerator;
  }

  begin<Manager>(
    managers: WaylandFractionalScaleManagerPair<Manager>,
  ): WaylandFractionalScaleChildGeneration | undefined {
    if (this.#generation !== undefined || this.#blocked) return undefined;
    if (managers.fractionalScale.version < 1 || managers.viewporter.version < 1) return undefined;
    const generation = Symbol("Wayland fractional-scale surface children");
    this.#generation = generation;
    this.#managerGenerations = [
      managers.fractionalScale.generation,
      managers.viewporter.generation,
    ];
    this.#active = false;
    this.#preferredNumerator = undefined;
    return generation;
  }

  activate(generation: WaylandFractionalScaleChildGeneration): boolean {
    if (generation !== this.#generation || this.#blocked) return false;
    this.#active = true;
    return true;
  }

  /** Allows a later manager pair to retry after every partially-created child was destroyed. */
  abort(generation: WaylandFractionalScaleChildGeneration): boolean {
    if (generation !== this.#generation) return false;
    this.#reset();
    return true;
  }

  /** Prevents duplicate child creation when a failed native destroy left an object associated. */
  disable(generation: WaylandFractionalScaleChildGeneration): boolean {
    if (generation !== this.#generation) return false;
    this.#active = false;
    this.#blocked = true;
    this.#preferredNumerator = undefined;
    return true;
  }

  prefer(generation: WaylandFractionalScaleChildGeneration, numerator: number): boolean {
    if (
      generation !== this.#generation || !this.#active ||
      !isValidWaylandFractionalScaleNumerator(numerator) ||
      numerator === this.#preferredNumerator
    ) return false;
    this.#preferredNumerator = numerator;
    return true;
  }

  framebufferSize(
    logicalWidth: number,
    logicalHeight: number,
    canUse: (size: WaylandFractionalFramebufferSize) => boolean = () => true,
  ): WaylandFractionalFramebufferSize | undefined {
    if (!this.#active || this.#preferredNumerator === undefined) return undefined;
    const size = calculateWaylandFractionalFramebufferSize(logicalWidth, logicalHeight, this.#preferredNumerator);
    return size !== undefined && canUse(size) ? size : undefined;
  }

  finish(generation: WaylandFractionalScaleChildGeneration): boolean {
    if (generation !== this.#generation) return false;
    this.#blocked = false;
    this.#reset();
    return true;
  }

  #reset(): void {
    this.#generation = undefined;
    this.#managerGenerations = undefined;
    this.#active = false;
    this.#preferredNumerator = undefined;
  }
}

export interface WaylandFractionalChildCleanupResult {
  readonly viewportDestroyed: boolean;
  readonly fractionalScaleDestroyed: boolean;
}

export interface WaylandFractionalSurfaceCleanupActions<Proxy, Callback> {
  readonly destroyViewport: (viewport: Proxy) => void;
  readonly destroyFractionalScale: (fractionalScale: Proxy) => void;
  readonly closeCallback: (callback: Callback) => void;
  readonly retainCallback: (callback: Callback) => void;
  readonly releaseCallback: (callback: Callback) => void;
  readonly retainOwnershipRoot: (root: object) => void;
  readonly releaseOwnershipRoot: (root: object) => void;
  readonly reportError: (error: unknown) => void;
}

/**
 * Owns the native child proxies and listener graph as one inspectable unit. Retaining this object
 * also retains its owner, the callback, and the vtable when a protocol destructor cannot be proven.
 */
export class WaylandFractionalSurfaceOwnership<Proxy, Callback, Vtable, Owner extends object> {
  #viewport: Proxy | null = null;
  #fractionalScale: Proxy | null = null;
  #preferredCallback: Callback | null = null;
  #vtable: Vtable | undefined;

  constructor(readonly owner: Owner) {}

  get viewport(): Proxy | null {
    return this.#viewport;
  }

  get fractionalScale(): Proxy | null {
    return this.#fractionalScale;
  }

  get preferredCallback(): Callback | null {
    return this.#preferredCallback;
  }

  get vtable(): Vtable | undefined {
    return this.#vtable;
  }

  installFractionalScaleProxy(fractionalScale: Proxy): void {
    if (this.#fractionalScale !== null) throw new Error("winding Wayland fractional scale already exists");
    this.#fractionalScale = fractionalScale;
  }

  installPreferredCallback(callback: Callback): void {
    if (this.#preferredCallback !== null) throw new Error("winding Wayland fractional-scale callback already exists");
    this.#preferredCallback = callback;
  }

  installVtable(vtable: Vtable): void {
    if (this.#vtable !== undefined) throw new Error("winding Wayland fractional-scale vtable already exists");
    this.#vtable = vtable;
  }

  installViewport(viewport: Proxy): void {
    if (this.#viewport !== null) throw new Error("winding Wayland viewport already exists");
    this.#viewport = viewport;
  }

  cleanup(actions: WaylandFractionalSurfaceCleanupActions<Proxy, Callback>): boolean {
    const callback = this.#preferredCallback;
    const result = tryDestroyWaylandFractionalChildren(
      this.#viewport,
      this.#fractionalScale,
      actions.destroyViewport,
      actions.destroyFractionalScale,
      actions.reportError,
    );
    if (result.viewportDestroyed) this.#viewport = null;
    if (result.fractionalScaleDestroyed) {
      this.#fractionalScale = null;
      this.#preferredCallback = null;
      this.#vtable = undefined;
      if (callback !== null) {
        actions.releaseCallback(callback);
        try {
          actions.closeCallback(callback);
        } catch (error) {
          actions.reportError(error);
        }
      }
    }
    if (result.viewportDestroyed && result.fractionalScaleDestroyed) {
      actions.releaseOwnershipRoot(this);
      return true;
    }
    if (!result.fractionalScaleDestroyed && callback !== null) actions.retainCallback(callback);
    actions.retainOwnershipRoot(this);
    return false;
  }
}

/** Destroy the viewport first, then its sibling scale listener, before wl_surface. */
export function tryDestroyWaylandFractionalChildren<Child>(
  viewport: Child | null,
  fractionalScale: Child | null,
  destroyViewport: (viewport: Child) => void,
  destroyFractionalScale: (fractionalScale: Child) => void,
  reportError: (error: unknown) => void,
): WaylandFractionalChildCleanupResult {
  let viewportDestroyed = viewport === null;
  let fractionalScaleDestroyed = fractionalScale === null;
  if (viewport !== null) {
    try {
      destroyViewport(viewport);
      viewportDestroyed = true;
    } catch (error) {
      reportError(error);
    }
  }
  if (fractionalScale !== null) {
    try {
      destroyFractionalScale(fractionalScale);
      fractionalScaleDestroyed = true;
    } catch (error) {
      reportError(error);
    }
  }
  return { viewportDestroyed, fractionalScaleDestroyed };
}

function isPositiveWaylandInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= WAYLAND_INT32_MAX;
}
