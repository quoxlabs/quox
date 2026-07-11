import { assert, assertEquals, assertFalse, assertStrictEquals, assertThrows } from "@std/assert";
import { QuoxEvent } from "./event.ts";
import { QuoxEventTarget } from "./event_target.ts";
import {
  createTrustedMouseEventInit,
  QuoxCompositionEvent,
  QuoxDOMInputEvent,
  QuoxDOMKeyboardEvent,
  QuoxFocusEvent,
  QuoxMouseEvent,
  type QuoxMouseEventInit,
  QuoxPointerEvent,
  QuoxUIEvent,
  QuoxWheelEvent,
} from "./ui_event.ts";

Deno.test("UI and focus events expose browser initialization fields", () => {
  const view = new QuoxEventTarget();
  const relatedTarget = new QuoxEventTarget();
  const event = new QuoxFocusEvent("focusin", {
    bubbles: true,
    view,
    detail: 7,
    which: 9,
    relatedTarget,
  });

  assert(event instanceof QuoxUIEvent);
  assert(event instanceof QuoxEvent);
  assertStrictEquals(event.view, view);
  assertEquals(event.detail, 7);
  assertEquals(event.which, 9);
  assertStrictEquals(event.relatedTarget, relatedTarget);

  const trusted = new QuoxMouseEvent(
    "mousemove",
    createTrustedMouseEventInit(
      { clientX: 11.25, clientY: 22.75 },
      { pageX: 31.25, pageY: 42.75, offsetX: 1.5, offsetY: 2.5 },
    ),
  );
  assertEquals(trusted.pageX, 31.25);
  assertEquals(trusted.pageY, 42.75);
  assertEquals(trusted.offsetX, 1.5);
  assertEquals(trusted.offsetY, 2.5);

  const publicExtras = new QuoxMouseEvent(
    "mousemove",
    { clientX: 7, pageX: 99 } as QuoxMouseEventInit,
  );
  assertEquals(publicExtras.pageX, 7);
});

Deno.test("mouse events expose standard coordinate, button, and modifier state", () => {
  const relatedTarget = new QuoxEventTarget();
  const event = new QuoxMouseEvent("mousemove", {
    screenX: 101.5,
    screenY: 202.5,
    clientX: 11.25,
    clientY: 22.75,
    movementX: -3,
    movementY: 4,
    button: -1,
    buttons: 5,
    ctrlKey: true,
    modifierAltGraph: true,
    relatedTarget,
  });

  assertEquals(event.screenX, 101.5);
  assertEquals(event.screenY, 202.5);
  assertEquals(event.clientX, 11.25);
  assertEquals(event.clientY, 22.75);
  assertEquals(event.x, event.clientX);
  assertEquals(event.y, event.clientY);
  assertEquals(event.pageX, event.clientX);
  assertEquals(event.pageY, event.clientY);
  assertEquals(event.offsetX, event.clientX);
  assertEquals(event.offsetY, event.clientY);
  assertEquals(event.movementX, -3);
  assertEquals(event.movementY, 4);
  assertEquals(event.button, -1);
  assertEquals(event.buttons, 5);
  assert(event.ctrlKey);
  assertFalse(event.shiftKey);
  assert(event.getModifierState("Control"));
  assert(event.getModifierState("AltGraph"));
  assertStrictEquals(event.relatedTarget, relatedTarget);
});

