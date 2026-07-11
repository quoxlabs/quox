import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import { WIN32_WINDOW_CLOSED_MESSAGE, Win32WindowLifecycleGate } from "./window_lifecycle.ts";

function assertMutationRejected(gate: Win32WindowLifecycleGate, calls: { value: number }): void {
  const error = assertThrows(
    () =>
      gate.mutate(() => {
        calls.value++;
      }),
    Error,
    WIN32_WINDOW_CLOSED_MESSAGE,
  );
  assertEquals(error.message, WIN32_WINDOW_CLOSED_MESSAGE);
}

Deno.test("Win32 window lifecycle rejects reentrant mutations while closing", () => {
  const gate = new Win32WindowLifecycleGate();
  const calls = { value: 0 };
  assertEquals(gate.mutate(() => ++calls.value), 1);
  assertEquals(gate.beginClose(), true);
  assertEquals(gate.beginClose(), false);
  assertMutationRejected(gate, calls);
  assertEquals(calls.value, 1);
});

Deno.test("Win32 window lifecycle permanently gates user and library-driven destruction", () => {
  for (const closeOwner of ["window", "library"] as const) {
    const gate = new Win32WindowLifecycleGate();
    const nativeCalls = { value: 0 };
    assertEquals(gate.beginClose(), true, closeOwner);
    assertEquals(gate.markDestroyed(), true, closeOwner);
    assertEquals(gate.destroyed, true, closeOwner);
    assertMutationRejected(gate, nativeCalls);
    assertEquals(nativeCalls.value, 0, closeOwner);
    assertEquals(gate.beginClose(), false, closeOwner);
    assertEquals(gate.markDestroyed(), false, closeOwner);
    gate.recoverFailedClose();
    assertMutationRejected(gate, nativeCalls);
  }
});

Deno.test("Win32 failed close restores mutation availability only before destruction", () => {
  const gate = new Win32WindowLifecycleGate();
  const nativeCalls = { value: 0 };
  assertEquals(gate.beginClose(), true);
  assertMutationRejected(gate, nativeCalls);
  gate.recoverFailedClose();
  assertEquals(gate.mutate(() => ++nativeCalls.value), 1);
  assertEquals(nativeCalls.value, 1);

  assertEquals(gate.beginClose(), true);
  assertEquals(gate.markDestroyed(), true);
  gate.recoverFailedClose();
  assertMutationRejected(gate, nativeCalls);
  assertEquals(nativeCalls.value, 1);
});

Deno.test("Win32 externally destroyed windows are terminal without a close attempt", () => {
  const gate = new Win32WindowLifecycleGate();
  const calls = { value: 0 };
  assertEquals(gate.markDestroyed(), true);
  assertMutationRejected(gate, calls);
  assertEquals(calls.value, 0);
});
