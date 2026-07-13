import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DOM_DISPATCH_EVENT_TYPES,
  type DomDispatchEventType,
  DomDispatchInitialStepError,
  DomDispatchRendererPort,
  type DomDispatchRendererSource,
  validateDomDispatchStep,
} from "./renderer_port.ts";

function mousePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientX: 11.25,
    clientY: -2.5,
    pageX: 14.75,
    pageY: 4,
    screenX: 0,
    screenY: 0,
    offsetX: 1.5,
    offsetY: 2.25,
    movementX: 0,
    movementY: 0,
    button: 0,
    buttons: 1,
    detail: 2,
    shiftKey: true,
    ctrlKey: false,
    altKey: true,
    metaKey: false,
    capsLock: true,
    altGraphKey: false,
    fnKey: true,
    numLock: false,
    scrollLock: true,
    relatedTarget: null,
    ...overrides,
  };
}

function pointerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mousePayload(),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
    tangentialPressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    altitudeAngle: Math.PI / 2,
    azimuthAngle: 0,
    persistentDeviceId: 0,
    ...overrides,
  };
}

function wheelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mousePayload({ button: 0, detail: 0 }),
    deltaX: 1.25,
    deltaY: -2.5,
    deltaZ: 0.125,
    deltaMode: 1,
    ...overrides,
  };
}

function keyboardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "A",
    code: "KeyA",
    location: 2,
    repeat: true,
    isComposing: false,
    keyCode: 65,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: true,
    capsLock: true,
    altGraphKey: false,
    fnKey: true,
    numLock: false,
    scrollLock: true,
    ...overrides,
  };
}

function payloadForType(type: DomDispatchEventType): Record<string, unknown> | undefined {
  switch (type) {
    case "pointermove":
    case "pointerdown":
    case "pointerup":
    case "pointercancel":
    case "pointerenter":
    case "pointerleave":
    case "pointerover":
    case "pointerout":
    case "click":
    case "auxclick":
    case "contextmenu":
      return pointerPayload();
    case "mousemove":
    case "mousedown":
    case "mouseup":
    case "mouseenter":
    case "mouseleave":
    case "mouseover":
    case "mouseout":
    case "dblclick":
      return mousePayload();
    case "wheel":
      return wheelPayload();
    case "keydown":
    case "keyup":
      return keyboardPayload();
    case "beforeinput":
    case "input":
      return { data: null, inputType: "", isComposing: false };
    case "change":
      return undefined;
    case "compositionstart":
    case "compositionupdate":
    case "compositionend":
      return { data: "" };
    case "focus":
    case "blur":
    case "focusin":
    case "focusout":
      return { relatedTarget: null };
    case "scroll":
      return undefined;
  }
}

function eventStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const requestedType = overrides.type ?? "click";
  const type = (typeof requestedType === "string" &&
      DOM_DISPATCH_EVENT_TYPES.includes(requestedType as DomDispatchEventType))
    ? requestedType as DomDispatchEventType
    : "click";
  const step: Record<string, unknown> = {
    kind: "event",
    frameId: 1,
    eventId: 2,
    type,
    target: 7,
    path: [7, 4, 1],
    bubbles: true,
    cancelable: true,
    composed: true,
    timeStamp: 12.5,
  };
  const payload = payloadForType(type);
  if (payload !== undefined) step.payload = payload;
  return { ...step, ...overrides };
}

function completeStep(frameId = 1, redrawRequested = false): Record<string, unknown> {
  return { kind: "complete", frameId, redrawRequested };
}