Deno.test("pointer events retain pointer details and clone event lists", () => {
  const coalesced = new QuoxPointerEvent("pointermove", { clientX: 4 });
  const predicted = new QuoxPointerEvent("pointermove", { clientX: 5 });
  const event = new QuoxPointerEvent("pointermove", {
    pointerId: 7,
    width: 2.5,
    height: 3.5,
    pressure: 0.5,
    tangentialPressure: -0.25,
    tiltX: -12,
    tiltY: 13,
    twist: 270,
    altitudeAngle: Math.PI / 4,
    azimuthAngle: Math.PI / 3,
    pointerType: "pen",
    isPrimary: true,
    persistentDeviceId: 42,
    coalescedEvents: [coalesced],
    predictedEvents: [predicted],
  });

  assert(event instanceof QuoxMouseEvent);
  assertEquals(event.pointerId, 7);
  assertEquals(event.width, 2.5);
  assertEquals(event.height, 3.5);
  assertEquals(event.pressure, 0.5);
  assertEquals(event.tangentialPressure, -0.25);
  assertEquals(event.tiltX, -12);
  assertEquals(event.tiltY, 13);
  assertEquals(event.twist, 270);
  assertEquals(event.altitudeAngle, Math.PI / 4);
  assertEquals(event.azimuthAngle, Math.PI / 3);
  assertEquals(event.pointerType, "pen");
  assert(event.isPrimary);
  assertEquals(event.persistentDeviceId, 42);

  const firstCoalesced = event.getCoalescedEvents();
  firstCoalesced.length = 0;
  assertEquals(event.getCoalescedEvents(), [coalesced]);
  assertEquals(event.getPredictedEvents(), [predicted]);

  const defaultOrientation = new QuoxPointerEvent("pointermove");
  assertEquals(defaultOrientation.tiltX, 0);
  assertEquals(defaultOrientation.tiltY, 0);
  assertEquals(defaultOrientation.altitudeAngle, Math.PI / 2);
  assertEquals(defaultOrientation.azimuthAngle, 0);

  const tiltOnly = new QuoxPointerEvent("pointermove", { tiltX: 45, tiltY: 0 });
  assertEquals(tiltOnly.altitudeAngle, Math.PI / 4);
  assertEquals(tiltOnly.azimuthAngle, 0);

  const sphericalOnly = new QuoxPointerEvent("pointermove", {
    altitudeAngle: Math.PI / 4,
    azimuthAngle: Math.PI / 2,
  });
  assertEquals(sphericalOnly.tiltX, 0);
  assertEquals(sphericalOnly.tiltY, 45);

  const nullValues = new QuoxPointerEvent(
    "pointermove",
    {
      width: null,
      altitudeAngle: null,
    } as unknown as ConstructorParameters<typeof QuoxPointerEvent>[1],
  );
  assertEquals(nullValues.width, 0);
  assertEquals(nullValues.altitudeAngle, 0);

  const roundedPressure = new QuoxPointerEvent("pointermove", { pressure: 1 / 3 });
  assertEquals(roundedPressure.pressure, Math.fround(1 / 3));
  assertThrows(
    () => new QuoxPointerEvent("pointermove", { pressure: Number.MAX_VALUE }),
    TypeError,
  );
});

Deno.test("wheel events expose delta constants and exact finite deltas", () => {
  const event = new QuoxWheelEvent("wheel", {
    deltaX: 0.125,
    deltaY: -2.5,
    deltaZ: 3.75,
    deltaMode: QuoxWheelEvent.DOM_DELTA_LINE,
  });

  assertEquals(event.deltaX, 0.125);
  assertEquals(event.deltaY, -2.5);
  assertEquals(event.deltaZ, 3.75);
  assertEquals(event.deltaMode, 1);
  assertEquals(event.DOM_DELTA_PIXEL, 0);
  assertEquals(event.DOM_DELTA_LINE, 1);
  assertEquals(event.DOM_DELTA_PAGE, 2);
  assertThrows(() => new QuoxWheelEvent("wheel", { deltaY: Number.NaN }), TypeError);
});

Deno.test("keyboard events separate physical modifiers from key identity", () => {
  const event = new QuoxDOMKeyboardEvent("keydown", {
    key: "@",
    code: "Digit2",
    location: QuoxDOMKeyboardEvent.DOM_KEY_LOCATION_STANDARD,
    repeat: true,
    isComposing: true,
    keyCode: 50,
    ctrlKey: true,
    metaKey: true,
    modifierCapsLock: true,
  });

  assertEquals(event.key, "@");
  assertEquals(event.code, "Digit2");
  assertEquals(event.location, 0);
  assert(event.repeat);
  assert(event.isComposing);
  assertEquals(event.keyCode, 50);
  assertEquals(event.charCode, 0);
  assertEquals(event.which, 50);
  assert(event.ctrlKey);
  assert(event.metaKey);
  assert(event.getModifierState("CapsLock"));
  assertFalse(event.getModifierState("AltGraph"));

  const nullStrings = new QuoxDOMKeyboardEvent(
    "keydown",
    {
      key: null,
      code: null,
    } as unknown as ConstructorParameters<typeof QuoxDOMKeyboardEvent>[1],
  );
  assertEquals(nullStrings.key, "null");
  assertEquals(nullStrings.code, "null");
  assertThrows(
    () => new QuoxDOMKeyboardEvent("keydown", { key: Symbol("key") } as unknown as { key: string }),
    TypeError,
  );
});

Deno.test("input and composition event data is not confused with a control value", () => {
  const range = { startOffset: 1, endOffset: 2 };
  const input = new QuoxDOMInputEvent("beforeinput", {
    data: null,
    inputType: "deleteContentBackward",
    isComposing: false,
    targetRanges: [range],
  });
  const composition = new QuoxCompositionEvent("compositionupdate", { data: "\ud800" });

  assertStrictEquals(input.data, null);
  assertEquals(input.inputType, "deleteContentBackward");
  assertFalse(input.isComposing);
  const ranges = input.getTargetRanges();
  assertEquals(ranges, [range]);
  ranges.length = 0;
  assertEquals(input.getTargetRanges(), [range]);
  assertStrictEquals(input.dataTransfer, null);
  assertEquals(composition.data, "\ufffd");
  assertEquals(
    new QuoxCompositionEvent("compositionupdate", { data: null } as unknown as { data: string }).data,
    "null",
  );
  assertEquals(new QuoxDOMInputEvent("input", { data: "\udc00" }).data, "\ufffd");
});
