import { CompositionState, discardTrailingPreeditClear } from "./composition.ts";

Deno.test("composition state exposes pre-transition activity and deduplicates preedit", () => {
  const state = new CompositionState();
  assertEquals(state.active, false);
  state.start();
  assertEquals(state.active, true);
  assertEquals(state.update("éx", [2, 3]), { text: "éx", cursorRange: [2, 3] });
  assertEquals(state.update("éx", [2, 3]), undefined);
  assertEquals(state.update("éx", [1, 3]), { text: "éx", cursorRange: null });
  assertEquals(state.text, "éx");
  assertEquals(state.cursorRange, null);
});

Deno.test("composition restart clears visible preedit once and resets session-local deduplication", () => {
  const state = new CompositionState();
  state.start();
  assertEquals(state.restart(), undefined);
  assertEquals(state.update("old", [3, 3]), { text: "old", cursorRange: [3, 3] });
  assertEquals(state.restart(), { text: "", cursorRange: null });
  assertEquals(state.active, true);
  assertEquals(state.text, "");
  assertEquals(state.cursorRange, null);
  assertEquals(state.restart(), undefined);
  assertEquals(state.update("old", [3, 3]), { text: "old", cursorRange: [3, 3] });

  state.update("", null);
  assertEquals(state.restart(), undefined);
  assertEquals(state.restart(), undefined);
  assertEquals(state.cancel(), undefined);
});

Deno.test("commit ends composition without a manufactured preedit clear", () => {
  const state = new CompositionState();
  state.update("日本", [3, 3]);
  state.commit();
  assertEquals(state.active, false);
  assertEquals(state.text, "");
  assertEquals(state.cancel(), undefined);
});

Deno.test("cancellation emits at most one canonical empty preedit", () => {
  const state = new CompositionState();
  state.start();
  assertEquals(state.cancel(), { text: "", cursorRange: null });
  assertEquals(state.cancel(), undefined);

  state.start();
  assertEquals(state.update("", null), { text: "", cursorRange: null });
  assertEquals(state.cancel(), undefined);
});

Deno.test("atomic commit batching retracts only a trailing empty preedit", () => {
  const events = [
    { type: "ime", kind: "preedit", text: "active" },
    { type: "ime", kind: "preedit", text: "" },
  ];
  discardTrailingPreeditClear(events);
  assertEquals(events, [{ type: "ime", kind: "preedit", text: "active" }]);
  discardTrailingPreeditClear(events);
  assertEquals(events, [{ type: "ime", kind: "preedit", text: "active" }]);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
