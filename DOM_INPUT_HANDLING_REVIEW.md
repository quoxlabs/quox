# DOM input handling compatibility review

- Review date: 2026-07-10
- Repository revision: `a48ca1647f006b6bda5c1a7373475c3588c92e9c`
- Primary package: `packages/quox`
- Pinned DOM engine: Blitz `0.3.0-alpha.6`, source revision `adbad3c35dfea4b3153656aa96acba13c82044d0`

## Executive assessment

The implemented input surface is not browser-compatible today. The largest problem is architectural rather than a
collection of missing event names: Blitz performs its handler phase and default action inside Rust, Quox records only a
target node ID for seven selected event kinds, and JavaScript callbacks run after the whole renderer call returns. At
that point the event payload, propagation path, ordering, cancellation opportunity, and often the target identity have
already been lost.

That design causes ordinary cases to fail. Clicking the rendered text inside the repository's own `<h2 onClick>` example
can miss the element handler, `onInput` cannot read the new value, focus callbacks are reversed, repeated scroll events
collapse, and no author callback can prevent a checkbox toggle, link action, text edit, wheel scroll, or focus change.

There are also independent, immediately user-visible input errors:

- Wheel direction is inverted at the Quox-to-Blitz boundary.
- `mouseup.buttons` still contains the released button.
- Mouse down, up, and wheel target stale coordinates rather than the coordinates of the occurrence.
- The logical `KeyboardEvent.key` is intentionally frozen across modifier changes, contrary to browser behavior.
- Pointer modifiers are discarded, so even an internal Shift-click selection does not work.
- The pinned click synthesizer creates a click from an unmatched mouseup and does not use the down/up common ancestor.
- Editing has no `beforeinput` or composition event model, and the only bridged `input` callback has neither an
  `InputEvent` nor a readable live control value.

The source-level FFI constants are not uniformly wrong. The first three button ordinals, their DOM `buttons` bits, key
locations, key flags, optional UTF-8 preedit offsets, and IME snapshot layout agree on both sides for valid declared
inputs. Those correct encodings do not compensate for the lost semantics around them.

Exact browser compatibility will require replacing the post-hoc mailbox bridge, not expanding it with more `take_*_node`
slots.

## Scope and exclusions

This review traces the implemented input path through:

- `packages/quox/dom/input.ts`
- `packages/quox/dom/window.ts`
- `packages/quox/dom/document.ts`
- `packages/quox/dom/handlers.ts`
- `packages/quox/dom/mount.ts`
- `packages/quox/dom/node.ts`
- `packages/quox/src/interaction.rs`
- the IME mailbox and layout integration in `packages/quox/src/lib.rs`
- the public Winding event types and shared keyboard/IME normalization in `packages/winding/types.ts` and
  `packages/winding/input/`
- the exact pinned Blitz event-driver behavior on which the interface relies

The generated files under `packages/quox/lib/`, the failing WASM build/type check, and the known upstream tooling
problem were excluded completely, as requested. This is a source-interface and invariant review. It does not infer
defects from stale generated declarations.

The platform-specific Winding backends were not audited. Where the DOM adapter needs information that the current
Winding event shape does not contain—occurrence coordinates, pointer modifiers, screen coordinates, authoritative button
state, or wheel units—the report identifies the interface requirement but does not prescribe backend implementation
changes. The wheel-sign finding uses the already-implemented Winding sign convention only to establish the Quox-to-Blitz
mismatch.

Network, rendering, accessibility, generic DOM mutation, and non-input backend behavior are outside scope except where a
DOM mutation directly invalidates input handler identity.

## Method and compatibility baseline

The review followed each public event shape through routing, FFI conversion, Blitz dispatch/default behavior, Rust
recording, and JavaScript callback delivery. Browser behavior was checked against current primary specifications rather
than secondary summaries:

