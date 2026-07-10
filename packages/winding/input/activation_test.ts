import { ImeActivationState } from "./activation.ts";

Deno.test("IME activation requires desired state, focus, availability, and native success", () => {
  const state = new ImeActivationState();
  let activations = 0;
  let deactivations = 0;
  const actions = {
    activate: () => {
      activations++;
      return true;
    },
    deactivate: () => {
      deactivations++;
    },
  };

  state.setDesired(true);
  assertEquals(state.reconcile(actions), undefined);
  state.setAvailable(true);
  assertEquals(state.reconcile(actions), undefined);
  state.setFocused(true);
  assertEquals(state.reconcile(actions), "enabled");
  assertEquals(state.reconcile(actions), undefined);
  assertEquals(activations, 1);

  state.setFocused(false);
  assertEquals(state.reconcile(actions), "disabled");
  assertEquals(deactivations, 1);
});

Deno.test("IME activation reports failed activation and external server loss exactly once", () => {
  const state = new ImeActivationState();
  state.setDesired(true);
  state.setFocused(true);
  state.setAvailable(true);
  assertEquals(state.reconcile({ activate: () => false, deactivate: () => {} }), undefined);
  assertEquals(state.active, false);
  assertEquals(state.markActive(true), "enabled");
  assertEquals(state.forceInactive(), "disabled");
  assertEquals(state.forceInactive(), undefined);
  assertEquals(state.markActive(true), "enabled");
  state.setAvailable(false);
  assertEquals(state.markActive(true), "disabled");
});

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}
