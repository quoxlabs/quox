const ACTIVE_LIBRARY_SLOT = "__quox_winding_x11_active_library__";
const globals = globalThis as unknown as Record<string, unknown>;

/** Claim process-global X11 ownership across separately evaluated module copies. */
export function claimX11LibraryOwnership(owner: object): boolean {
  if (globals[ACTIVE_LIBRARY_SLOT] !== undefined) return false;
  globals[ACTIVE_LIBRARY_SLOT] = owner;
  return true;
}

/** Release ownership only when it still belongs to the expected library. */
export function releaseX11LibraryOwnership(owner: object): void {
  if (globals[ACTIVE_LIBRARY_SLOT] === owner) delete globals[ACTIVE_LIBRARY_SLOT];
}
