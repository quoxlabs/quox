export interface DarwinApplicationOwnership {
  pointer: bigint;
  initialized: boolean;
}

export type DarwinApplicationAction =
  | "create"
  | "initialize"
  | "reuse"
  | "reject";

/**
 * Decide whether this module instance may use AppKit's process-wide singleton.
 *
 * Ownership is deliberately supplied by the caller instead of stored in a
 * global slot: a separately evaluated module or Worker must not inherit the
 * right to mutate an application created elsewhere.
 */
export function darwinApplicationAction(
  existingApplication: bigint | null,
  ownership: DarwinApplicationOwnership | undefined,
): DarwinApplicationAction {
  if (existingApplication === null) {
    return ownership === undefined ? "create" : "reject";
  }
  if (ownership === undefined || ownership.pointer !== existingApplication) {
    return "reject";
  }
  return ownership.initialized ? "reuse" : "initialize";
}
