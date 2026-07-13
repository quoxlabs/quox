/** @jsxImportSource @quoxlabs/jsx */

import { assertEquals } from "@std/assert";
import {
  isQuoxVNode,
  type QuoxComponent,
  type QuoxEventProps,
  type QuoxJsxClipboardEvent,
  type QuoxJsxCompositionEvent,
  type QuoxJsxDataTransfer,
  type QuoxJsxEvent,
  type QuoxJsxFocusEvent,
  type QuoxJsxInputEvent,
  type QuoxJsxKeyboardEvent,
  type QuoxJsxMouseEvent,
  type QuoxJsxPointerEvent,
  type QuoxJsxWheelEvent,
} from "./jsx-runtime.ts";
import type { QuoxEvent } from "../quox/dom/event.ts";
import type {
  QuoxClipboardEvent,
  QuoxCompositionEvent,
  QuoxDataTransfer,
  QuoxDOMInputEvent,
  QuoxDOMKeyboardEvent,
  QuoxFocusEvent,
  QuoxMouseEvent,
  QuoxPointerEvent,
  QuoxWheelEvent,
} from "../quox/dom/ui_event.ts";

function expectType<Type>(_value: Type): void {}

type ExpectedBaseEventProp =
  | "onPointerMove"
  | "onPointerDown"
  | "onPointerUp"
  | "onPointerCancel"
  | "onPointerEnter"
  | "onPointerLeave"
  | "onPointerOver"
  | "onPointerOut"
  | "onMouseMove"
  | "onMouseDown"
  | "onMouseUp"
  | "onMouseEnter"
  | "onMouseLeave"
  | "onMouseOver"
  | "onMouseOut"
  | "onScroll"
  | "onWheel"
  | "onClick"
  | "onAuxClick"
  | "onContextMenu"
  | "onDoubleClick"
  | "onDblClick"
  | "onKeyDown"
  | "onKeyUp"
  | "onCopy"
  | "onCut"
  | "onPaste"
  | "onBeforeInput"
  | "onInput"
  | "onChange"
  | "onCompositionStart"
  | "onCompositionUpdate"
  | "onCompositionEnd"
  | "onFocus"
  | "onBlur"
  | "onFocusIn"
  | "onFocusOut";
type ExpectedEventProp = ExpectedBaseEventProp | `${ExpectedBaseEventProp}Capture`;
type EventPropsAreExact = [keyof QuoxEventProps, ExpectedEventProp] extends [
  ExpectedEventProp,
  keyof QuoxEventProps,
] ? true
  : false;

const runtimeEventCompatibility: [
  EventPropsAreExact,
  QuoxEvent extends QuoxJsxEvent ? true : false,
  QuoxMouseEvent extends QuoxJsxMouseEvent ? true : false,
  QuoxPointerEvent extends QuoxJsxPointerEvent ? true : false,
  QuoxWheelEvent extends QuoxJsxWheelEvent ? true : false,
  QuoxDOMKeyboardEvent extends QuoxJsxKeyboardEvent ? true : false,
  QuoxClipboardEvent extends QuoxJsxClipboardEvent ? true : false,
  QuoxDataTransfer extends QuoxJsxDataTransfer ? true : false,
  QuoxDOMInputEvent extends QuoxJsxInputEvent ? true : false,
  QuoxCompositionEvent extends QuoxJsxCompositionEvent ? true : false,
  QuoxFocusEvent extends QuoxJsxFocusEvent ? true : false,
] = [true, true, true, true, true, true, true, true, true, true, true];

