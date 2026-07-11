/** Pure lifecycle gate shared by every public Win32 window mutation. */

export const WIN32_WINDOW_CLOSED_MESSAGE = "winding(win32): window is closed";

type Win32WindowLifecycleState = "open" | "closing" | "destroyed";

export class Win32WindowLifecycleGate {
  #state: Win32WindowLifecycleState = "open";

  get destroyed(): boolean {
    return this.#state === "destroyed";
  }

  /** Reject before the guarded operation can validate, allocate, or call native code. */
  mutate<Result>(operation: () => Result): Result {
    if (this.#state !== "open") throw new Error(WIN32_WINDOW_CLOSED_MESSAGE);
    return operation();
  }

  /** Enter closing once; false keeps close/dispose idempotent. */
  beginClose(): boolean {
    if (this.#state !== "open") return false;
    this.#state = "closing";
    return true;
  }

  /** Restore method availability only when native destruction did not happen. */
  recoverFailedClose(): void {
    if (this.#state === "closing") this.#state = "open";
  }

  /** Commit the definitive native lifetime boundary once. */
  markDestroyed(): boolean {
    if (this.#state === "destroyed") return false;
    this.#state = "destroyed";
    return true;
  }
}
