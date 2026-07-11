/** Pure ownership and configure state for the optional xdg-decoration protocol. */

export const WaylandDecorationMode = {
  clientSide: 1,
  serverSide: 2,
} as const;

export type WaylandDecorationMode = typeof WaylandDecorationMode[keyof typeof WaylandDecorationMode];
export type WaylandDecorationGeneration = symbol;

export interface WaylandDecorationManagerBinding<Manager> {
  readonly manager: Manager;
  readonly version: number;
  readonly generation: symbol;
}

/** Keeps registry replacements distinct without owning any child decoration objects. */
export class WaylandDecorationManagerState<Manager> {
  #current: WaylandDecorationManagerBinding<Manager> | undefined;

  get current(): WaylandDecorationManagerBinding<Manager> | undefined {
    return this.#current;
  }

  bind(manager: Manager, version: number): WaylandDecorationManagerBinding<Manager> {
    const binding = { manager, version, generation: Symbol("Wayland decoration manager") };
    this.#current = binding;
    return binding;
  }

  unbind(manager: Manager): WaylandDecorationManagerBinding<Manager> | undefined {
    const binding = this.#current;
    if (binding === undefined || binding.manager !== manager) return undefined;
    this.#current = undefined;
    return binding;
  }
}

/** Tracks one decoration object's generation independently from its manager's lifetime. */
export class WaylandDecorationLifecycle {
  #initialSurfaceCommitSent = false;
  #bufferCommitSent = false;
  #generation: WaylandDecorationGeneration | undefined;
  #managerGeneration: symbol | undefined;
  #requiresInitialConfigure = false;
  #effectiveMode: WaylandDecorationMode | undefined;

  get initialSurfaceCommitSent(): boolean {
    return this.#initialSurfaceCommitSent;
  }

  get bufferCommitSent(): boolean {
    return this.#bufferCommitSent;
  }

  get activeGeneration(): WaylandDecorationGeneration | undefined {
    return this.#generation;
  }

  get managerGeneration(): symbol | undefined {
    return this.#managerGeneration;
  }

  get effectiveMode(): WaylandDecorationMode | undefined {
    return this.#effectiveMode;
  }

  get canAttachInitialBuffer(): boolean {
    return this.#generation === undefined ||
      !this.#requiresInitialConfigure ||
      this.#effectiveMode !== undefined;
  }

  get awaitingInitialConfigure(): boolean {
    return this.#generation !== undefined &&
      this.#requiresInitialConfigure &&
      this.#effectiveMode === undefined;
  }

  begin(managerGeneration: symbol, managerVersion: number): WaylandDecorationGeneration | undefined {
    if (this.#generation !== undefined) return undefined;
    if (this.#bufferCommitSent && managerVersion < 2) return undefined;
    const generation = Symbol("Wayland toplevel decoration");
    this.#generation = generation;
    this.#managerGeneration = managerGeneration;
    this.#requiresInitialConfigure = !this.#bufferCommitSent;
    this.#effectiveMode = undefined;
    return generation;
  }

  markInitialSurfaceCommit(): void {
    this.#initialSurfaceCommitSent = true;
  }

  markBufferCommit(): void {
    this.#bufferCommitSent = true;
  }

  configure(generation: WaylandDecorationGeneration, mode: number): boolean {
    if (generation !== this.#generation || !isWaylandDecorationMode(mode)) return false;
    this.#effectiveMode = mode;
    return true;
  }

  finish(generation: WaylandDecorationGeneration): boolean {
    if (generation !== this.#generation) return false;
    this.#generation = undefined;
    this.#managerGeneration = undefined;
    this.#requiresInitialConfigure = false;
    this.#effectiveMode = undefined;
    return true;
  }
}

export function setupServerSideDecorationBeforeInitialCommit(
  setupDecoration: (preferredMode: WaylandDecorationMode) => void,
  commitSurface: () => void,
): void {
  setupDecoration(WaylandDecorationMode.serverSide);
  commitSurface();
}

export function tryDestroyWaylandDecoration(
  destroy: () => void,
  retainCallbackRoot: () => void,
  recordError: (error: unknown) => void,
): boolean {
  try {
    destroy();
    return true;
  } catch (error) {
    retainCallbackRoot();
    recordError(error);
    return false;
  }
}

function isWaylandDecorationMode(mode: number): mode is WaylandDecorationMode {
  return mode === WaylandDecorationMode.clientSide || mode === WaylandDecorationMode.serverSide;
}
