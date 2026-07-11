import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  DOM_DISPATCH_EVENT_TYPES,
  DomDispatchRendererPort,
  type DomDispatchRendererSource,
  validateDomDispatchStep,
} from "./renderer_port.ts";

function eventStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "event",
    frameId: 1,
    eventId: 2,
    type: "click",
    target: 7,
    path: [7, 4, 1],
    bubbles: true,
    cancelable: true,
    composed: true,
    timeStamp: 12.5,
    ...overrides,
  };
}

function completeStep(frameId = 1, redrawRequested = false): Record<string, unknown> {
  return { kind: "complete", frameId, redrawRequested };
}

Deno.test("DOM dispatch validator freezes a copied target-first event step", () => {
  const rawPath = [7, 4, 1];
  const payload = { future: "event fields" };
  const step = validateDomDispatchStep(eventStep({ path: rawPath, payload }));

  assertEquals(step, {
    kind: "event",
    frameId: 1,
    eventId: 2,
    type: "click",
    target: 7,
    path: [7, 4, 1],
    bubbles: true,
    cancelable: true,
    composed: true,
    timeStamp: 12.5,
    payload,
  });
  assert(step.kind === "event");
  assert(Object.isFrozen(step));
  assert(Object.isFrozen(step.path));
  assertStrictEquals(step.payload, payload);
  rawPath[0] = 99;
  assertEquals(step.path, [7, 4, 1]);
});

Deno.test("DOM dispatch validator normalizes Uint32Array paths and accepts every engine event type", () => {
  for (const type of DOM_DISPATCH_EVENT_TYPES) {
    const step = validateDomDispatchStep(
      eventStep({ type, path: new Uint32Array([7, 4, 1]) }),
    );
    assert(step.kind === "event");
    assertEquals(step.type, type);
    assertEquals(step.path, [7, 4, 1]);
  }
});

Deno.test("DOM dispatch validator accepts and freezes complete steps", () => {
  const step = validateDomDispatchStep(completeStep(9, true));
  assertEquals(step, { kind: "complete", frameId: 9, redrawRequested: true });
  assert(Object.isFrozen(step));
});

Deno.test("DOM dispatch validator rejects malformed IDs, metadata, and paths", () => {
  const invalidValues: unknown[] = [
    null,
    [],
    new Date(),
    completeStep(0),
    completeStep(1, 1 as unknown as boolean),
    eventStep({ frameId: 0 }),
    eventStep({ eventId: 1.5 }),
    eventStep({ target: 0x1_0000_0000 }),
    eventStep({ type: "load" }),
    eventStep({ type: "composition" }),
    eventStep({ type: "applekeybinding" }),
    eventStep({ path: [] }),
    eventStep({ path: [0] }),
    eventStep({ path: [8, 7] }),
    eventStep({ path: [7, 1.5] }),
    eventStep({ path: new Uint16Array([7, 4, 1]) }),
    eventStep({ bubbles: 1 }),
    eventStep({ cancelable: null }),
    eventStep({ composed: "true" }),
    eventStep({ timeStamp: -1 }),
    eventStep({ timeStamp: Infinity }),
    eventStep({ kind: "pending" }),
  ];

  for (const value of invalidValues) {
    assertThrows(() => validateDomDispatchStep(value));
  }

  const sparsePath = [7, 4, 1];
  delete sparsePath[1];
  assertThrows(() => validateDomDispatchStep(eventStep({ path: sparsePath })), TypeError);
});

Deno.test("DOM dispatch validator neither invokes accessors nor coerces hostile fields", () => {
  let getterCalls = 0;
  const accessorStep = eventStep();
  Object.defineProperty(accessorStep, "target", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 7;
    },
  });

  assertThrows(() => validateDomDispatchStep(accessorStep), TypeError);
  assertEquals(getterCalls, 0);

  let coercionCalls = 0;
  const hostileNumber = {
    valueOf() {
      coercionCalls += 1;
      return 7;
    },
    toString() {
      coercionCalls += 1;
      return "7";
    },
  };
  assertThrows(
    () => validateDomDispatchStep(eventStep({ target: hostileNumber })),
    TypeError,
  );
  assertEquals(coercionCalls, 0);
});

class FakeRenderer implements DomDispatchRendererSource {
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  nextStep: unknown = completeStep();

