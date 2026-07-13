import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import type { QuoxDocument } from "./document.ts";
import { QuoxEvent } from "./event.ts";
import { setElementFunctionProp } from "./handlers.ts";
import { attachDocumentInternals } from "./internals.ts";
import { QuoxElement } from "./node.ts";
import { DOM_DISPATCH_EVENT_TYPES, type DomDispatchEventType } from "./renderer_port.ts";

const EVENT_TYPE_TO_PROP = {
  pointermove: "onPointerMove",
  pointerdown: "onPointerDown",
  pointerup: "onPointerUp",
  pointercancel: "onPointerCancel",
  pointerenter: "onPointerEnter",
  pointerleave: "onPointerLeave",
  pointerover: "onPointerOver",
  pointerout: "onPointerOut",
  mousemove: "onMouseMove",
  mousedown: "onMouseDown",
  mouseup: "onMouseUp",
  mouseenter: "onMouseEnter",
  mouseleave: "onMouseLeave",
  mouseover: "onMouseOver",
  mouseout: "onMouseOut",
  scroll: "onScroll",
  wheel: "onWheel",
  click: "onClick",
  auxclick: "onAuxClick",
  contextmenu: "onContextMenu",
  dblclick: "onDoubleClick",
  keydown: "onKeyDown",
  keyup: "onKeyUp",
  copy: "onCopy",
  cut: "onCut",
  paste: "onPaste",
  beforeinput: "onBeforeInput",
  input: "onInput",
  change: "onChange",
  submit: "onSubmit",
  compositionstart: "onCompositionStart",
  compositionupdate: "onCompositionUpdate",
  compositionend: "onCompositionEnd",
  focus: "onFocus",
  blur: "onBlur",
  focusin: "onFocusIn",
  focusout: "onFocusOut",
} as const satisfies Record<DomDispatchEventType, string>;

let nextNodeId = 1;

function createElement(): QuoxElement {
  const document = {} as QuoxDocument;
  const element = new QuoxElement(document, nextNodeId++);
  attachDocumentInternals(document, {
    renderer: {} as WasmRenderer,
    requestRender: () => undefined,
    assertActive: () => undefined,
    invalidateNodeHandles: () => undefined,
    queueScrollEvent: () => undefined,
    isDispatching: () => false,
    focusElement: () => undefined,
    blurElement: () => undefined,
    syntheticEventPath: () => [element],
  });
  return element;
}

Deno.test("every staged DOM event has live JSX bubble and capture props", () => {
  assertEquals(
    Object.keys(EVENT_TYPE_TO_PROP).sort(),
    Array.from(DOM_DISPATCH_EVENT_TYPES).sort(),
  );

  for (const [type, baseProp] of Object.entries(EVENT_TYPE_TO_PROP)) {
    for (const prop of [baseProp, `${baseProp}Capture`]) {
      const element = createElement();
      const event = new QuoxEvent(type, { cancelable: true });
      let handlerThis: unknown;
      let handlerArgs: unknown[] = [];

      setElementFunctionProp(element, prop, function (this: QuoxElement, ...args) {
        handlerThis = this;
        handlerArgs = args;
        return false;
      });

      // JSX listener return values, including false, have no inline-attribute semantics.
      assertEquals(element.dispatchEvent(event), true, prop);
      assertStrictEquals(handlerThis, element, prop);
      assertEquals(handlerArgs, [event], prop);
    }
  }
});

Deno.test("unsupported keypress JSX props fail while synthetic keypress stays available", () => {
  const element = createElement();
  for (const prop of ["onKeyPress", "onKeyPressCapture"]) {
    assertThrows(
      () => setElementFunctionProp(element, prop, () => undefined),
      TypeError,
      `quox: JSX event prop "${prop}" is not supported`,
    );
  }

  let calls = 0;
  element.addEventListener("keypress", () => calls += 1);
  element.dispatchEvent(new QuoxEvent("keypress"));
  assertEquals(calls, 1);
});

Deno.test("capture JSX props run in the capture listener group", () => {
  const element = createElement();
  const calls: string[] = [];

  setElementFunctionProp(element, "onClick", () => calls.push("bubble"));
  setElementFunctionProp(element, "onClickCapture", () => calls.push("capture"));

  element.dispatchEvent(new QuoxEvent("click"));
  assertEquals(calls, ["capture", "bubble"]);
});

Deno.test("React and Preact double-click spellings share stable slots", () => {
  const element = createElement();
  const calls: string[] = [];

  element.addEventListener("dblclick", () => calls.push("before"));
  setElementFunctionProp(element, "onDoubleClick", () => calls.push("old bubble"));
  element.addEventListener("dblclick", () => calls.push("after"));
  setElementFunctionProp(element, "onDblClick", () => calls.push("Preact bubble"));
  setElementFunctionProp(element, "onDoubleClickCapture", () => calls.push("old capture"));
  setElementFunctionProp(element, "onDblClickCapture", () => calls.push("Preact capture"));

  element.dispatchEvent(new QuoxEvent("dblclick"));
  assertEquals(calls, ["Preact capture", "before", "Preact bubble", "after"]);

  calls.length = 0;
  setElementFunctionProp(element, "onDoubleClick", () => calls.push("React bubble"));
  setElementFunctionProp(element, "onDoubleClickCapture", () => calls.push("React capture"));
  element.dispatchEvent(new QuoxEvent("dblclick"));
  assertEquals(calls, ["React capture", "before", "React bubble", "after"]);
});