| Area                                                                                     | Authoritative source used                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EventTarget, dispatch, cancellation, propagation, listener exceptions                    | [DOM Standard](https://dom.spec.whatwg.org/#events)                                                                                                                                                               |
| Keyboard, focus, mouse, wheel, and composition event order/data                          | [UI Events](https://w3c.github.io/uievents/); the non-normative [UI Events Algorithms](https://w3c.github.io/uievents/event-algo.html) is used only as implementation-oriented corroboration                      |
| Pointer and compatibility-mouse rules, click targeting, chorded buttons, pointer capture | [Pointer Events](https://w3c.github.io/pointerevents/)                                                                                                                                                            |
| `beforeinput`, `inputType`, `data`, target ranges, and IME order                         | [Input Events](https://w3c.github.io/input-events/)                                                                                                                                                               |
| Form-control activation, disabled controls, labels, checkbox/radio events                | [HTML Standard: input](https://html.spec.whatwg.org/multipage/input.html), [forms](https://html.spec.whatwg.org/multipage/forms.html), and [interaction](https://html.spec.whatwg.org/multipage/interaction.html) |
| Mouse coordinate types, hit testing, and queued scroll events                            | [CSSOM View](https://drafts.csswg.org/cssom-view/)                                                                                                                                                                |
| Candidate cross-browser conformance cases                                                | [Web Platform Tests](https://github.com/web-platform-tests/wpt)                                                                                                                                                   |

WPT source tests were used to select regression cases, not as evidence that every listed browser currently passes them.
No live browser harness or wpt.fyi result matrix was run for this static review. Where a specification deliberately
permits platform variation, the findings below distinguish a normative violation from a mainstream-browser
interoperability gap.

`Cargo.toml` pins all Blitz crates to `0.3.0-alpha.6`. The crates.io package metadata identifies upstream revision
`adbad3c35dfea4b3153656aa96acba13c82044d0`. Relevant pinned source is available at:

- [Blitz EventDriver](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-dom/src/events/driver.rs)
- [pointer, click, control activation, and wheel defaults](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-dom/src/events/pointer.rs)
- [focus generation](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-dom/src/events/focus.rs)
- [keyboard defaults](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-dom/src/events/keyboard.rs)
- [IME defaults](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-dom/src/events/ime.rs)
- [event data types](https://github.com/DioxusLabs/blitz/blob/adbad3c35dfea4b3153656aa96acba13c82044d0/packages/blitz-traits/src/events.rs)

The source-level Rust interaction tests were run separately from the excluded WASM build: `cargo test interaction --lib`
passed 17/17. Those tests validate selected helpers and editor paths; they are not DOM conformance tests and currently
contain no meaningful pointer, wheel, click-target, focus-order, or event-mailbox coverage.

## Current event path

The implemented path is:

    Winding UIEvent
        -> mapWindingEvent()
        -> QuoxInputRouter state and normalization
        -> QuoxDocument dispatch*()
        -> wasm-bindgen QuoxRenderer method
        -> Blitz EventDriver handler phase
        -> Blitz default action and generated events
        -> one Optional<node-id> slot per selected event kind
        -> take_*_node() in a fixed kind order
        -> exact-node, zero-argument JSX callback
        -> raw QuoxWindow observer

The browser path is materially different. Conceptually, and with event-specific variation, it is:

    trusted input
        -> any defined legacy pre-activation behavior
        -> determine target and immutable event path
        -> capture listeners, target listeners, and bubble listeners when applicable
        -> observe cancellation/propagation state
        -> perform, suppress, or roll back event-specific activation/default behavior
        -> dispatch generated events in production order

Not every event bubbles or is cancelable, and specifications place some event-specific behavior before, during, or after
listener dispatch. Blitz's `EventHandler` hook nevertheless receives the event, event path, mutable cancellation state,
and document at the point where its event can still influence the associated default. `RecordingEventHandler` discards
all of that except `chain.first()` and the event kind. The most valuable information is therefore present immediately
before the Quox bridge throws it away.

## Severity guide

- **Critical**: the current architecture cannot express a required browser invariant, or a common operation is
  reversed/unusable.
- **High**: ordinary author code receives wrong behavior or silently misses an event.
- **Medium**: a significant edge case, metadata mismatch, robustness defect, or compatibility gap.
- **Low**: narrower FFI hardening, forward compatibility, documentation, or test quality.

## Findings at a glance

| ID   | Severity | Finding                                                                            |
| ---- | -------- | ---------------------------------------------------------------------------------- |
| D-01 | Critical | JSX callbacks are post-default notifications, not DOM event dispatch               |
| D-02 | High     | Per-kind single-slot mailboxes destroy event order and multiplicity                |
| D-03 | High     | Text-node hit targets plus target-only lookup lose ordinary element handlers       |
| D-04 | High     | Event payloads and live input/control state are unavailable                        |
| D-05 | High     | Most accepted JSX event props are silently dead                                    |
| D-06 | High     | Callback exceptions and synchronous reentrancy lose pending events                 |
| D-07 | High     | Reused numeric node IDs can deliver old handlers to unrelated replacement nodes    |
| D-08 | Medium   | `QuoxWindow.addEventListener` is incompatible with `EventTarget`                   |
| P-01 | High     | `mouseup.buttons` includes the released button and cleanup is exception-unsafe     |
| P-02 | High     | Down/up/wheel occurrence coordinates are missing and targeting is stale            |
| P-03 | High     | Click synthesis accepts unmatched releases and uses the wrong target rule          |
| P-04 | High     | Chorded button transitions do not follow Pointer Events                            |
| P-05 | High     | Lost pointer modifiers break Shift-click; other pointer fields are fabricated      |
| P-06 | Medium   | Out-of-window/lost releases and direct hover clearing can strand interaction state |
| P-07 | Medium   | Pointer hit testing can use arbitrarily stale layout                               |
| W-01 | Critical | Wheel direction is inverted                                                        |
| W-02 | High     | Wheel units, precision, target transaction, and cancellation are absent            |
| W-03 | High     | Scroll events are missing, collapsed, reordered, and synchronously timed           |
| K-01 | High     | Keyboard handlers/cancellation and editing event order are absent                  |
| K-02 | High     | Logical `key` is frozen across modifier/layout changes                             |
| K-03 | Medium   | Keyboard location/modifier projection is not lossless DOM state                    |
| K-04 | High     | Keyboard activation and focus traversal differ from browsers                       |
| I-01 | High     | Composition and `beforeinput` are absent; `input` is incomplete                    |
| I-02 | High     | Checkbox/radio/label/disabled-control activation violates HTML event rules         |
| I-03 | Medium   | IME surrounding deletion is a silent no-op and commits over-filter text            |
| A-01 | Medium   | FFI numeric validation happens after narrowing or not at all                       |
| A-02 | Medium   | IME request snapshots are acknowledged before native application succeeds          |
| A-03 | Low      | Newer valid named logical keys can become `Unidentified`                           |

## Detailed findings

### D-01 — JSX callbacks are post-default notifications, not DOM event dispatch

**Severity: Critical**

`QuoxDocument.#dispatchInputEvent()` calls the renderer first and only then drains callbacks (`document.ts:181-210`).
The renderer call does not return until Blitz has:

1. chosen a target,
2. called `RecordingEventHandler`,
3. performed the event's default action if not internally canceled, and
4. processed generated events such as `click`, `input`, focus events, and `dblclick`.

The JavaScript callback receives no argument, is not called with an event-specific `this`, and has no channel back to
the event state. It therefore cannot inspect `target` or `currentTarget`, call `preventDefault()`, stop propagation,
inspect `defaultPrevented`, request pointer capture, or influence the relevant default-action decision.

Default timing is event-specific. Browsers also expose a checkbox's legacy pre-toggled state during its `click`
listener, but canceling that click triggers rollback; Quox cannot request the rollback. Mouse focus commonly occurs as a
`mousedown` default rather than a `click` default; a browser author can intervene from the earlier mouse/pointer event,
while Quox exposes no JavaScript handler at that point. Link activation and text edits likewise complete inside the Rust
call before the corresponding Quox-visible callback.

This is not repairable by adding payload fields to the existing `take_*_node` methods.
[DOM dispatch](https://dom.spec.whatwg.org/#concept-event-dispatch) runs listeners over an event path and cancellation
must be known before default behavior continues. A browser-compatible bridge needs a staged dispatch protocol or a
borrow-safe synchronous JavaScript hook which:

- exposes a full event and frozen propagation path before default action;
- invokes capture, target, and bubble listeners in order;
- returns cancellation and propagation flags to Rust;
- allows listener-driven DOM mutation and nested dispatch without a Rust `RefCell` reborrow failure;
- resumes, suppresses, or rolls back the event-specific action only after JavaScript dispatch completes.

The current native `editDisposition` bit can suppress selected key defaults, but that is an internal OS/editor policy
selected before any author callback. It is not an implementation of author `preventDefault()`.

### D-02 — Single-slot mailboxes destroy event order and multiplicity

**Severity: High**

`RecordedEvents` contains seven `Option<usize>` fields (`interaction.rs:244-258`). Each matching event overwrites the
previous target of that kind. TypeScript then reconstructs an invented order:

1. click
2. dblclick
3. contextmenu
4. input
5. focus
6. blur
7. scroll

That order is unrelated to the order in which Blitz generated the events.

Concrete failures:

- A focus transfer is generated as old `blur`, old `focusout`, new `focus`, new `focusin`; Quox invokes new `focus`
  before old `blur`, contrary to the
  [UI Events focus sequence](https://w3c.github.io/uievents/#events-focusevent-event-order).
- A pointerup can generate `click`, then a control's `input`, then blur/focus events, then `dblclick`. Quox moves
  `dblclick` ahead of `input` and focus, and moves `focus` ahead of `blur`.
- One wheel input can partially scroll a nested scroller and then bubble a remainder to an ancestor. Blitz emits a
  `scroll` for each changed element, but only the last target survives.

The mailbox is reset at the start of every valid host dispatch. An ordered queue of immutable, full event records is
required. The queue must be detached before callbacks run, or reentrant dispatch must use nested queues/dispatch frames
so an inner event cannot erase the outer event sequence.

### D-03 — Text-node targets lose ordinary element handlers

**Severity: High**

Pinned Blitz hit testing can return a text node ID when the pointer is over a glyph. Its event chain begins with that
text node followed by element ancestors. Quox records only `chain.first()`, and `#invokeHandler()` looks up only that
exact ID (`interaction.rs:280-297`; `document.ts:206-210`).

JSX handlers are registered on elements. Therefore this common markup is unreliable:

    <button onClick={handler}>Save</button>

Clicking a glyph records the text child's ID, finds no handler, and does not bubble to the button. Clicking padding may
record the button and work. The repository's own `examples/jsx.tsx` `<h2 onClick>` demonstration is affected.

[Pointer Events explicitly states](https://w3c.github.io/pointerevents/#the-click-auxclick-and-contextmenu-events) that
user-agent-generated mouse events are not dispatched on `Text` nodes; trusted click-family targets are elements, and
bubbling would reach the button in either case. Quox should normalize trusted pointer targets to the appropriate element
and preserve the event path; merely walking upward until any handler is found would still get `target`, propagation
order, capture, `currentTarget`, and stop-propagation semantics wrong.

### D-04 — Event payloads and live input state are unavailable

**Severity: High**

`RecordingEventHandler` discards every event payload. This includes pointer coordinates/buttons/modifiers, wheel deltas,
the Blitz input value, focus relationship, and scroll geometry. `#invokeHandler()` calls the selected function with zero
arguments.

The fallback DOM facade does not expose the state elsewhere:

- no live `value` or `checked`;
- no `selectionStart`, `selectionEnd`, or selection direction;
- no `scrollTop` or `scrollLeft`;
- no attribute getter;
- no `focus()`, `blur()`, or `activeElement`.

Consequently `onInput` cannot discover what the user typed or whether a checkbox/radio is checked. Reading `textContent`
or an HTML content attribute would not be a valid substitute: HTML's live control value and checkedness diverge from
their content attributes once their dirty flags are set.

At minimum, the bridge needs event-specific payloads and live form-control properties. For exact compatibility it needs
real `InputEvent`, `MouseEvent`/`PointerEvent`, `WheelEvent`, `FocusEvent`, and `Event` behavior.

### D-05 — Most accepted JSX event props are silently dead

**Severity: High**

`mount.ts:113-120` stores every function-valued prop without validating its name. Only seven exact names can ever be
read: `onClick`, `onDoubleClick`, `onContextMenu`, `onInput`, `onFocus`, `onBlur`, and `onScroll`.

The following common props compile, mount, and then never fire:

- `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerEnter`, `onPointerLeave`;
- `onMouseDown`, `onMouseUp`, `onMouseMove`, `onMouseEnter`, `onMouseLeave`;
- `onWheel`, `onAuxClick`;
- `onKeyDown`, `onKeyUp`;
- `onBeforeInput`, `onChange`;
- `onCompositionStart`, `onCompositionUpdate`, `onCompositionEnd`;
- `onFocusIn`, `onFocusOut`;
- all capture variants.

The JSX type is an open string index and supplies no event contextual type, so neither spelling nor handler shape is
checked.

There is also a Preact-specific mismatch. Quox explicitly accepts core Preact vnode shapes, for which the normal
double-click prop is `onDblClick`; the drain checks React's `onDoubleClick` spelling only. Standard Preact double-click
handlers are stored and dead. See
[Preact's documented differences](https://preactjs.com/guide/v10/differences-to-react/).

Unsupported props should be rejected or warned about until a real event surface exists. Silently storing them makes
compatibility failures difficult to diagnose.

### D-06 — Callback exceptions and reentrancy lose pending events

**Severity: High**

`#invokeHandler()` calls a callback directly without per-listener exception isolation. If the callback throws:

- the remainder of the fixed mailbox drain is skipped;
- the raw `QuoxWindow` observer for that native event is never reached;
- pending slots are normally reset by the next valid dispatch;
- the `mouseup` router's held-button cleanup can also be skipped because it occurs after the port call.

[DOM listener invocation](https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke) reports callback exceptions
and continues; it does not propagate them through event dispatch or prevent later listeners from running.

Reentrancy is equally destructive. If `onClick` synchronously calls any public `dispatch*()`, `with_event_driver()`
resets `RecordedEvents` while the outer TypeScript drain is still reading it. Pending outer `dblclick`, `input`, focus,
or scroll records disappear. A few early-return renderer methods do not reset the mailbox at all; the TypeScript wrapper
can then drain an old record during the unrelated rejected dispatch, while `clearHover()` can leave one for a later
drain.

This needs explicit nested dispatch frames, stable event records, and browser-style exception reporting. A blanket
`try/catch` around the existing drain would prevent propagation of an error but would not make its order or reentrancy
correct.

### D-07 — Reused numeric node IDs can misdeliver old handlers

**Severity: High**

The handler registry is a document-level `Map<number, Map<string, Function>>` with no generation or lifecycle
information (`handlers.ts:7-27`). `innerHTML` and non-text `textContent` replacement drop descendants in the Rust tree
(`dom.rs:168-175,200-223`) but do not update the registry. Blitz stores nodes in `slab::Slab`, whose integer keys are
reusable.

After replacement:

1. the old descendant's integer ID becomes free;
2. a newly parsed or created node can receive the same ID;
3. a later event on the new node looks up the old node's handler;
4. a retained old `QuoxNode` wrapper also aliases the unrelated new node.

This is a correctness and identity bug, not only a leak. Simply clearing handlers in `QuoxNode.remove()` is not a
complete fix: browser listeners remain attached to a deliberately detached node, and the current remove path retains the
node entry. The DOM facade needs stable non-reused handles or generational IDs, plus subtree-aware disposal when nodes
are actually destroyed.

Stable identity is a prerequisite for exposing trustworthy `Event.target` and listener registration.

### D-08 — `QuoxWindow.addEventListener` is not `EventTarget`

**Severity: Medium**

The signature is `addEventListener(callback)`, not `addEventListener(type, callback, options)`. It broadcasts every
custom `QuoxInputEvent` to every callback. There are no capture, once, passive, or signal options; no event object; and
no target-specific path.

Behavior also differs:

- duplicate callbacks are allowed and invoked repeatedly;
- `removeEventListener` removes only the first duplicate;
- the notifier snapshots raw functions, so a callback removed earlier in the same notification still runs;
- routing and DOM/default processing happen before these callbacks;
- callback errors are deferred as a later microtask exception.

The error isolation is useful for this custom observer and deliberately prevents one raw observer from blocking later
native commit events. It should be retained under an honest name such as `addInputListener` or `observeNativeInput`. It
should not be presented as browser [`EventTarget`](https://dom.spec.whatwg.org/#interface-eventtarget) unless the full
contract is implemented.

### P-01 — `mouseup.buttons` includes the released button

**Severity: High**

The router calls `pointerUp(..., this.#buttons)` and clears the released bit afterward (`input.ts:73-75`). The normative
[`buttons` definition represents currently depressed buttons](https://w3c.github.io/pointerevents/#button-states); the
informative [UI Events native mouseup algorithm](https://w3c.github.io/uievents/event-algo.html#handle-native-mouse-up)
illustrates this by clearing the global button mask before constructing and dispatching `mouseup`. Therefore, for a sole
primary-button release:

| Value     | Browser | Quox |
| --------- | ------: | ---: |
| `button`  |       0 |    0 |
| `buttons` |       0 |    1 |

The wrong mask propagates into Blitz `pointerup`, compatibility `mouseup`, synthesized `click`/`contextmenu`/`dblclick`,
and any internal logic reading the event.

The order is also exception-unsafe: if the renderer or a drained callback throws, the clearing line is never executed
and all later moves claim the button is still held. Clear the bit before dispatch and use `finally` for state
reconciliation. Longer term, prefer authoritative current button state from the host event contract over a state machine
which assumes no transition is ever lost.

### P-02 — Occurrence coordinates are missing and targeting is stale

**Severity: High**

`QuoxMouseButtonEvent` contains only `button`; `QuoxMouseWheelEvent` contains only deltas. The router reuses the last
`mousemove` position, initialized to `(0, 0)`.

Wrong-target cases include:

- a first click or wheel event before any move;
- a newly opened or moved window underneath a stationary pointer;
- a coalesced or lost move;
- layout moving beneath a stationary pointer;
- a release occurring at a different location without a delivered final move.

Browsers use the coordinates associated with each native occurrence. Down, up, and wheel records need their own client
coordinates. Wheel targeting additionally must not depend only on Blitz's pre-existing hover: the pinned `EventDriver`
does not refresh hover for a wheel event, and its default wheel handler scrolls the stored hover node.

This is one of the interface extensions that requires host bindings to provide more data. The DOM adapter cannot
reconstruct it reliably.

### P-03 — Click synthesis accepts unmatched releases and uses the wrong target

**Severity: High**

Pinned Blitz's `handle_pointerup` queues:

- `click` for any non-drag primary release; or
- `contextmenu` for any non-drag secondary release.

It does not require a matching pointerdown and does not consult its stored mousedown target. Thus:

- an up with no down clicks;
- down on A and up on B clicks B;
- no nearest common inclusive ancestor is calculated.

[Pointer Events' click targeting algorithm](https://w3c.github.io/pointerevents/#the-click-auxclick-and-contextmenu-events)
requires `click`/`auxclick` targeting based on the nearest common inclusive ancestor of the down and up targets when
capture is absent. Non-primary activation is represented by `auxclick`; Blitz has no `auxclick` event data at all.

Double-click state is also global to position/time: a hard-coded 500 ms and 2 px check increments on every pointerdown
without including target or button. Intervening clicks on another target or with another button can poison whether the
next primary click produces `dblclick`.

Quox should track the complete press sequence or adapt corrected upstream behavior before claiming browser click
compatibility.

### P-04 — Chorded button transitions violate Pointer Events

**Severity: High**

For a [chorded mouse](https://w3c.github.io/pointerevents/#chorded-button-interactions):

- `pointerdown` fires only on the transition from no buttons to at least one button;
- additional button presses produce `mousedown` and a `pointermove` reflecting the new state, not another `pointerdown`;
- `pointerup` fires only when the last held button is released;
- intermediate releases produce `mouseup` and `pointermove`, not `pointerup`.

Quox sends every physical down/up into a single Blitz path. Pinned Blitz emits both the pointer event and compatibility
mouse event for every call, so it produces extra `pointerdown`/`pointerup` events for chords.

The public Winding interface currently exposes only left/middle/right transitions and no authoritative full button mask.
The Rust ABI has fourth/fifth enum values, but the router has no corresponding held bits. Exact chord behavior requires
a richer host contract and a Quox adapter which separates pointer transition rules from mouse transition rules.

### P-05 — Pointer modifiers and metadata are wrong or absent

**Severity: High for modifiers; Medium for remaining metadata**

`pointer_event()` and the wheel constructor always use `Modifiers::empty()`. Pinned Blitz explicitly checks Shift on
pointerdown to extend a text selection. Native Shift-click therefore collapses/moves the caret rather than extending the
selection.

Other mismatches under the [PointerEvent field rules](https://w3c.github.io/pointerevents/#pointerevent-interface):

- `ctrlKey`, `shiftKey`, `altKey`, and `metaKey` would always be false;
- pointermove hard-codes `button = Main`, whereas a move with no button transition requires `button = -1`;
- `screenX/screenY` are fabricated as equal to client coordinates;
- coordinates narrow from JavaScript double to Rust/Blitz `f32`;
- default pointer details report zero pressure even while a mouse button is active; Pointer Events uses 0.5 for an
  active device with no pressure support;
- altitude/azimuth, width/height, tangential pressure, twist, pointer type, and device identity are unavailable;
- no pointer capture or `pointercancel` path exists.

Several of these cannot be made exact until the host event interface carries the missing fields. In the interim, do not
expose fabricated values as DOM-compatible event properties.

### P-06 — Interrupted streams can strand interaction state

**Severity: Medium**

The router infers `buttons` only from paired down/up transitions. Window blur is ignored, visibility changes do not
reconcile input state, and mouse leave only calls `clearHover()`. Rust's viewport guard drops non-finite or
out-of-bounds pointer events. A release lost outside the window, during focus loss, or at an out-of-bounds coordinate
can leave one side believing a drag or `:active` press is still in progress.

`clear_hover()` directly clears CSS hover state. It does not drive `pointerout`, `pointerleave`, `mouseout`, or
`mouseleave`, and it does not clear active/drag state.

The interface needs a cancellation/reconciliation event carrying authoritative current buttons.
[`pointercancel`](https://w3c.github.io/pointerevents/#the-pointercancel-event),
[pointer capture](https://w3c.github.io/pointerevents/#pointer-capture), or equivalent host tracking is also needed for
releases outside bounds.

### P-07 — Input hit testing can use stale layout

**Severity: Medium**

`node_from_point()` forces a layout resolve, but pointer move/down/up and wheel deliberately use the last resolved
layout. The comment describes staleness as approximately one frame, but it can be unbounded before the render loop
starts, while the window is hidden, after a handler-driven DOM mutation, or when rendering is suspended.

[Pointer Events requires boundary events after relevant layout changes](https://w3c.github.io/pointerevents/#boundary-events-caused-by-layout-changes),
even for a stationary pointer. Quox can target the old element and emits no layout-induced boundary sequence.

A performance-conscious solution can coalesce layout work, but down/up/default activation must not run against
arbitrarily stale geometry.

### W-01 — Wheel direction is inverted

**Severity: Critical**

The implemented Winding convention reports wheel-down as positive Y. `QuoxInputRouter` preserves that sign and
multiplies by positive 40. `dispatch_wheel()` then labels it a Blitz pixel delta without changing sign.

Pinned Blitz applies scroll as:

    new_offset = current_offset - delta

At the top of a document:

    wheel down: +1
    Quox scale: +40
    Blitz candidate offset: 0 - 40 = -40
    clamp: 0

Wheel down therefore does not scroll down. Wheel up produces a negative Quox delta, which Blitz subtracts and turns into
positive downward scroll.

Under the
[WheelEvent conventional/default-scroll expectation](https://w3c.github.io/pointerevents/#interface-wheelevent),
positive Y follows the down direction when the default action scrolls. That requirement is deliberately phrased as a
`SHOULD` because devices/platforms can vary, but Winding's implemented contract already normalizes wheel-down to
positive Y. Blitz's internal delta follows the opposite content-motion convention, so Quox must negate at this boundary.
This correction is independent of the separate unit/scaling redesign below.

### W-02 — Wheel units, target transactions, and cancellation are absent

**Severity: High**

The public wheel record has no `deltaMode`. Every input is multiplied by 40 and then passed to Blitz as pixels. That
assumes every host value is a line notch:

- precision trackpad deltas are over-scaled;
- platform line settings and page scrolling cannot be represented;
- fractional precision is not given a stable contract;
- the observer sees unscaled values while the DOM default sees scaled values.

Browser `WheelEvent` exposes pixel/line/page units, modifiers, coordinates, and its actual `cancelable` state. User
agents may make some wheel events non-cancelable, especially when no non-passive listener requires cancellation; Quox
cannot express that state or honor cancellation when it is available. A
[wheel transaction](https://w3c.github.io/pointerevents/#wheel-event-transaction) also retains the target chosen for its
first event even if later coordinates cross child boundaries. Quox has no transaction identity and uses mutable stored
hover for each event.

Wheel deltas are not checked for finiteness. A direct public `dispatchWheel(..., NaN, ...)` can reach Blitz's scroll
arithmetic; failed comparisons can assign `NaN` to a scroll offset and poison later layout/hit testing.

Required changes:

- carry per-occurrence coordinates, modifiers, timestamp, unit, and phase/transaction identity;
- expose the same values on a `WheelEvent`;
- dispatch it before the default and honor cancellation;
- translate the uncanceled delta exactly once into the scroll convention expected by Blitz;
- validate all numeric values before FFI narrowing.

### W-03 — Scroll events are missing or lose browser timing

**Severity: High**

Pinned Blitz emits a synchronous `Scroll` for each changed element during wheel default handling. It emits no `Scroll`
event when only the viewport/document scroll position changes. Quox then retains only the last element target and
invokes one payload-less `onScroll` before returning to the event loop.

[CSSOM View](https://drafts.csswg.org/cssom-view/#scrolling-events) instead maintains pending scroll-event targets and
dispatches them in defined order; element scroll and document/viewport scroll have distinct bubbling behavior. Authors
also need the resulting scroll position.

Current consequences:

- normal document scrolling can produce no `onScroll`;
- nested scrollers can collapse several events into one;
- `scrollTop`/`scrollLeft` cannot be read;
- event timing/order is synchronous and reconstructed by kind rather than queued as browsers do.

### K-01 — Keyboard handlers, cancellation, and editing order are absent

**Severity: High**

`onKeyDown` and `onKeyUp` are never delivered. The raw window observer is notified only after the renderer's key
dispatch and any Blitz default action. For a `key-default` Backspace/Delete, a text mutation and the zero-argument
`onInput` can occur before the raw observer sees `keydown`.

The [UI Events keyboard model](https://w3c.github.io/uievents/#events-keyboard-event-order) and
[Input Events](https://w3c.github.io/input-events/) define the browser editing order broadly as:

1. `keydown`;
2. cancelable `beforeinput` when an edit is about to occur;
3. mutation if not canceled;
4. `input` if the value actually changed;
5. `keyup`.

A canceled `keydown` suppresses its associated default action. Quox instead derives a `PreventDefault` FFI flag from
native `editDisposition`; author code never participates.

Clipboard edits, deletion, insertion, form submission, focus traversal, and keyboard activation therefore cannot be
observed/canceled at browser-compatible points.

### K-02 — Logical `key` is frozen across modifier/layout changes

**Severity: High**

`PressedLogicalKeyCache` deliberately retains the logical key from initial press for repeats and release, even if
modifiers or keyboard layout change.

[UI Events' code examples](https://w3c.github.io/uievents/#code-examples) require `key` to reflect the effective key
value at each event. The standard example is:

1. Shift is held.
2. Digit2 keydown reports `@` on a US layout.
3. Shift is released while Digit2 remains held.
4. later repeats and Digit2 keyup report `2`, while `code` remains `Digit2`.

Quox continues to report `@`. Layout changes while held have the same problem. Cache physical identity/repeat state if
needed, but recompute the logical key from the current layout/modifier state for every event.

### K-03 — Keyboard location and modifiers are not lossless DOM state

**Severity: Medium**

Fallback `location` is derived from physical `code`.
[UI Events defines location for the effective/remapped key](https://w3c.github.io/uievents/#interface-keyboardevent), so
a remapping can make this fallback wrong.

The Rust editor modifier mask intentionally omits physical Control and introduces a nonstandard Accelerator:

- physical `ctrlKey` remains visible only on the raw TypeScript event;
- on macOS, Command/accelerator is projected into Blitz `CONTROL` while Meta is also retained;
- physical macOS Control can be absent inside Blitz;
- AltGraph's synthetic Control is deliberately excluded.

That may be a reasonable internal editor workaround for a WASM build whose compile-time platform differs from the
runtime platform. It must not be reused as DOM `KeyboardEvent` modifier state. Keep physical modifiers and editor
command policy as separate fields.

The interface also cannot represent all `getModifierState()` values such as NumLock, ScrollLock, Fn/FnLock,
Symbol/SymbolLock, or platform-specific states.

### K-04 — Keyboard activation and focus traversal differ from browsers

**Severity: High**

Pinned Blitz's generic keyboard default handles text editors and a special Tab path, but it does not synthesize trusted
activation for:

- Enter on links and buttons;
- Space on buttons and checkboxes.

The Tab path calls `focus_next_node()` directly:

- Tab with no current focus does nothing rather than focusing the first eligible element;
- Shift+Tab still moves forward;
- focus state changes bypass `generate_focus_events`, so no blur/focus/focusout/focusin events are produced.

With no focused node, the event driver targets the root element; UI Events selects `body` when available, then falls
back to the root.

These are pinned-engine behaviors exposed directly by Quox. UI Events identifies focus traversal and Enter/Space
activation as [cancelable keydown defaults](https://w3c.github.io/uievents/#event-type-keydown). Mainstream desktop
browsers also use the Context Menu key and commonly Shift+F10 to dispatch `contextmenu`, but that shortcut is
platform/UA convention rather than a universal HTML activation requirement; Quox does not support it. These behaviors
should be corrected in the adapter or upstream and covered by browser-derived tests.

### I-01 — Composition and `beforeinput` are absent

**Severity: High**

The public native surface exposes custom IME records (`enabled`, `disabled`, `preedit`, `commit`, `deleteSurrounding`).
Pinned Blitz uses them to update its editor, but the DOM surface emits:

- no `compositionstart`;
- no `compositionupdate`;
- no `compositionend`;
- no `beforeinput`;
- one payload-less `input` on commit.

A browser `InputEvent` exposes at least `data`, `inputType`, `isComposing`, and—where applicable—data transfer and
target ranges. [Composition events](https://w3c.github.io/uievents/#events-composition-input-events) and
[IME editing events](https://w3c.github.io/input-events/#event-order-during-ime-composition) define the target
specification model, and `isComposing` reflects the interval between composition start and end. Some details are
`SHOULD` requirements and still vary between browser/IME combinations; Quox cannot express even the common lifecycle or
its cancellation rules.

The underlying native IME records can remain an internal transport, but they must be translated into the DOM
composition/editing event sequence before mutation.

### I-02 — Form-control activation violates HTML event rules

**Severity: High**

Pinned Blitz and the Quox bridge combine to produce several form-control mismatches:

- Checkbox and radio activation emit `input` but never `change`.
- An already-checked radio still emits `input`; mainstream browsers generally omit `input`/`change` when checkedness did
  not change, and the Blitz source itself has a TODO to make this conditional. The current HTML radio activation prose
  fires the pair unconditionally, so this particular edge is an interoperability/spec-tension finding rather than an
  uncontested normative violation.
- Radio `input` data is hard-coded to the string `"true"`.
- A valid `<input type="radio">` with no `name` panics because the default action unwraps the missing attribute.
- Label activation calls the associated control's default handler directly instead of dispatching the control's
  synthetic `click`, so the control's `onClick` cannot observe the behavior used by mainstream browser platforms. HTML
  deliberately allows label activation to follow platform behavior, including a control click, focus-only behavior, or
  no action, so this is not universal across every permitted platform.
- Blitz queues the trusted click before its default handler checks `disabled`; a disabled control's exact-target Quox
  handler can run even though HTML suppresses queued user-interaction click events on disabled controls.
- File-input state changes do not dispatch the required input/change pair.

Even the emitted `input` is not useful to author code because D-04 removes its data and the control state has no getter.

This area needs HTML activation tests, not just pointer tests:
[checkbox/radio activation](https://html.spec.whatwg.org/multipage/input.html), radio-group changes, input-then-change
order, [label synthetic click](https://html.spec.whatwg.org/multipage/forms.html#the-label-element),
[disabled controls](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#enabling-and-disabling-form-controls-the-disabled-attribute),
and keyboard activation.

### I-03 — IME deletion is a silent no-op and commits over-filter text

**Severity: Medium**

`dispatch_ime_delete_surrounding` is a public, apparently supported method. Pinned Blitz accepts the event and then
discards both byte counts under a TODO. IMEs which depend on replacing surrounding text cannot work, and the boolean
return does not identify the operation as unsupported.

Both Winding normalization and Rust reject any commit containing a C0/C1/DEL code point by rejecting the entire string.
That includes newlines and tabs which are valid text edits in a textarea or can appear in committed/voice/dictation
content. A mixed string containing one such code point loses every otherwise valid character.

Rust's early rejection occurs before it drives an empty-preedit clear. An unexpected direct commit can therefore leave
visible preedit state behind. If an input truly must be rejected, composition still needs a defined end/clear path.

### A-01 — Numeric validation occurs after FFI narrowing

**Severity: Medium**

The TypeScript public methods accept unrestricted `number`, while wasm-bindgen parameters are `u8`, `u32`, `usize`,
`f32`, or `f64`. Several validations are either absent or happen after the irreversible conversion:

- button values wrap/truncate to `u8`; Rust maps every value except 1–4 to primary, so invalid input can become a
  primary click;
- unknown held-button bits are silently truncated by Blitz bitflags;
- key masks/location use panicking assertions after conversion, so NaN, fractions, negatives, or multiples of 2^32 may
  already look valid;
- optional preedit offsets narrow before Rust checks UTF-8 boundaries;
- delete-surrounding values are checked as safe nonnegative JavaScript integers but not limited to `u32::MAX`;
- pointer coordinates narrow from double to `f32`;
- wheel deltas permit non-finite `f64`.

Validate public values in TypeScript before crossing the FFI boundary, return typed errors instead of panicking, and use
wide enough boundary types to validate before narrowing. Invalid button values must never silently become primary
activation.

### A-02 — IME request delivery is acknowledged too early

**Severity: Medium**

`ImeRequestMailbox.take_snapshot()` marks desired cursor/enabled values as delivered before the host applies them.
`#syncNativeImeRequests()` then calls native setters. If either setter throws, the snapshot will not be returned again
because Rust already considers it delivered.

`applyImeRequestSnapshot()` applies geometry before enabled state, which is the correct order, but it is not atomic:
geometry can succeed and enable can fail. A sync error in `#dispatchInputEvent`'s `finally` can also replace the
original renderer/callback exception.

Use peek/apply/ack semantics, or acknowledge only after all required native operations succeed. Preserve both errors
when dispatch and IME synchronization fail.

### A-03 — Newer valid named keys can become `Unidentified`

**Severity: Low**

Rust parses `key` through `keyboard-types 0.7` and turns every parse failure into `Key::Unidentified`. This conflates an
unknown or mistyped value with a valid named key introduced after the pinned library's generated enum.

The [UI Events key-value Recommendation](https://www.w3.org/TR/uievents-key/#unicode-values) more narrowly defines
character key strings as a base character with any combining characters. The pinned parser already recognizes that
general shape; the definite concern here is named-key forward compatibility. Preserve the original logical string
alongside any engine enum, and use `Unidentified` only when the host genuinely could not identify the key.

## FFI/API correspondence matrix

This table separates structurally correct encodings from semantic gaps. It evaluates source definitions only and
deliberately ignores generated WASM artifacts.

| Value                                | TypeScript/Winding side                   | Rust/Blitz side                        | Assessment                                                              |
| ------------------------------------ | ----------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Primary/auxiliary/secondary `button` | 0/1/2                                     | Main/Auxiliary/Secondary 0/1/2         | Correct for the first three valid buttons                               |
| Held `buttons` bits                  | 1/4/2                                     | Primary/Auxiliary/Secondary 1/4/2      | Correct on down; wrong release timing; no authoritative reconciliation  |
| Fourth/fifth buttons                 | Not present in Winding union/router table | Rust accepts 3/4 and bits 8/16         | Interface mismatch; not reachable consistently                          |
| Pointer coordinates                  | JS `number`, only move carries x/y        | Rust/Blitz `f32`                       | Missing per down/up/wheel; precision narrows                            |
| Pointer modifiers                    | Not present                               | Always empty                           | Information loss; breaks internal Shift-click                           |
| Screen coordinates                   | Not present                               | Set equal to client                    | Fabricated, not DOM-compatible                                          |
| Wheel delta                          | No unit/mode; fixed ×40                   | `f64` Pixels                           | Sign inverted, unit contract wrong, no finite validation                |
| Key `code`/`key`                     | Strings copied exhaustively               | Parsed engine enums                    | Structurally connected; newer valid named values can be lost            |
| Key location                         | 0–3                                       | 0–3                                    | Correct for valid input; fallback derivation/remapping can be wrong     |
| Repeat/composing/pressed flags       | Stable bit constants                      | Matching bit constants                 | Correct for valid declared input                                        |
| Physical Control                     | Present on raw event                      | Deliberately omitted from editor mask  | Intentional internal projection, not DOM metadata                       |
| Accelerator                          | Nonstandard raw field                     | Mapped to Blitz Control                | Useful editor policy, not a DOM modifier                                |
| IME preedit range                    | Optional UTF-8 byte offsets               | Optional byte-boundary-checked offsets | Correct for valid Winding events; direct numeric narrowing needs guards |
| Delete surrounding                   | Safe nonnegative JS integer               | `u32`, then Blitz no-op                | Upper-bound mismatch and no implemented behavior                        |
| IME request snapshot                 | six `Float32` values with flags           | matching six-value layout              | Shape/order correct; acknowledgment/retry semantics wrong               |

## Correct behavior already present

The following source-level decisions should be preserved while redesigning the event bridge:

- `mapWindingEvent()` exhaustively copies the declared key and IME fields.
- The first three mouse-button ordinals and their non-linear DOM held-button bits are mapped correctly on press.
- Key location, repeat, composing, pressed, and internal prevent-default bit values match across TypeScript and Rust for
  valid inputs.
- Optional preedit ranges are treated as UTF-8 byte offsets and Rust rejects non-boundary ranges.
- The raw observer notifier isolates failures so one observer does not block later observers or a queued native text
  commit.
- IME cursor geometry is applied before enabling IME.
- Viewport-to-page conversion rejects non-finite/out-of-bounds coordinates and includes viewport scroll; the guard needs
  a release/capture strategy rather than removal.
- `node_from_point()` explicitly resolves layout before a direct geometry query.

## Recommended remediation sequence

### 1. Define two separate public contracts

Decide whether Quox promises:

1. a DOM-compatible `EventTarget` surface; and
2. a custom raw/native input observation surface.

These are useful but different APIs. Keep the current broadcast observer only under a non-DOM name and document its
post-routing, non-cancelable semantics. Reserve `addEventListener(type, callback, options)` and JSX `onXxx` for
browser-compatible dispatch.

### 2. Replace the mailbox with staged, ordered event dispatch

Do not add more singular slots. Introduce a dispatch protocol containing:

- monotonically ordered event records;
- stable target handle and frozen path;
- event kind, `bubbles`, `cancelable`, and `composed` state as applicable;
- full event-specific payload;
- an internal trusted-event state—plain JavaScript `new Event(...)` objects have `isTrusted = false`;
- event-specific legacy pre-activation, canceled-activation rollback, and non-bubbling behavior;
- a dispatch-frame ID for reentrancy;
- cancellation/propagation/default-prevention feedback.

The safest WASM shape is likely staged:

1. Rust prepares the next event and returns, releasing mutable borrows.
2. JavaScript constructs the event and dispatches capture/target/bubble over the frozen path.
3. JavaScript returns cancellation and propagation results.
4. Rust applies or suppresses the default and makes the next generated event available.
5. Repeat until the dispatch frame is empty.

This permits author DOM mutations during handlers without re-entering a held Rust `RefCell` borrow. It also preserves
browser ordering and makes nested dispatch explicit.

### 3. Introduce stable node identity

Use generational handles or non-reused public IDs. Distinguish:

- detaching a live node, which must retain identity and listeners; from
- destroying descendants during replacement, which must invalidate handles safely.

Only then expose `Event.target`, `currentTarget`, listener registries, and retained detached nodes.

### 4. Implement the minimum live input DOM

Before calling the surface usable for data entry, add:

- live `value` and `checked`;
- selection offsets/direction;
- `activeElement`, `focus()`, and `blur()`;
- scroll positions;
- event-specific payloads;
- `beforeinput`, `input`, `change`, and composition events in browser order.

### 5. Extend the host-event contract, without mixing that work into DOM dispatch

The occurrence record needs:

- client coordinates on down/up/wheel;
- authoritative current `buttons`;
- physical modifier state;
- screen coordinates or an explicit unsupported status;
- fourth/fifth button support if promised;
- wheel delta plus unit/mode and transaction/phase identity;
- timestamp and enough pointer identity/cancel data for capture and interrupted streams.

This is the boundary at which cross-platform backend work will eventually be required. The DOM layer should define and
validate the contract now; backend implementation is outside this review.

### 6. Correct the Quox/Blitz adapter and upstream-dependent defaults

In priority order:

- negate wheel deltas at the current boundary, then redesign units;
- clear the released button before pointerup dispatch;
- enforce matching down/up and common-inclusive-ancestor click targeting;
- implement chorded pointer rules and `auxclick`;
- retain pointer modifiers;
- generate correct focus events for Tab/Shift+Tab and initial focus;
- add keyboard activation;
- correct checkbox/radio/change/label/disabled-control behavior;
- make viewport scroll produce the appropriate queued scroll event;
- implement or explicitly reject surrounding deletion.

Where Blitz cannot represent required values such as pointermove `button = -1`, change the upstream/binding type rather
than fabricating a DOM value.

### 7. Build a WPT-derived compatibility suite

Start with small, source-driven tests that do not require the currently broken WASM build pipeline, then run the same
cases through a browser reference harness when tooling is available.

High-value Web Platform Test areas:

- [pointerevents](https://github.com/web-platform-tests/wpt/tree/master/pointerevents), especially chorded buttons,
  different down/up targets, fractional coordinates, and click as `PointerEvent`;
- [uievents](https://github.com/web-platform-tests/wpt/tree/master/uievents), especially key values after modifier
  changes, focus order, mouse `buttons`, and wheel;
- [input-events](https://github.com/web-platform-tests/wpt/tree/master/input-events), especially `beforeinput`,
  composition, cancellation, `inputType`, and actual-change invariants;
- [CSSOM View](https://github.com/web-platform-tests/wpt/tree/master/css/cssom-view), especially scroll-event
  queuing/order and coordinate precision;
- HTML form-control activation tests for labels, disabled controls, checkbox/radio input/change order, and keyboard
  activation.

## Specific missing regression tests

Current tests should be extended to cover at least:

- released-button mask before `pointerUp`, including a throwing port;
- first/stationary click and wheel without a preceding move;
- per-occurrence down/up targets and down-A/up-B common-ancestor behavior;
- up without down;
- chorded mouse transitions;
- release outside, blur during drag, and pointer cancellation;
- Shift-click selection;
- text-child clicks reaching an ancestor handler;
- capture/target/bubble order and stop propagation;
- canceling link, checkbox, key edit, and wheel defaults;
- full callback payloads and `this/currentTarget`;
- callback exceptions followed by later listeners/events;
- nested dispatch without outer-event loss;
- multiple scroll records from nested scrollers;
- actual click/input/blur/focus/dblclick order;
- `innerHTML`/`textContent` ID reuse and retained detached-node identity;
- live input value, checkedness, selection, and active element;
- `beforeinput`/mutation/`input` and composition sequencing;
- no `input` when copy/delete/paste/radio activation makes no change;
- checkbox/radio `input` then `change`;
- label-generated control click and disabled-control suppression;
- Tab from no focus, Shift+Tab, and focus event order;
- Enter/Space activation and context-menu keyboard activation;
- logical key changes when Shift/layout changes while a key is held;
- wheel direction, pixel/line/page units, precision, transactions, cancellation, and viewport scroll;
- invalid/non-finite/wrapping FFI values;
- IME surrounding deletion and apply/ack retry behavior;
- core Preact `onDblClick`.

The existing tests currently hide or lock in several mismatches:

- `document_input_test.ts` checks only that a zero-argument input callback increments a counter.
- `mount_test.ts` verifies function-prop storage, not event delivery.
- `input_test.ts` explicitly asserts renderer dispatch occurs before the raw observer.
- The fake document renderer does not implement meaningful pointer-down/up/wheel behavior.
- Rust interaction tests exercise coordinate guards, key encoding/editor behavior, and basic IME, but no
  pointer/click/wheel/focus/mailbox semantics.

## Final conclusion

The current implementation is best described as a native input router plus a small, lossy JSX notification layer over
Blitz—not as a DOM input event implementation. It can support demos that count exact-target clicks or input
notifications, but it cannot provide browser-compatible event behavior because the JavaScript-visible phase occurs after
the information and cancellation point have been discarded.

The immediate correctness fixes—wheel sign, mouseup mask, validation, and stale state cleanup—are worthwhile, but they
will not make the interface compatible. The compatibility milestone should be defined around a new ordered,
synchronous-before-default dispatch protocol with stable node identity and complete payloads. Once that exists, pointer,
keyboard, editing, focus, wheel, scroll, and form-control behavior can be brought to parity incrementally and measured
against WPT-derived cases.
