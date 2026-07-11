export type ImeActivationTransition = "enabled" | "disabled" | undefined;

export interface ImeActivationActions {
  /** Return true only when the backend accepted and applied the activation request. */
  activate(): boolean;
  deactivate(): void;
}

/** Separates desired IME permission from focused, available native activation. */
export class ImeActivationState {
  #desired = false;
  #focused = false;
  #available = false;
  #active = false;

  get desired(): boolean {
    return this.#desired;
  }

  get focused(): boolean {
    return this.#focused;
  }

  get available(): boolean {
    return this.#available;
  }

  get active(): boolean {
    return this.#active;
  }

  get shouldBeActive(): boolean {
    return this.#desired && this.#focused && this.#available;
  }

  setDesired(desired: boolean): void {
    this.#desired = desired;
  }

  setFocused(focused: boolean): void {
    this.#focused = focused;
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  /** Apply the desired state to a native context and report the backend transition. */
  reconcile(actions: ImeActivationActions): ImeActivationTransition {
    if (this.shouldBeActive === this.#active) return undefined;
    if (this.shouldBeActive) {
      if (!actions.activate()) return undefined;
      this.#active = true;
      return "enabled";
    }
    actions.deactivate();
    this.#active = false;
    return "disabled";
  }

  /** Record external native activation/deactivation without invoking actions. */
  markActive(active: boolean): ImeActivationTransition {
    const normalized = active && this.shouldBeActive;
    if (normalized === this.#active) return undefined;
    this.#active = normalized;
    return normalized ? "enabled" : "disabled";
  }

  /** Native server/context loss cannot safely invoke the normal deactivation path. */
  forceInactive(): ImeActivationTransition {
    if (!this.#active) return undefined;
    this.#active = false;
    return "disabled";
  }

  reset(): void {
    this.#desired = false;
    this.#focused = false;
    this.#available = false;
    this.#active = false;
  }
}
