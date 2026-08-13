import { assertEquals, assertStrictEquals } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { dispatchEventFrame, type QuoxEventFrame } from "./event_handlers.ts";
import { QuoxElement, type QuoxEvent } from "./node.ts";

type Call = { method: string; args: unknown[] };

class FakeInputRenderer {
  readonly calls: Call[] = [];
  readonly interests: Array<{ nodeId: number; kind: number; enabled: boolean }> = [];
  readonly decisions: Array<{ token: number; defaultPrevented: boolean }> = [];
  frames: QuoxEventFrame[] = [];
  title(): string {
    return "";
  }
  dispatch_key_event(...args: unknown[]): boolean {
    this.calls.push({ method: "keyEvent", args });
    return true;
  }
  dispatch_text_input(text: string): boolean {
    this.calls.push({ method: "textInput", args: [text] });
    return true;
  }
  dispatch_pointer_up(...args: unknown[]): boolean {
    this.calls.push({ method: "pointerUp", args });
    return true;
  }
  dispatch_wheel(...args: unknown[]): boolean {
    this.calls.push({ method: "wheel", args });
    return true;
  }
  dispatch_apple_standard_keybinding(command: string): boolean {
    this.calls.push({ method: "appleCommand", args: [command] });
    return false;
  }
  set_event_handler(nodeId: number, kind: number, enabled: boolean): void {
    this.interests.push({ nodeId, kind, enabled });
  }
  take_dom_event(): QuoxEventFrame | undefined {
    return this.frames.shift();
  }
  finish_dom_event(token: number, defaultPrevented: boolean): boolean {
    this.decisions.push({ token, defaultPrevented });
    return false;
  }
}

let nextToken = 1;

function frame(
  type: QuoxEventFrame["type"],
  path: number[],
  options: Partial<QuoxEventFrame> = {},
): QuoxEventFrame {
  return {
    token: nextToken++,
    type,
    path,
    bubbles: !["focus", "blur", "scroll"].includes(type),
    cancelable: !["input", "focus", "blur", "scroll"].includes(type),
    ...options,
  };
}

Deno.test("onclick receives a browser-style event with the assigned element as this", () => {
  const { document, renderer } = createDocument();
  const button = new QuoxElement(document, 42);
  let clicks = 0;
  let dispatchedEvent: QuoxEvent | undefined;
  button.onclick = function (event) {
    assertEquals(event.type, "click");
    assertStrictEquals(this, button);
    assertStrictEquals(event.target, button);
    assertStrictEquals(event.currentTarget, button);
    assertEquals(event.clientX, 10);
    dispatchedEvent = event;
    clicks++;
  };

  renderer.frames = [frame("click", [42], { clientX: 10 })];
  document.dispatchPointerUp(10, 20, 0, 0);

  assertEquals(renderer.calls, [{ method: "pointerUp", args: [10, 20, 0, 0] }]);
  assertEquals(clicks, 1);
  assertEquals(dispatchedEvent?.currentTarget, null);
});

Deno.test("events bubble target-to-root with a stable target and stoppable propagation", () => {
  const { document, renderer } = createDocument();
  const child = new QuoxElement(document, 42);
  const parent = new QuoxElement(document, 7);
  const root = new QuoxElement(document, 1);
  const calls: string[] = [];

  child.onclick = function (event) {
    calls.push(`child:${event.target.nodeId}:${event.currentTarget?.nodeId}:${this.nodeId}`);
  };
  parent.onclick = function (event) {
    calls.push(`parent:${event.target.nodeId}:${event.currentTarget?.nodeId}:${this.nodeId}`);
    event.stopPropagation();
  };
  root.onclick = () => calls.push("root");

  renderer.frames = [frame("click", [42, 7, 1])];
  document.dispatchPointerUp(0, 0, 0, 0);

  assertEquals(calls, ["child:42:42:42", "parent:42:7:7"]);
});

Deno.test("preventDefault and return false cancel only cancelable events", () => {
  const { document, renderer } = createDocument();
  const button = new QuoxElement(document, 42);
  button.onclick = (event) => {
    event.preventDefault();
  };

  const click = frame("click", [42]);
  renderer.frames = [click];
  document.dispatchPointerUp(0, 0, 0, 0);
  assertEquals(renderer.decisions.at(-1), { token: click.token, defaultPrevented: true });

  button.onclick = () => false;
  const secondClick = frame("click", [42]);
  renderer.frames = [secondClick];
  document.dispatchPointerUp(0, 0, 0, 0);
  assertEquals(renderer.decisions.at(-1), { token: secondClick.token, defaultPrevented: true });

  const input = new QuoxElement(document, 8);
  input.oninput = (event) => {
    event.preventDefault();
    return false;
  };
  const inputFrame = frame("input", [8]);
  renderer.frames = [inputFrame];
  document.dispatchTextInput({ type: "textinput", text: "a" });
  assertEquals(renderer.decisions.at(-1), { token: inputFrame.token, defaultPrevented: false });
});