Deno.test("DOM dispatch validator freezes a copied target-first event step", () => {
  const rawPath = [7, 4, 1];
  const payload = pointerPayload();
  const step = validateDomDispatchStep(eventStep({ path: rawPath, payload }));

  assertEquals(step as unknown, {
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
  assert(Object.isFrozen(step.payload));
  assert(!Object.is(step.payload, payload));
  rawPath[0] = 99;
  payload.clientX = 99;
  assertEquals(step.path, [7, 4, 1]);
  assertEquals((step.payload as { clientX: number }).clientX, 11.25);
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

Deno.test("DOM dispatch validator preserves text edit details and empty control input semantics", () => {
  for (
    const payload of [
      { data: "候", inputType: "insertCompositionText", isComposing: true },
      { data: null, inputType: "deleteContentBackward", isComposing: false },
      { data: null, inputType: "", isComposing: false },
    ]
  ) {
    const step = validateDomDispatchStep(eventStep({ type: "input", payload }));
    assert(step.kind === "event");
    assertEquals(step.payload, payload);
  }

  const plainInput = eventStep({ type: "input" });
  delete plainInput.payload;
  const step = validateDomDispatchStep(plainInput);
  assert(step.kind === "event");
  assertEquals(step.payload, undefined);
});

Deno.test("DOM dispatch validator accepts and freezes complete steps", () => {
  const step = validateDomDispatchStep(completeStep(9, true));
  assertEquals(step, { kind: "complete", frameId: 9, redrawRequested: true });
  assert(Object.isFrozen(step));
});

Deno.test("DOM dispatch validator requires exact top-level step records", () => {
  const eventWithExtra = eventStep({ future: true });
  const completeWithExtra = completeStep();
  completeWithExtra.future = true;
  const eventWithSymbol = eventStep();
  const completeWithSymbol = completeStep();
  const extra = Symbol("extra");
  Object.defineProperty(eventWithSymbol, extra, { value: true });
  Object.defineProperty(completeWithSymbol, extra, { value: true });

  for (const value of [eventWithExtra, completeWithExtra, eventWithSymbol, completeWithSymbol]) {
    assertThrows(() => validateDomDispatchStep(value), TypeError);
  }
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
    eventStep({ type: "keypress" }),
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

Deno.test("DOM dispatch validator requires exact payload families and rejects plain-event payloads", () => {
  const missingPayload = eventStep();
  delete missingPayload.payload;

  const extraPointerField = pointerPayload();
  extraPointerField.futureField = 1;

  const invalidValues = [
    missingPayload,
    eventStep({ type: "click", payload: mousePayload() }),
    eventStep({ type: "auxclick", payload: mousePayload() }),
    eventStep({ type: "dblclick", payload: pointerPayload() }),
    eventStep({ type: "wheel", payload: mousePayload() }),
    eventStep({ type: "keydown", payload: { ...keyboardPayload(), data: null } }),
    eventStep({ type: "beforeinput", payload: { data: null, inputType: "" } }),
    eventStep({ type: "input", payload: { data: null, inputType: "" } }),
    eventStep({ type: "compositionupdate", payload: { data: "x", isComposing: true } }),
    eventStep({ type: "focus", payload: { relatedTarget: null, detail: 0 } }),
    eventStep({ type: "scroll", payload: undefined }),
    eventStep({ type: "scroll", payload: {} }),
    eventStep({ type: "change", payload: undefined }),
    eventStep({ type: "change", payload: {} }),
    eventStep({ type: "click", payload: extraPointerField }),
  ];

  for (const value of invalidValues) {
    assertThrows(() => validateDomDispatchStep(value), TypeError);
  }
});

Deno.test("DOM dispatch validator enforces payload types, finite values, ranges, and handles", () => {
  const invalidValues = [
    eventStep({ payload: pointerPayload({ clientX: NaN }) }),
    eventStep({ payload: pointerPayload({ movementY: Infinity }) }),
    eventStep({ payload: pointerPayload({ button: 0.5 }) }),
    eventStep({ payload: pointerPayload({ button: -2 }) }),
    eventStep({ payload: pointerPayload({ button: 5 }) }),
    eventStep({ payload: pointerPayload({ buttons: 0x20 }) }),
    eventStep({ payload: pointerPayload({ buttons: 0x100 }) }),
    eventStep({ payload: pointerPayload({ detail: -1 }) }),
    eventStep({ payload: pointerPayload({ detail: 0x8000_0000 }) }),
    eventStep({ payload: pointerPayload({ shiftKey: 1 }) }),
    eventStep({ payload: pointerPayload({ fnKey: 1 }) }),
    eventStep({ payload: pointerPayload({ relatedTarget: 0 }) }),
    eventStep({ payload: pointerPayload({ pointerId: -2 }) }),
    eventStep({ payload: pointerPayload({ pointerId: 0x8000_0000 }) }),
    eventStep({ payload: pointerPayload({ width: -1 }) }),
    eventStep({ payload: pointerPayload({ pressure: 1.01 }) }),
    eventStep({ payload: pointerPayload({ pressure: 0.1 }) }),
    eventStep({ payload: pointerPayload({ tangentialPressure: -1.01 }) }),
    eventStep({ payload: pointerPayload({ tangentialPressure: 0.1 }) }),
    eventStep({ payload: pointerPayload({ tiltX: 91 }) }),
    eventStep({ payload: pointerPayload({ twist: 360 }) }),
    eventStep({ payload: pointerPayload({ altitudeAngle: Math.PI }) }),
    eventStep({ payload: pointerPayload({ persistentDeviceId: 0x8000_0000 }) }),
    eventStep({ type: "wheel", payload: wheelPayload({ deltaY: Infinity }) }),
    eventStep({ type: "wheel", payload: wheelPayload({ deltaMode: 3 }) }),
    eventStep({ type: "keydown", payload: keyboardPayload({ location: 4 }) }),
    eventStep({ type: "keydown", payload: keyboardPayload({ keyCode: 1.5 }) }),
    eventStep({ type: "keydown", payload: keyboardPayload({ numLock: 1 }) }),
    eventStep({ type: "input", payload: { data: 1, inputType: "", isComposing: false } }),
    eventStep({ type: "beforeinput", payload: { data: null, inputType: 1, isComposing: false } }),
    eventStep({ type: "compositionstart", payload: { data: null } }),
    eventStep({ type: "focus", payload: { relatedTarget: 1.5 } }),
  ];

  for (const value of invalidValues) {
    assertThrows(() => validateDomDispatchStep(value));
  }
});

Deno.test("DOM dispatch validator preserves accepted mouse and pointer boundaries", () => {
  const step = validateDomDispatchStep(eventStep({
    payload: pointerPayload({
      button: -1,
      buttons: 0x1f,
      detail: 0x7fff_ffff,
      movementX: 2.25,
      movementY: -3.75,
      pointerId: -1,
      pressure: Math.fround(0.1),
      tangentialPressure: Math.fround(-0.1),
      azimuthAngle: Math.PI * 2,
      persistentDeviceId: 0x7fff_ffff,
    }),
  }));
  assert(step.kind === "event");
  const payload = step.payload as unknown as Record<string, unknown>;
  assertEquals(
    [
      payload.button,
      payload.buttons,
      payload.detail,
      payload.movementX,
      payload.movementY,
      payload.pointerId,
      payload.pressure,
      payload.tangentialPressure,
      payload.azimuthAngle,
      payload.persistentDeviceId,
    ],
    [
      -1,
      0x1f,
      0x7fff_ffff,
      2.25,
      -3.75,
      -1,
      Math.fround(0.1),
      Math.fround(-0.1),
      Math.PI * 2,
      0x7fff_ffff,
    ],
  );
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

  const accessorPayload = pointerPayload();
  Object.defineProperty(accessorPayload, "clientX", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 11.25;
    },
  });
  assertThrows(
    () => validateDomDispatchStep(eventStep({ payload: accessorPayload })),
    TypeError,
  );
  assertEquals(getterCalls, 0);

  assertThrows(
    () => validateDomDispatchStep(eventStep({ payload: pointerPayload({ buttons: hostileNumber }) })),
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

  begin_stationary_pointer_refresh(): unknown {
    return this.#call("begin_stationary_pointer_refresh");
  }

  begin_pointer_move(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): unknown {
    return this.#call(
      "begin_pointer_move",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      buttons,
      modifierBits,
      timeStamp,
    );
  }

  begin_pointer_cancel(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    canceledButtons: number,
    modifierBits: number,
    timeStamp: number,
  ): unknown {
    return this.#call(
      "begin_pointer_cancel",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      canceledButtons,
      modifierBits,
      timeStamp,
    );
  }

  begin_pointer_enter(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): unknown {
    return this.#call(
      "begin_pointer_enter",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      buttons,
      modifierBits,
      timeStamp,
    );
  }

  begin_pointer_leave(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): unknown {
    return this.#call(
      "begin_pointer_leave",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      buttons,
      modifierBits,
      timeStamp,
    );
  }

  begin_pointer_down(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
    detail: number,
  ): unknown {
    return this.#call(
      "begin_pointer_down",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      button,
      buttons,
      modifierBits,
      timeStamp,
      detail,
    );
  }

  begin_pointer_up(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    button: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
    detail: number,
  ): unknown {
    return this.#call(
      "begin_pointer_up",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      button,
      buttons,
      modifierBits,
      timeStamp,
      detail,
    );
  }

  begin_wheel(
    x: number,
    y: number,
    screenKnown: boolean,
    screenX: number,
    screenY: number,
    blitzDeltaX: number,
    blitzDeltaY: number,
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    buttons: number,
    modifierBits: number,
    timeStamp: number,
  ): unknown {
    return this.#call(
      "begin_wheel",
      x,
      y,
      screenKnown,
      screenX,
      screenY,
      blitzDeltaX,
      blitzDeltaY,
      deltaX,
      deltaY,
      deltaMode,
      buttons,
      modifierBits,
      timeStamp,
    );
  }

  begin_key_event(
    code: string,
    key: string,
    keycode: number,
    modifierBits: number,
    location: number,
    eventFlags: number,
    sourceKeyInputId?: number,
  ): unknown {
    return this.#call(
      "begin_key_event",
      code,
      key,
      keycode,
      modifierBits,
      location,
      eventFlags,
      sourceKeyInputId,
    );
  }

  begin_focus(nodeHandle: number): unknown {
    return this.#call("begin_focus", nodeHandle);
  }

  begin_blur(nodeHandle: number): unknown {
    return this.#call("begin_blur", nodeHandle);
  }

  begin_apple_standard_keybinding(command: string, sourceKeyInputId?: number): unknown {
    return this.#call("begin_apple_standard_keybinding", command, sourceKeyInputId);
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

  begin_ime_commit(text: string, sourceKeyInputId?: number): unknown {
    return this.#call("begin_ime_commit", text, sourceKeyInputId);
  }

  begin_ime_delete_surrounding(beforeBytes: number, afterBytes: number): unknown {
    return this.#call("begin_ime_delete_surrounding", beforeBytes, afterBytes);
  }

  resume_dom_dispatch(frameId: number, eventId: number, defaultPrevented: boolean): unknown {
    return this.#call("resume_dom_dispatch", frameId, eventId, defaultPrevented);
  }

  abort_dom_dispatch(frameId: number): boolean {
    this.#call("abort_dom_dispatch", frameId);
    return false;
  }
}