  #call(name: string, ...args: unknown[]): unknown {
    this.calls.push([name, ...args]);
    return this.nextStep;
  }

  begin_pointer_move(x: number, y: number, buttons: number, modifierBits: number): unknown {
    return this.#call("begin_pointer_move", x, y, buttons, modifierBits);
  }

  begin_pointer_down(
    x: number,
    y: number,
    button: number,
    buttons: number,
    modifierBits: number,
  ): unknown {
    return this.#call("begin_pointer_down", x, y, button, buttons, modifierBits);
  }

  begin_pointer_up(
    x: number,
    y: number,
    button: number,
    buttons: number,
    modifierBits: number,
  ): unknown {
    return this.#call("begin_pointer_up", x, y, button, buttons, modifierBits);
  }

  begin_wheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    buttons: number,
    modifierBits: number,
  ): unknown {
    return this.#call("begin_wheel", x, y, deltaX, deltaY, buttons, modifierBits);
  }

  begin_key_event(
    code: string,
    key: string,
    modifierBits: number,
    location: number,
    eventFlags: number,
  ): unknown {
    return this.#call("begin_key_event", code, key, modifierBits, location, eventFlags);
  }

  begin_apple_standard_keybinding(command: string): unknown {
    return this.#call("begin_apple_standard_keybinding", command);
  }

  begin_ime_enabled(): unknown {
    return this.#call("begin_ime_enabled");
  }

  begin_ime_disabled(): unknown {
    return this.#call("begin_ime_disabled");
  }

  begin_ime_preedit(text: string, cursorStart?: number, cursorEnd?: number): unknown {
    return this.#call("begin_ime_preedit", text, cursorStart, cursorEnd);
  }

  begin_ime_commit(text: string): unknown {
    return this.#call("begin_ime_commit", text);
  }

  begin_ime_delete_surrounding(beforeBytes: number, afterBytes: number): unknown {
    return this.#call("begin_ime_delete_surrounding", beforeBytes, afterBytes);
  }

  resume_dom_dispatch(frameId: number, eventId: number, defaultPrevented: boolean): unknown {
    return this.#call("resume_dom_dispatch", frameId, eventId, defaultPrevented);
  }

  abort_dom_dispatch(frameId: number): void {
    this.#call("abort_dom_dispatch", frameId);
  }
}

Deno.test("renderer port forwards every staged entry point and validates its result", () => {
  const renderer = new FakeRenderer();
  const port = new DomDispatchRendererPort(renderer);

  port.beginPointerMove(1, 2, 3, 4);
  port.beginPointerDown(1, 2, 0, 3, 4);
  port.beginPointerUp(1, 2, 0, 2, 4);
  port.beginWheel(1, 2, 3.5, -4.5, 0, 4);
  port.beginKeyEvent("KeyA", "a", 1, 0, 1);
  port.beginAppleStandardKeybinding("moveLeft:");
  port.beginImeEnabled();
  port.beginImeDisabled();
  port.beginImePreedit("preedit", 1, 4);
  port.beginImeCommit("commit");
  port.beginImeDeleteSurrounding(2, 3);

  assertEquals(renderer.calls, [
    ["begin_pointer_move", 1, 2, 3, 4],
    ["begin_pointer_down", 1, 2, 0, 3, 4],
    ["begin_pointer_up", 1, 2, 0, 2, 4],
    ["begin_wheel", 1, 2, 3.5, -4.5, 0, 4],
    ["begin_key_event", "KeyA", "a", 1, 0, 1],
    ["begin_apple_standard_keybinding", "moveLeft:"],
    ["begin_ime_enabled"],
    ["begin_ime_disabled"],
    ["begin_ime_preedit", "preedit", 1, 4],
    ["begin_ime_commit", "commit"],
    ["begin_ime_delete_surrounding", 2, 3],
  ]);

  renderer.nextStep = { kind: "complete", frameId: 0, redrawRequested: false };
  assertThrows(() => port.beginImeEnabled(), RangeError);
});

Deno.test("renderer port validates continuation arguments and frame ownership", () => {
  const renderer = new FakeRenderer();
  const port = new DomDispatchRendererPort(renderer);

  renderer.nextStep = eventStep({ frameId: 9, eventId: 10 });
  assertEquals(port.resumeDomDispatch(9, 8, true).frameId, 9);
  assertEquals(renderer.calls.at(-1), ["resume_dom_dispatch", 9, 8, true]);

  assertThrows(() => port.resumeDomDispatch(0, 8, false), RangeError);
  assertThrows(() => port.resumeDomDispatch(9, 0, false), RangeError);
  assertThrows(
    () => port.resumeDomDispatch(9, 8, 1 as unknown as boolean),
    TypeError,
  );

  renderer.nextStep = completeStep(10);
  assertThrows(() => port.resumeDomDispatch(9, 10, false), RangeError);

  port.abortDomDispatch(9);
  assertEquals(renderer.calls.at(-1), ["abort_dom_dispatch", 9]);
  assertThrows(() => port.abortDomDispatch(0), RangeError);
});