Deno.test("pointer payload exposes browser-shaped coordinates, buttons, modifiers, and pointer data", () => {
  const { document, renderer } = createDocument();
  const button = new QuoxElement(document, 42);
  button.onpointerup = (event) => {
    assertEquals(
      {
        client: [event.clientX, event.clientY],
        page: [event.pageX, event.pageY],
        screen: [event.screenX, event.screenY],
        offset: [event.offsetX, event.offsetY],
        button: event.button,
        buttons: event.buttons,
        modifiers: [event.shiftKey, event.ctrlKey, event.altKey, event.metaKey],
        pointer: [event.pointerId, event.pointerType, event.isPrimary],
        pressure: [event.pressure, event.tangentialPressure],
        angles: [event.tiltX, event.tiltY, event.twist, event.altitudeAngle, event.azimuthAngle],
      },
      {
        client: [10, 20],
        page: [30, 40],
        screen: [50, 60],
        offset: [3, 4],
        button: 0,
        buttons: 1,
        modifiers: [true, false, true, false],
        pointer: [1, "mouse", true],
        pressure: [0.5, 0],
        angles: [0, 0, 0, 1.2, 2.4],
      },
    );
  };
  renderer.frames = [
    frame("pointerup", [42], {
      clientX: 10,
      clientY: 20,
      pageX: 30,
      pageY: 40,
      screenX: 50,
      screenY: 60,
      offsetX: 3,
      offsetY: 4,
      button: 0,
      buttons: 1,
      shiftKey: true,
      ctrlKey: false,
      altKey: true,
      metaKey: false,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5,
      tangentialPressure: 0,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      altitudeAngle: 1.2,
      azimuthAngle: 2.4,
    }),
  ];

  document.dispatchPointerUp(10, 20, 0, 0);
});

Deno.test("wheel payload exposes pixel deltas and mouse coordinates", () => {
  const { document, renderer } = createDocument();
  const scroller = new QuoxElement(document, 42);
  scroller.onwheel = (event) => {
    assertEquals([event.deltaX, event.deltaY, event.deltaMode], [2, 80, 0]);
    assertEquals([event.clientX, event.clientY, event.buttons], [10, 20, 0]);
  };
  renderer.frames = [
    frame("wheel", [42], {
      deltaX: 2,
      deltaY: 80,
      deltaMode: 0,
      clientX: 10,
      clientY: 20,
      buttons: 0,
    }),
  ];

  document.dispatchWheel(10, 20, 2, 80, 0);
});

Deno.test("a throwing handler does not block ancestors and is collected for deferred reporting", () => {
  const { document } = createDocument();
  const child = new QuoxElement(document, 42);
  const parent = new QuoxElement(document, 7);
  let parentCalls = 0;
  const failure = new Error("child failed");
  child.onclick = () => {
    throw failure;
  };
  parent.onclick = () => parentCalls++;

  const result = dispatchEventFrame(document, frame("click", [42, 7]));

  assertEquals(parentCalls, 1);
  assertStrictEquals(result.errors[0], failure);
});

function createDocument() {
  const renderer = new FakeInputRenderer();
  const renders = { count: 0 };
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => renders.count++,
    () => undefined,
  );
  return { document, renderer, renders };
}

Deno.test("keydown then textinput inserts once and emits one DOM input", () => {
  const { document, renderer, renders } = createDocument();
  let inputs = 0;
  const input = new QuoxElement(document, 42);
  input.oninput = function (event) {
    assertEquals(event.type, "input");
    assertStrictEquals(this, input);
    assertStrictEquals(event.target, input);
    assertStrictEquals(event.currentTarget, input);
    inputs++;
  };
  document.dispatchKey({
    type: "keydown",
    keycode: 44,
    code: "KeyZ",
    key: "y",
    location: 0,
    repeat: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });
  renderer.frames = [frame("input", [42])];
  document.dispatchTextInput({ type: "textinput", text: "y" });
  assertEquals(renderer.calls, [
    { method: "keyEvent", args: ["KeyZ", "y", 0, 0, 5] },
    { method: "textInput", args: ["y"] },
  ]);
  assertEquals(inputs, 1);
  assertEquals(renders.count, 2);
});

Deno.test("canceling a text-producing keydown suppresses its committed text", () => {
  const { document, renderer } = createDocument();
  const input = new QuoxElement(document, 42);
  input.onkeydown = (event) => {
    assertEquals(event.key, "y");
    assertEquals(event.code, "KeyZ");
    event.preventDefault();
  };
  renderer.frames = [
    frame("keydown", [42], {
      key: "y",
      code: "KeyZ",
      location: 0,
      repeat: false,
      isComposing: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    }),
  ];

  document.dispatchKey({
    type: "keydown",
    keycode: 44,
    code: "KeyZ",
    key: "y",
    location: 0,
    repeat: false,
    editDisposition: "text-input",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    accelKey: false,
    capsLock: false,
    altGraphKey: false,
  });
  document.dispatchTextInput({ type: "textinput", text: "y" });

  assertEquals(renderer.calls, [{ method: "keyEvent", args: ["KeyZ", "y", 0, 0, 5] }]);
});

Deno.test("browser-style event properties can be read, replaced, and cleared", () => {
  const { document, renderer } = createDocument();
  const input = new QuoxElement(document, 42);
  const calls: string[] = [];
  const first = () => calls.push("first");
  const second = () => calls.push("second");

  input.oninput = first;
  assertEquals(input.oninput, first);
  input.oninput = second;
  assertEquals(input.oninput, second);

  renderer.frames = [frame("input", [42])];
  document.dispatchTextInput({ type: "textinput", text: "a" });
  assertEquals(calls, ["second"]);

  input.oninput = null;
  assertEquals(input.oninput, null);
  renderer.frames = [frame("input", [42])];
  document.dispatchTextInput({ type: "textinput", text: "b" });
  assertEquals(calls, ["second"]);
});

Deno.test("AppKit selectors retain the platform command entry point", () => {
  const { document, renderer } = createDocument();
  document.dispatchAppleStandardKeybinding({ type: "apple-standard-keybinding", command: "deleteBackward:" });
  assertEquals(renderer.calls, [{ method: "appleCommand", args: ["deleteBackward:"] }]);
});