const supportedEvents = (
  <input
    id="field"
    type="text"
    aria-label="Field"
    data-test-id="field"
    onMouseEnter={false}
    onBlur={null}
    onPointerDown={(event) => expectType<QuoxJsxPointerEvent>(event)}
    onPointerMoveCapture={(event) => expectType<QuoxJsxPointerEvent>(event)}
    onPointerCancel={(event) => expectType<QuoxJsxPointerEvent>(event)}
    onMouseUp={(event) => expectType<QuoxJsxMouseEvent>(event)}
    onWheelCapture={(event) => expectType<QuoxJsxWheelEvent>(event)}
    onAuxClick={(event) => expectType<QuoxJsxPointerEvent>(event)}
    onKeyDown={(event) => expectType<QuoxJsxKeyboardEvent>(event)}
    onCopy={(event) => expectType<QuoxJsxClipboardEvent>(event)}
    onCutCapture={(event) => expectType<QuoxJsxClipboardEvent>(event)}
    onPaste={(event) => {
      expectType<QuoxJsxClipboardEvent>(event);
      expectType<QuoxJsxDataTransfer | null>(event.clipboardData);
    }}
    onBeforeInputCapture={(event) => expectType<QuoxJsxInputEvent>(event)}
    onInput={(event) => expectType<QuoxJsxInputEvent>(event)}
    onChange={(event) => expectType<QuoxJsxEvent>(event)}
    onCompositionStart={(event) => expectType<QuoxJsxCompositionEvent>(event)}
    onCompositionUpdateCapture={(event) => expectType<QuoxJsxCompositionEvent>(event)}
    onCompositionEnd={(event) => expectType<QuoxJsxCompositionEvent>(event)}
    onFocusOutCapture={(event) => expectType<QuoxJsxFocusEvent>(event)}
    onDoubleClick={(event) => expectType<QuoxJsxMouseEvent>(event)}
    onDblClickCapture={(event) => expectType<QuoxJsxMouseEvent>(event)}
  />
);

const wrongPayload = (
  <div
    onWheel={(event) => {
      // @ts-expect-error Wheel events do not expose keyboard identity.
      expectType<string>(event.key);
    }}
  />
);

// Arbitrary HTML/SVG and custom attributes remain available. Unknown event-looking props cross
// the same open attribute surface, then Quox's mount-time validator rejects their functions.
const broadAttributeSurface = (
  <main nonce="nonce" inputMode="text" enterKeyHint="go" autocapitalize="sentences" itemProp="main">
    <img srcSet="small.png 1x" loading="lazy" referrerPolicy="no-referrer" popover="auto" />
    <svg viewBox="0 0 10 10">
      <path d="M0 0L10 10" fill="black" />
    </svg>
  </main>
);
const runtimeValidatedBeforeInput = <input onBeforeInput={() => {}} />;
const runtimeValidatedMadeUpEvent = <div onMadeUp={() => {}} />;
// @ts-expect-error Supported event props still reject non-handler truthy values.
const invalidTruthyHandler = <button type="button" onClick />;
// @ts-expect-error Supported handlers receive their event object, not an arbitrary parameter type.
const invalidHandlerParameter = <button type="button" onClick={(_event: string) => {}} />;

interface SaveButtonProps {
  label: string;
  onSave(value: string): void;
}

const SaveButton: QuoxComponent<SaveButtonProps> = ({ label, onSave }) => (
  <button
    type="button"
    onClick={() => onSave(label)}
  >
    {label}
  </button>
);
const customComponent = <SaveButton label="Save" onSave={() => {}} />;
// @ts-expect-error Custom component props still enforce their own required fields.
const incompleteCustomComponent = <SaveButton onSave={() => {}} />;

Deno.test("JSX event props retain runtime vnodes", () => {
  assertEquals(runtimeEventCompatibility.every(Boolean), true);
  assertEquals(isQuoxVNode(supportedEvents), true);
  assertEquals(isQuoxVNode(wrongPayload), true);
  assertEquals(isQuoxVNode(broadAttributeSurface), true);
  assertEquals(isQuoxVNode(runtimeValidatedBeforeInput), true);
  assertEquals(isQuoxVNode(runtimeValidatedMadeUpEvent), true);
  assertEquals(isQuoxVNode(invalidTruthyHandler), true);
  assertEquals(isQuoxVNode(invalidHandlerParameter), true);
  assertEquals(isQuoxVNode(customComponent), true);
  assertEquals(isQuoxVNode(incompleteCustomComponent), true);
});