Deno.test("renderer port forwards every staged entry point and validates its result", () => {
  const renderer = new FakeRenderer();
  const port = new DomDispatchRendererPort(renderer);

  port.beginStationaryPointerRefresh();
  port.beginPointerMove(1, 2, true, 101.5, 202.25, 3, 4, 12.5);
  port.beginPointerCancel(1, 2, true, 101.5, 202.25, 5, 4, 12.55);
  port.beginPointerEnter(1, 2, true, 101.5, 202.25, 3, 4, 12.625);
  port.beginPointerLeave(1, 2, false, 0, 0, 3, 4, 12.75);
  port.beginPointerDown(1, 2, true, 101.5, 202.25, 0, 3, 4, 13, 2);
  port.beginPointerUp(1, 2, true, 101.5, 202.25, 0, 2, 4, 14, 2);
  port.beginWheel(1, 2, false, 0, 0, 3.5, -4.5, -0.25, 0.5, 1, 0, 4, 15);
  port.beginKeyEvent("KeyA", "a", 44, 1, 0, 1, 17);
  port.beginFocus(17);
  port.beginBlur(18);
  port.beginAppleStandardKeybinding("moveLeft:", 18);
  port.beginImeEnabled();
  port.beginImeDisabled();
  port.beginImePreedit("preedit", 1, 4);
  port.beginImeCommit("commit", 19);
  port.beginImeDeleteSurrounding(2, 3);

  assertEquals(renderer.calls, [
    ["begin_stationary_pointer_refresh"],
    ["begin_pointer_move", 1, 2, true, 101.5, 202.25, 3, 4, 12.5],
    ["begin_pointer_cancel", 1, 2, true, 101.5, 202.25, 5, 4, 12.55],
    ["begin_pointer_enter", 1, 2, true, 101.5, 202.25, 3, 4, 12.625],
    ["begin_pointer_leave", 1, 2, false, 0, 0, 3, 4, 12.75],
    ["begin_pointer_down", 1, 2, true, 101.5, 202.25, 0, 3, 4, 13, 2],
    ["begin_pointer_up", 1, 2, true, 101.5, 202.25, 0, 2, 4, 14, 2],
    ["begin_wheel", 1, 2, false, 0, 0, 3.5, -4.5, -0.25, 0.5, 1, 0, 4, 15],
    ["begin_key_event", "KeyA", "a", 44, 1, 0, 1, 17],
    ["begin_focus", 17],
    ["begin_blur", 18],
    ["begin_apple_standard_keybinding", "moveLeft:", 18],
    ["begin_ime_enabled"],
    ["begin_ime_disabled"],
    ["begin_ime_preedit", "preedit", 1, 4],
    ["begin_ime_commit", "commit", 19],
    ["begin_ime_delete_surrounding", 2, 3],
  ]);

  renderer.nextStep = { kind: "complete", frameId: 0, redrawRequested: false };
  assertThrows(() => port.beginImeEnabled(), RangeError);
  assertThrows(() => port.beginFocus(-1), RangeError);
  assertThrows(() => port.beginBlur(1.5), RangeError);
  const callsBeforeInvalidSourceIds = renderer.calls.length;
  assertThrows(() => port.beginKeyEvent("KeyA", "a", 44, 1, 0, 1, 0), RangeError);
  assertThrows(() => port.beginAppleStandardKeybinding("moveLeft:", 1.5), RangeError);
  assertThrows(() => port.beginImeCommit("commit", 0x1_0000_0000), RangeError);
  assertEquals(renderer.calls.length, callsBeforeInvalidSourceIds);
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

Deno.test("renderer port preserves a valid frame ID on malformed initial steps", () => {
  const renderer = new FakeRenderer();
  const port = new DomDispatchRendererPort(renderer);
  renderer.nextStep = eventStep({ frameId: 17, path: [] });

  const error = assertThrows(() => port.beginImeEnabled(), DomDispatchInitialStepError);
  assertEquals(error.frameId, 17);
  assert(error.validationError instanceof RangeError);

  renderer.nextStep = eventStep({ frameId: 0, path: [] });
  assertThrows(() => port.beginImeEnabled(), RangeError);

  let getterCalls = 0;
  const accessorFrame = eventStep({ path: [] });
  Object.defineProperty(accessorFrame, "frameId", {
    get() {
      getterCalls += 1;
      return 17;
    },
  });
  renderer.nextStep = accessorFrame;
  assertThrows(() => port.beginImeEnabled(), TypeError);
  assertEquals(getterCalls, 0);
});
