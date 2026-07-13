# Darwin bindings review

Review date: 2026-07-10

Repository revision reviewed: `a48ca1647f006b6bda5c1a7373475c3588c92e9c`

## Scope and method

This review covers only:

- `packages/winding/darwin/*`;
- the cross-platform `winding` contracts that the Darwin backend implements; and
- Darwin-specific assumptions made by direct consumers of those contracts where they affect the backend's correctness.

Other platform backends were deliberately excluded. This was a static review on Linux. The Objective-C/AppKit
declarations were checked against Apple documentation, the carrier types against current Deno FFI documentation,
and—where Apple does not document raw hardware-key translation behavior in sufficient detail—Chromium's macOS
implementation and the W3C UI Events specifications. No Darwin binary could be loaded on this host, and `deno` is not
installed, so neither the pure tests nor the native smoke tests were executed here.

The findings below distinguish:

- **Confirmed mismatch**: the code directly contradicts a documented API declaration or invariant.
- **Confirmed implementation defect**: the error follows from the repository code without needing undocumented AppKit
  behavior.
- **High-confidence risk**: the implementation depends on a lifetime or ordering guarantee that the API does not
  provide.
- **Native-validation risk**: the code is suspicious, but its user-visible impact should be measured in a macOS test.

Severity means:

- **Critical**: a normal input can terminate or corrupt the process.
- **High**: common functionality can be lost, misreported, or made memory-unsafe.
- **Medium**: an important edge case, international input path, embedding scenario, or API contract is incorrect.
- **Low**: a narrow correctness/robustness issue or nominal ABI mismatch with no current calling-convention consequence.

## Executive summary

The low-level bindings are generally much better than the higher-level integration. Struct layouts, the
architecture-specific `objc_msgSend_stret` choice, Objective-C BOOL encodings, most selector signatures, CoreGraphics
declarations, and the basic ownership sequence for successful image creation are correct.

The implementation nevertheless has one critical defect and multiple high-severity defects:

1. `NSEvent.characters` is called for `NSEventTypeFlagsChanged`; Apple explicitly documents that this property raises
   `NSInternalInconsistencyException` for event types other than key-down and key-up. Pressing an ordinary modifier can
   therefore raise an Objective-C exception through a Deno FFI callback.
2. AppKit's main-thread requirement is acknowledged only in the smoke test and is not enforced in production.
3. `CGDataProvider` is given a pointer into JavaScript memory with no release callback, while JavaScript roots are
   retained for only two frames. Core Graphics and Core Animation do not promise that this is sufficient.
4. Ordinary mouse-move events are requested from the application queue, but the window is never configured to generate
   them.
5. The poller checks semantic callbacks produced by `sendEvent:` before it classifies the already-dequeued raw event.
   That ordering is structurally lossy if a content-eligible native event also queues a callback, although an ordinary
   click into an inactive window is not such proof: AppKit intentionally consumes that first click by default.
6. Raw pointer events are reconstructed after AppKit dispatch using only `event.window`, bypassing content hit-testing
   and potentially reporting title-bar, resize-border, and standard-window-control input as client input.
7. The `NSTextInputClient` implementation advertises ranges but ignores replacement ranges and cannot answer its range
   queries consistently.
8. `setTitle()` and `blit()` can send messages through released native pointers after `close()`.
9. `blit()` does not enforce the cross-platform size/buffer invariants and can leave native allocations unreleased on
   exceptions.
10. Multiple `DarwinLibrary` instances compete for the one process-wide `NSApplication` event queue and can permanently
    consume one another's pointer events.

The critical/high findings D-01 through D-04, D-06, D-07, D-09, and D-11 should be fixed and exercised before treating
the backend as production-safe. D-05, D-10, and D-32 should also be closed before accepting the event-ordering and
unchecked caller-input risks described below. Native coverage should include both Apple silicon and Intel macOS if Intel
remains supported.

## Finding index

| ID   | Severity | Confidence                                | Finding                                                                                    | Principal effect                                                                     |
| ---- | -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| D-01 | Critical | Confirmed API mismatch                    | `characters` is queried on `FlagsChanged` events                                           | Objective-C exception on modifier input; possible process termination                |
| D-02 | High     | Confirmed invariant gap                   | Production entry points do not enforce AppKit's main-thread rule                           | Unsupported UI/event work; correctness is not guaranteed from a worker               |
| D-03 | High     | High-confidence lifetime defect           | JavaScript pixel memory can outlive its roots through `CGDataProvider`/`CGImage`/`CALayer` | Use-after-free, corruption, or stale frame reads                                     |
| D-04 | High     | Confirmed configuration defect            | `acceptsMouseMovedEvents` is never enabled                                                 | Normal mouse motion is absent                                                        |
| D-05 | Medium   | Structural risk; trigger-dependent        | `event()` may return a callback event before classifying the current `NSEvent`             | A content-eligible event can be lost if its dispatch also queues a callback          |
| D-06 | High     | Confirmed routing defect                  | Raw pointer import bypasses AppKit content routing/hit-testing                             | Window chrome input is exposed as client input                                       |
| D-07 | High     | Confirmed API/contract mismatch           | `replacementRange` is ignored in both text mutation callbacks                              | IME replacement, reconversion, correction, and substitution are wrong                |
| D-08 | Medium   | Confirmed model inconsistency             | `NSTextInputClient` range/query methods disagree                                           | Exact selection/range geometry, reconversion, and text services are incomplete       |
| D-09 | High     | Confirmed lifecycle defect                | `setTitle()` and `blit()` operate after native teardown                                    | Message send through dangling pointers or closed FFI handles                         |
| D-10 | Medium   | Confirmed robustness/contract defect      | `blit()` does not validate dimensions, length, overflow, or clean up on throws             | Native rejection, leaks, and corrupt window geometry state after invalid input       |
| D-11 | High     | Confirmed architectural defect            | Multiple library instances consume one global `NSApplication` queue                        | Cross-instance event loss and error misattribution                                   |
| D-12 | Medium   | Confirmed cross-contract mismatch         | IME activation success is synthesized rather than observed                                 | False enabled/disabled state                                                         |
| D-13 | Medium   | Confirmed invalidation gap                | Candidate coordinates are not invalidated after move/resize/screen changes                 | Candidate window can remain at an old location                                       |
| D-14 | Medium   | Confirmed mapping defect                  | Native `buttonNumber == 2` is reported as right-click                                      | Middle-click is wrong                                                                |
| D-15 | Medium   | Confirmed declaration mismatches          | Two Objective-C methods use inaccurate fixed call shapes                                   | Lost activation failure; fragile object argument ABI                                 |
| D-16 | Medium   | Confirmed key-model gaps                  | JIS, ISO, Fn, Help, keypad Clear, dead-key, and normalization cases are incomplete         | Incorrect DOM-style key/code values, especially internationally                      |
| D-17 | Medium   | Confirmed option mismatch                 | Tracking is active only in the key window and omits drag-entry tracking                    | Inactive-window tracking and drag-entry timing are incomplete                        |
| D-18 | Medium   | Native-validation risk                    | The hand-rolled application loop lacks explicit update/autorelease discipline              | Delayed updates and retained autoreleased objects                                    |
| D-19 | Medium   | Documented integration risk               | Pixel content is written directly to a view-managed backing layer                          | AppKit may replace the layer's contents during a later view update                   |
| D-20 | Medium   | Confirmed exception-safety gap            | Constructors and late window setup do not roll back all side effects                       | Leaks and stale queued events after partial failure                                  |
| D-21 | Medium   | Confirmed process-global collision risk   | Dynamically registered classes use fixed names and partial registration is irreversible    | Failure across workers/module copies or after partial initialization                 |
| D-22 | Low      | Confirmed metadata mismatch               | The delegate object does not formally adopt `NSWindowDelegate`                             | Incorrect protocol conformance/introspection                                         |
| D-23 | Low      | Confirmed string edge case                | Title conversion uses NUL-terminated UTF-8                                                 | Embedded NUL truncates a title; allocation failure is unchecked                      |
| D-24 | Low      | Confirmed text edge cases                 | BOM decoding and event-key filtering alter valid committed text                            | Text and UTF-16 offsets can differ from the native string, or a commit can disappear |
| D-25 | Low      | Confirmed fallback gap                    | Unmatched key-up ignores the native logical-key fallback                                   | `Unidentified` after cache loss despite usable native data                           |
| D-26 | Low      | Contract ambiguity                        | Window `x`/`y` origin is not defined across the API boundary                               | Bottom-left AppKit coordinates may surprise callers expecting top-left               |
| D-27 | Medium   | Contract ambiguity/native behavior risk   | Scroll events use `deltaX`/`deltaY` and expose no delta-unit model                         | Inconsistent wheel speed and trackpad semantics                                      |
| D-28 | Low      | Optional hardening                        | Objective-C exceptions have no native catch/translation boundary                           | A remaining AppKit programmer exception can terminate the process                    |
| D-29 | Medium   | Confirmed cross-contract information loss | Button/wheel events discard native position and pointer modifiers/state                    | Clicks and wheels cannot be located reliably without a preceding move                |
| D-30 | Low      | Confirmed contract ambiguity              | RGBA pixels are tagged with a device-dependent color space                                 | Colors can vary across displays; sRGB producers are not represented exactly          |
| D-31 | Medium   | Confirmed cross-contract capability gap   | Rendering has no backing-scale/pixel-size model                                            | Retina windows can only receive point-resolution frames and are upscaled             |
| D-32 | Medium   | Confirmed validation/contract gap         | `openWindow` forwards arbitrary JavaScript numbers into `NSRect`                           | NaN/infinite/negative sizes can raise or poison later geometry/rendering             |

## Detailed findings

### D-01 — `FlagsChanged` queries a property that Apple says will throw

**Severity:** Critical<br> **Confidence:** Confirmed API mismatch

`DarwinWindow.handleFlagsChanged()` calls `#nativeKeyData(event)` at
[`packages/winding/darwin/mod.ts:566`](packages/winding/darwin/mod.ts#L566). That shared helper sends both `characters`
and `charactersIgnoringModifiers` at [`mod.ts:686`](packages/winding/darwin/mod.ts#L686).

Apple documents
[`NSEvent.characters`](https://developer.apple.com/documentation/appkit/nsevent/characters?changes=l_2&language=objc) as
valid only for key-down and key-up events and says that accessing it for any other event type raises
`NSInternalInconsistencyException`. `NSEventTypeFlagsChanged` is not a key-down or key-up event. Apple's archived
[Handling the Caps Lock Key](https://developer.apple.com/library/archive/qa/qa1519/_index.html) also demonstrates the
correct flags-changed data path: inspect `keyCode` and `modifierFlags`, not `characters`.

The JavaScript callback guards do not make this safe. An Objective-C exception raised inside `objc_msgSend` is not a
JavaScript exception and there is no Objective-C `@try/@catch` boundary around the FFI call. Letting such an exception
unwind across libffi/Deno frames is outside the supported contract and can terminate the process.

**Trigger:** press or release Shift, Control, Option, Command, Caps Lock, or Fn while the content view receives
`flagsChanged:`.

**Required fix:** split the native-key extraction paths. A flags-changed event must read only `keyCode` and
`modifierFlags`; derive the logical modifier key from the physical key code. Do not send either character selector for
this event type.

**Required test:** a native macOS subprocess test must synthesize or physically inject every modifier transition and
assert that the process survives and emits the expected press/release sequence. The test must include Caps Lock's
latching behavior and left/right modifier keys.

### D-02 — Main-thread-only AppKit access is not enforced

**Severity:** High<br> **Confidence:** Confirmed invariant gap

The native smoke test explicitly refuses to run away from the main thread at
[`packages/winding/darwin/native_smoke.ts:34`](packages/winding/darwin/native_smoke.ts#L34), but production `load()`,
the `DarwinLibrary` constructor, window creation, event dispatch, mutation, and teardown contain no equivalent guard.
Deno workers make it easy for a caller to import and invoke the backend on a non-main thread.

Apple's
[Threading Programming Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/ThreadSafetySummary/ThreadSafetySummary.html)
states that the main thread is responsible for event handling and that `NSView` and its descendants are
main-thread-only. Modern AppKit declarations, including
[`NSWindow`](https://developer.apple.com/documentation/appkit/nswindow), are also isolated to the main actor.

This is a backend invariant, not an optional caller optimization. AppKit may appear to work in a trivial worker test and
then fail in layout, event delivery, deallocation, or application lifecycle code.

**Required fix:** check the native main-thread state before creating `NSApplication` or any AppKit object and before
every public path if calls can cross threads. `pthread_main_np()` is a small direct binding; `[NSThread isMainThread]`
is another option. Fail synchronously with a precise error before performing any AppKit call.

**Required test:** import/load from a Deno worker and verify a deterministic backend error, not a crash or partial
native initialization.

### D-03 — The pixel-buffer lifetime is not tied to Core Graphics' ownership

**Severity:** High<br> **Confidence:** High-confidence lifetime defect

`blit()` makes a backend-owned JavaScript `Uint8Array` copy, passes its raw address to `CGDataProviderCreateWithData`,
and supplies a null release callback at [`packages/winding/darwin/mod.ts:719`](packages/winding/darwin/mod.ts#L719). The
window roots only `#imageBuf` and `#prevImageBuf`. The provider is released after `CGImageCreate`, but the image retains
the provider and the layer retains/animates its `contents`; neither API promises that two JavaScript generations span
the complete native use of the bytes.

Apple defines
[`CGDataProviderCreateWithData`](https://developer.apple.com/documentation/coregraphics/cgdataprovider/init%28datainfo%3Adata%3Asize%3Areleasedata%3A%29?language=objc)
around a
[`CGDataProviderReleaseDataCallback`](https://developer.apple.com/documentation/coregraphics/cgdataproviderreleasedatacallback?language=objc),
which is the point at which the provider says it is finished with client-owned storage.
[`CGImageCreate`](https://developer.apple.com/documentation/coregraphics/cgimage/init%28width%3Aheight%3Abitspercomponent%3Abitsperpixel%3Abytesperrow%3Aspace%3Abitmapinfo%3Aprovider%3Adecode%3Ashouldinterpolate%3Aintent%3A%29?language=objc)
retains its provider, and
[`CALayer.contents`](https://developer.apple.com/documentation/quartzcore/calayer/contents?language=objc) is a strong,
animatable property. A fixed “current plus previous” root is not equivalent to the release callback.

A concrete failing sequence exists even without a slow animation:

1. Frame A is installed in the layer.
2. Frame B creates a provider and image but throws before `setContents:`; the JavaScript roots become
   previous=A/current=B while the layer still holds A.
3. Frame C advances the two roots to B/C, although the layer may still own the image backed by A.
4. A can now be garbage-collected while native code still has its raw address.

The general case is also unsafe if Core Animation defers reading or rendering an older contents value for longer than
one call.

**Required fix:** either create the provider from copied immutable data (for example an owned `CFData`) or provide a
native release callback and keep an explicit JavaScript/native allocation registry until that exact callback fires.
Rooting by a guessed number of frames is not sufficient.

**Required tests:** force GC between every blit, introduce failures at every allocation and `setContents:` boundary,
rapidly alternate frame buffers, and inspect under Guard Malloc/Instruments while verifying displayed pixels.

### D-04 — Ordinary mouse-move delivery is never enabled

**Severity:** High<br> **Confidence:** Confirmed configuration defect

The library recognizes `NSEventTypeMouseMoved` in the event import path at
[`packages/winding/darwin/mod.ts:966`](packages/winding/darwin/mod.ts#L966), but it never sets
`NSWindow.acceptsMouseMovedEvents`. Apple documents
[`acceptsMouseMovedEvents`](https://developer.apple.com/documentation/appkit/nswindow/acceptsmousemovedevents?language=objc)
as the window switch for mouse-moved events; its default is false. Apple's
[Mouse-Event Handling Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingMouseEvents/HandlingMouseEvents.html)
makes the same distinction between moved and dragged events.

The installed tracking area requests only enter/exit, so it does not independently request normal move events. In
practice, drag events may work while unpressed pointer motion never reaches the queue.

**Required fix:** set `acceptsMouseMovedEvents = YES` on each created window, or route `mouseMoved:` through a tracking
area/view implementation that explicitly includes mouse-moved tracking. Restore any prior value only if embedding in an
externally owned window is later supported.

**Required test:** move the pointer within a key window without pressing a button and assert continuous `mousemove`
delivery. Separately test a non-key window while the application remains active and define whether the cross-platform
contract expects motion there; background applications normally do not receive ordinary mouse events.

### D-05 — Callback-first polling can lose a content-eligible native event

**Severity:** Medium<br> **Confidence:** Structural ordering risk; a current content-eligible trigger requires native
validation

The polling loop dequeues one `NSEvent`, calls `[NSApp sendEvent:event]`, checks the semantic callback queue, and can
return from that queue before it classifies or imports the dequeued event itself at
[`packages/winding/darwin/mod.ts:838`](packages/winding/darwin/mod.ts#L838). The native event is not retained for the
next poll. Therefore, if a content-eligible event synchronously queues a focus/resize/IME callback, returning that
callback can permanently discard the causative event.

An inactive-window mouse-down does exercise this ordering branch, but it is not by itself a confirmed lost client event.
Apple documents that
[`NSView.acceptsFirstMouse(for:)`](https://developer.apple.com/documentation/appkit/nsview/acceptsfirstmouse%28for%3A%29)
returns false by default, and its
[mouse-event guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingMouseEvents/HandlingMouseEvents.html)
says the first mouse-down normally makes the window key without being dispatched to the view. Under that default, the
correct public result is focus without mouse-down; the current raw importer would be wrong to expose the click at all,
as discussed in D-06.

If Winding intentionally wants click-through into inactive content, `WindingContentView` must override
`acceptsFirstMouse:` to return `YES`. In that policy, focus and the content mouse-down both become meaningful and the
poller must preserve their documented order. The same preservation rule applies to any active-window content event that
native testing proves can synchronously enqueue a semantic callback. The current control flow cannot do so reliably
because it returns before deciding whether the raw event belongs to content.

The shared `EventQueue` even has a `prepend()` operation, documented for placing a causative event ahead of events
generated while processing it, at
[`packages/winding/input/event_queue.ts:26`](packages/winding/input/event_queue.ts#L26). The Darwin loop does not use
it.

**Required fix:** route pointer events through the content responder as required by D-06 and never return from callback
dispatch before classifying the current event's content eligibility. Explicitly choose whether inactive content supports
click-through. If it does, override `acceptsFirstMouse:`, retain both the eligible causative event and synchronous
consequences, and define their order. The existing queue API suggests prepending the causative event, but that helper
comment is not itself a public ordering contract.

**Required tests:** with AppKit's default `acceptsFirstMouse:` behavior, click inactive content and assert focus only,
with no client mouse-down. If Winding adopts click-through, assert focus plus one mouse-down in the documented order.
Also test an active-window content event that synchronously produces a callback, and verify that close/title/resize
chrome never becomes a client pointer event.

### D-06 — Pointer events are reconstructed without content hit-testing

**Severity:** High<br> **Confidence:** Confirmed routing defect

After calling `sendEvent:`, the library identifies a window using only `[event window]` and independently converts
mouse, drag, and scroll events at [`packages/winding/darwin/mod.ts:943`](packages/winding/darwin/mod.ts#L943). This
ignores whether AppKit dispatched the event to the content view, a title bar, a resize border, a close/minimize/zoom
control, or another native responder.

Apple's
[event handling model](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingMouseEvents/HandlingMouseEvents.html)
routes mouse events through window/view hit-testing and the responder chain.
[`NSApplication.sendEvent:`](https://developer.apple.com/documentation/appkit/nsapplication/sendevent%28_%3A%29)
performs that dispatch. Re-importing the same event based solely on its window bypasses the result of that routing.

Consequences include:

- title-bar clicks and title dragging exposed as client mouse input;
- standard close/minimize/zoom button input exposed as client input;
- resize-border drags reported with coordinates outside the client area;
- wheel events over window chrome reported to the application; and
- inconsistent drag capture because AppKit and the manual importer can disagree about the target.

**Required fix:** implement `mouseDown:`, `mouseUp:`, `mouseMoved:`, drag, and `scrollWheel:` on `WindingContentView`
and queue events only when AppKit routes them there. An alternative is an explicit hit-test/coordinate-conversion
implementation that faithfully reproduces content routing and capture, but view callbacks are less fragile.

**Required tests:** exercise all title-bar controls, title dragging, every resize edge, client content, wheel over
chrome/content, and a drag that starts in content and leaves the window.

### D-07 — Both text mutation callbacks discard `replacementRange`

**Severity:** High<br> **Confidence:** Confirmed API and cross-contract mismatch

The Objective-C callbacks for `insertText:replacementRange:` and `setMarkedText:selectedRange:replacementRange:` decode
the text but ignore their replacement-range argument at
[`packages/winding/darwin/native_classes.ts:228`](packages/winding/darwin/native_classes.ts#L228) and
[`native_classes.ts:237`](packages/winding/darwin/native_classes.ts#L237). The callbacks then reduce every operation to
“commit this text” or “replace the entire current marked string.”

That is not what the selectors mean, and the two ranges do not share one coordinate convention:

- Apple's
  [`insertText:replacementRange:`](https://developer.apple.com/documentation/appkit/nstextinputclient/inserttext%28_%3Areplacementrange%3A%29?changes=la&language=objc)
  defines `replacementRange` in the receiver's text storage.
- [`setMarkedText:selectedRange:replacementRange:`](https://developer.apple.com/documentation/appkit/nstextinputclient/setmarkedtext%28_%3Aselectedrange%3Areplacementrange%3A%29)
  defines `selectedRange` from the start of the newly inserted string and `replacementRange` from the start of the
  existing marked text. With no marked text it replaces the current selection, or inserts at the insertion point when
  there is no selection.

InputMethodKit's
[`replacementRange`](https://developer.apple.com/documentation/inputmethodkit/imkinputcontroller/replacementrange%28%29)
documents its default `{NSNotFound, NSNotFound}` result as “place marked text at the current insertion point.” That
convention should be handled explicitly where it arrives; it should not be generalized into one document-range rule for
both client selectors. Concrete ranges must not be silently discarded.

Affected operations include:

- IME reconversion of existing text;
- autocorrection and substitutions;
- replacement of a selected range;
- partial replacement of marked text; and
- input methods that update only a subrange of the composition.

The cross-platform event model already has `deleteSurrounding` and ordered text events, but it does not expose a
complete document snapshot or a setter for an arbitrary absolute selection. Therefore this is partly a backend bug and
partly an interface-capability gap: the Darwin backend cannot faithfully implement every legal AppKit replacement
request from the information currently available.

**Required fix:** carry both native ranges into `DarwinInputState`, preserve each selector's coordinate space, maintain
a coherent document/marked-text/selection model, and translate representable replacements into ordered
delete/preedit/commit events. If document-storage replacement cannot be represented, extend the cross-platform backend
contract rather than silently treating it as insertion. Document how each UTF-16 `NSRange` maps to marked text and
cross-platform string operations.

**Required tests:** use Japanese, Korean, and Chinese input methods plus macOS text replacement/autocorrection. Cover
concrete replacement ranges, `NSNotFound`, a selected range, partial marked-text replacement, surrogate pairs, and
combining sequences.

### D-08 — The `NSTextInputClient` query model is internally inconsistent

**Severity:** Medium<br> **Confidence:** Confirmed implementation defect

The registered selectors and their Objective-C encodings are correct, but their answers do not describe one coherent
text client:

- `hasMarkedText` and `markedRange` report marked state, with `markedRange` represented as `{0, markedUTF16Length}`, at
  [`packages/winding/darwin/input_state.ts:92`](packages/winding/darwin/input_state.ts#L92).
- The selected range received with marked text is stored at
  [`input_state.ts:180`](packages/winding/darwin/input_state.ts#L180), but the responder's
  [`selectedRange` getter](packages/winding/darwin/input_state.ts#L98) always returns `{NSNotFound, 0}`; the Objective-C
  callback forwards that value at [`native_classes.ts:287`](packages/winding/darwin/native_classes.ts#L287).
- `attributedSubstringForProposedRange:actualRange:` always returns `nil` and reports no actual range at
  [`native_classes.ts:309`](packages/winding/darwin/native_classes.ts#L309), so surrounding/marked text is never
  available to text services.
- `characterIndexForPoint:` always returns `NSNotFound` at
  [`native_classes.ts:326`](packages/winding/darwin/native_classes.ts#L326), so character hit-testing is unsupported.
- `firstRectForCharacterRange:actualRange:` ignores the requested range, always returns the cursor rectangle, and always
  writes `{NSNotFound, 0}` to `actualRange` at
  [`native_classes.ts:329`](packages/winding/darwin/native_classes.ts#L329).

Apple defines these as a coordinated protocol in
[`NSTextInputClient`](https://developer.apple.com/documentation/AppKit/NSTextInputClient). In particular,
[`selectedRange`](https://developer.apple.com/documentation/appkit/nstextinputclient/selectedrange%28%29?language=objc),
[`markedRange`](https://developer.apple.com/documentation/appkit/nstextinputclient/markedrange%28%29),
[`attributedSubstringForProposedRange:actualRange:`](https://developer.apple.com/documentation/appkit/nstextinputclient/1438238-attributedsubstring),
and
[`firstRectForCharacterRange:actualRange:`](https://developer.apple.com/documentation/appkit/nstextinputclient/firstrect%28forcharacterrange%3Aactualrange%3A%29)
all operate in the client's document-wide UTF-16 coordinate space. A zero-length character range must produce a
zero-width insertion rectangle; an arbitrary nonzero range cannot always use the same cursor rectangle.

Apple explicitly permits the attributed-substring method to return `nil`, and `characterIndexForPoint:` can legitimately
return `NSNotFound` when no character bounds contain a point. Those constant answers are feature incompleteness, not
standalone protocol contradictions. The hard contradiction is that the client claims marked text at a concrete range and
stores a selected subrange while `selectedRange` always says there is no selection. Separately, `firstRect...` does not
honor its range/`actualRange` contract. Its returned screen rectangle is still a useful best-effort candidate anchor—the
smoke test exercises that conversion—but it cannot provide exact range geometry, reconversion geometry, or the required
zero-width insertion rectangle.

**Required fix:** introduce one UTF-16 document/selection model and make every callback answer from it. At minimum,
return the stored selection in the same coordinate space as `markedRange` and honor requested/`actualRange` plus
zero-width caret semantics in `firstRect...`. Supporting substring and point queries would materially improve text
services/reconversion but requires surrounding text and character geometry from the application, which likely means
extending the cross-platform interface.

**Required tests:** add a native conformance harness that calls every protocol method after each composition transition
and asserts mutual consistency, including emoji, combining marks, partial ranges, out-of-range queries, and
reconversion.

### D-09 — Two public methods use released native objects after close

**Severity:** High<br> **Confidence:** Confirmed lifecycle defect

`DarwinWindow.close()` releases the native window, content view, and delegate at
[`packages/winding/darwin/mod.ts:753`](packages/winding/darwin/mod.ts#L753), ending the validity of the layer borrowed
from that view as well. `setTitle()` and `blit()` do not check `#closed` before sending Objective-C messages through
those stored addresses at [`mod.ts:712`](packages/winding/darwin/mod.ts#L712) and
[`mod.ts:719`](packages/winding/darwin/mod.ts#L719).

If the `DarwinLibrary` remains open, this is a message send to dangling Objective-C pointers. If the library has also
closed, it additionally calls closed Deno dynamic-library handles. Whether the address happens to still contain a live
object is allocator-dependent; enabling zombies will make the defect deterministic.

Current [Deno FFI documentation](https://docs.deno.com/api/deno/ffi/) explicitly warns that continuing to use symbols
after `DynamicLibrary.close()` leads to errors and crashes.

Other methods have a mix of no-op or guarded behavior after close, so callers cannot infer one consistent lifecycle
rule.

**Required fix:** centralize an `assertOpen()` check covering both the window and owning library and call it before
every native method, or define all post-close operations as safe no-ops and implement that consistently. Throwing a
deterministic JavaScript error is preferable because it exposes caller bugs. Zero native pointers during teardown as a
secondary defense.

**Required tests:** call every window method after `window.close()` and again after `library.close()`, with
NSZombieEnabled in the native test environment.

### D-10 — `blit()` violates its public preconditions and is not exception-safe

**Severity:** Medium<br> **Confidence:** Confirmed contract/robustness defect; malformed-provider outcome needs native
validation

The cross-platform contract requires the RGBA buffer to exactly match the window's client size at
[`packages/winding/types.ts:147`](packages/winding/types.ts#L147). The Darwin implementation performs no relevant
validation before handing the pointer to Core Graphics:

- width and height need not be finite safe integers, and there is no explicit zero-size policy before Core Graphics'
  positive-size path;
- `width * 4` and `width * height * 4` are not checked for JavaScript precision loss or native-size overflow;
- `rgba.byteLength` need not equal the required byte count; and
- the submitted dimensions need not match the actual content-view dimensions.

A short buffer does **not** make the provider claim more bytes than the JavaScript allocation:
`CGDataProviderCreateWithData` correctly receives `buf.byteLength`. Instead, it creates a provider whose available
length is inconsistent with the `bytesPerRow * height` geometry later supplied to `CGImageCreate`. That violates the
image-creation precondition; Apple does not document whether every malformed combination is rejected immediately or how
a lazily consumed short provider behaves, so an out-of-allocation read should not be asserted without a native test.
Fractional, `NaN`, or infinite dimensions can independently throw during `BigInt(...)` conversion after a provider has
been created.

The method then overwrites `#width` and `#height` with the image dimensions even though it did not resize the
`NSWindow`. Mouse Y conversion and later reported geometry now use framebuffer dimensions instead of actual client
dimensions.

The allocation sequence lacks `try/finally`. A throw after provider creation leaks the provider; a throw after image
creation but before the explicit release leaks both retained native state and can create the D-03 rooting sequence.
Closing a window also leaves the current and previous full-size frame buffers rooted for as long as the closed
JavaScript object is retained.

**Required fix:** before FFI:

1. require finite safe-integer dimensions and explicitly reject or no-op zero size (the `CGImageCreate` path itself
   needs positive dimensions);
2. checked-multiply row bytes and total bytes within `size_t` and JavaScript's exact integer range;
3. require exact buffer length;
4. require dimensions to equal the authoritative client size (with an explicitly documented scale policy); and
5. never update window geometry as a side effect of drawing.

Wrap provider/image ownership in `try/finally`, install new JavaScript/native frame state only after `setContents:`
succeeds, and clear retained buffers during close. Resolve D-03 with callback-tied or copied storage rather than
preserving the two-buffer workaround.

**Required tests:** every invalid dimension/length combination, maximal checked values, deliberate exceptions after each
native allocation, resize-then-blit, blit-then-mouse-coordinate checks, close after a large frame, and aggressive GC.

### D-11 — Independent libraries race on one process-global application queue

**Severity:** High<br> **Confidence:** Confirmed architectural defect

Every `DarwinLibrary` obtains the same singleton `NSApplication`, but each instance owns a private `#windows` map and
polls the process-wide native event queue at [`packages/winding/darwin/mod.ts:798`](packages/winding/darwin/mod.ts#L798)
and [`mod.ts:838`](packages/winding/darwin/mod.ts#L838). Apple exposes
[`NSApplication`](https://developer.apple.com/documentation/appkit/nsapplication) as the shared application object;
there is not one AppKit event queue per backend instance.

If library A polls an event belonging to a window created by library B, A removes it from the native queue. B's
content-view callback may still enqueue some semantic keyboard/focus events into B, but A cannot find B's window when
doing raw mouse/wheel import, so those events are dropped forever. The native-class singleton also has one shared
deferred callback-error slot, allowing a callback failure caused by one library to be thrown from another library's
`event()` call.

Each construction also mutates application-global state by setting activation policy and calling `finishLaunching`.
Apple describes
[`finishLaunching`](https://developer.apple.com/documentation/appkit/nsapplication/finishlaunching%28%29) as the work
normally performed once by `run`. Repeating it, or doing it inside an already-running host application, is not an
instance-local operation.

**Required fix:** enforce one process-wide/ref-counted Darwin backend, including one event demultiplexer and
callback-error router, or make all instances facades over a single global native state that dispatches by native window
pointer. Treat activation policy and launch state as a one-time application-level transition and detect an
already-hosted `NSApplication` explicitly.

**Required tests:** create two libraries concurrently, alternate polling, send mouse/keyboard/focus/close events to
both, and verify no loss or cross-instance exception. Also test load/close/load and embedding after an application has
already finished launching.

### D-12 — IME activation success is synthetic

**Severity:** Medium<br> **Confidence:** Confirmed cross-contract mismatch

The shared `ImeActivationActions` contract says `activate()` returns true only if native activation succeeded at
[`packages/winding/input/activation.ts:3`](packages/winding/input/activation.ts#L3). The Darwin backend marks native
availability true unconditionally and supplies an activation action that simply returns true while deactivation does
nothing at [`packages/winding/darwin/input_state.ts:64`](packages/winding/darwin/input_state.ts#L64) and
[`input_state.ts:276`](packages/winding/darwin/input_state.ts#L276).

AppKit does not offer the synchronous success/failure action this abstraction assumes. Apple documents
[`NSTextInputContext.activate`](https://developer.apple.com/documentation/appkit/nstextinputcontext/activate%28%29?changes=_4&language=objc)
as a void system-invoked override point and explicitly says clients must not call it directly; `deactivate` follows the
same system-managed lifecycle. A context normally becomes active because its client view is first responder in the key
window.
[`NSTextInputContext.currentInputContext`](https://developer.apple.com/documentation/appkit/nstextinputcontext/current)
and the context's [`client`](https://developer.apple.com/documentation/appkit/nstextinputcontext/client?language=_7)
expose the observed state.

It is therefore correct that the backend does not send `activate`/`deactivate` itself. The defect is that it reports
synthetic success without checking the system-managed context or client. It can emit enabled when no context is current
for the view and emit disabled while the view's context remains current. The public README promises that events follow
“actual activation,” so the current synchronous action contract and Darwin's claimed state disagree.

**Required fix:** do **not** call `activate` or `deactivate` directly. Treat key-window/first-responder transitions as
the driver, observe the current input context and verify its client, then use the externally observed `markActive` path.
If “IME enabled” is intended to mean only that Winding will route keys through `interpretKeyEvents:`—rather than that
AppKit activated/deactivated a context—rename/redefine the shared state and README accordingly. A request to suppress
native composition while retaining keyboard first-responder status needs a documented client/input-context policy, not a
call to the forbidden override points.

**Required tests:** toggle desired IME permission while focused/unfocused, before/after `makeFirstResponder:`, when
activation becomes current asynchronously, during key-window changes and close, and when the current context is nil or
belongs to a different client.

### D-13 — Candidate-coordinate invalidation misses geometry changes

**Severity:** Medium<br> **Confidence:** Confirmed invalidation gap

The backend calls
[`invalidateCharacterCoordinates`](https://developer.apple.com/documentation/appkit/nstextinputcontext/invalidatecharactercoordinates%28%29)
only when `setImeCursorArea()` changes the client-local rectangle at
[`packages/winding/darwin/mod.ts:655`](packages/winding/darwin/mod.ts#L655). The screen-space result returned by
`firstRectForCharacterRange:` definitely changes when the window moves and can change when it resizes, changes screen,
or changes its view transform. None of those paths invalidates the text input context; there is no
[`windowDidMove:`](https://developer.apple.com/documentation/appkit/nswindowdelegate/windowdidmove%28_%3A%29) callback,
and the explicit resize path does not invalidate either. A backing-scale change by itself may leave the point-space
screen rectangle unchanged, so it requires invalidation only when the logical/view mapping or reported rectangle
changes.

Candidate panels and input-method UI may therefore stay at their previous screen position until the application happens
to set a different cursor rectangle.

**Required fix:** invalidate after programmatic and delegate-driven move/resize, screen or backing-property changes that
alter reported geometry, and any content-view transform/bounds change. Convert the view-local rectangle through the view
to window coordinates before converting to screen coordinates, rather than relying permanently on the current
fill-the-content-view invariant.

**Required test:** keep an IME candidate window open while moving and resizing across differently scaled displays and
verify its anchor after each change.

### D-14 — Native middle-click is reported as right-click

**Severity:** Medium<br> **Confidence:** Confirmed mapping defect

The raw mapping indexes `BUTTONS` using `buttonNumber + 1`, while the table is `[undefined, "left", "middle", "right"]`
at [`packages/winding/darwin/mod.ts:784`](packages/winding/darwin/mod.ts#L784). The event-type branches correctly
special-case left and right. The `OtherMouse*` path begins with native button 2—the ordinary middle/third button—but
indexes slot 3 and returns `"right"`; higher extra buttons fall out of the table.

Apple's
[`pressedMouseButtons`](https://developer.apple.com/documentation/appkit/nsevent/pressedmousebuttons?language=objc)
documentation establishes index/bit 0 as left, 1 as right, and 2 or greater as other buttons. Treating the ordinary
third button (2) as middle is the platform convention; buttons beyond that need an explicit cross-platform policy.

The cross-platform type supports only left/middle/right, so extra side buttons need an explicit policy rather than
accidental array fall-through.

**Required fix:** map event type and `buttonNumber` explicitly: 0 left, 1 right, 2 middle; reject or deliberately extend
the public type for values >=3.

**Required test:** left/right/middle and at least two side buttons for down, up, and drag.

### D-15 — Two fixed Objective-C call shapes are not the declared signatures

**Severity:** Medium<br> **Confidence:** Confirmed declaration mismatches; the sender call shape requires native ABI
proof

Most `objc_msgSend` specializations in `openMsgSend()` match their declarations. Two do not:

1. [`NSApplication.setActivationPolicy:`](https://developer.apple.com/documentation/appkit/nsapplication/setactivationpolicy%28_%3A%29)
   takes an `NSApplicationActivationPolicy` (`NSInteger`, correctly passed as 64-bit here) but returns `BOOL`. The call
   uses a `void_i64` shape at [`packages/winding/darwin/mod.ts:803`](packages/winding/darwin/mod.ts#L803), discarding
   the result. Ignoring the machine return register is not a calling-convention corruption, but it prevents detection of
   a documented failure and can let later focus/activation assumptions proceed incorrectly.
2. [`NSWindow.makeKeyAndOrderFront:`](https://developer.apple.com/documentation/appkit/nswindow/makekeyandorderfront%28_%3A%29?language=objc)
   takes an Objective-C `id` sender. The code uses `void_bool` and passes `false` at
   [`mod.ts:338`](packages/winding/darwin/mod.ts#L338). A one-byte false value is not an ABI guarantee of a 64-bit null
   object argument: the upper argument-register bits can be unspecified, and the callee consumes the full pointer.
   Deno/libffi may zero-extend in current builds, but that requires native proof and is not a valid fixed signature.
   Passing true would at best produce the invalid object address `0x1`.

The code also calls deprecated
[`activateIgnoringOtherApps:`](https://developer.apple.com/documentation/appkit/nsapplication/activate%28ignoringotherapps%3A%29?language=objc).
Apple's
[macOS 14 AppKit release notes](https://developer.apple.com/documentation/macos-release-notes/appkit-release-notes-for-macos-14)
deprecate it. The backend already observes actual key-window status through `windowDidBecomeKey:`, which is the correct
source of focus state; the remaining concern is policy. Every `openWindow()` makes a foreground request unconditionally,
so a background tool can request focus merely by constructing a window, and the cross-platform API provides no
activation/focus policy switch.

**Required fix:** add a BOOL-returning `i64` call shape for activation policy and handle false; use the existing
object-argument shape with `null` for `makeKeyAndOrderFront:`; select the modern activation API when available and treat
delegate/key-window notification as the state transition.

**Required test:** assert exact signatures in the native ABI smoke test and exercise activation when policy changes are
denied or when another application is foreground.

### D-16 — DOM-style keyboard translation is incomplete on international and special keys

**Severity:** Medium<br> **Confidence:** Confirmed mapping gaps

The physical-code table and logical-key resolver handle the common ANSI path, but several AppKit-to-UI-Events cases are
missing or ordered incorrectly:

- Japanese JIS Eisu and Kana have physical codes `Lang2` and `Lang1`, but their logical keys need key-code-specific
  values (`Eisu`/`KanjiMode` in the model used by Chromium). Relying on `characters` can turn them into a space or
  unrelated text.
- Fn's native key code (`0x3f` when exposed as a key transition) has no explicit logical mapping.
- keypad Clear is physically represented by the numpad-clear position but logically differs from `NumLock` on macOS.
- Help (`0x72`) shares a physical position commonly labeled Insert but needs the logical key `Help`.
- macOS swaps the raw positions for Backquote and IntlBackslash on ISO hardware; a fixed table without keyboard-type
  handling reports the wrong `code`.
- the resolver accepts arbitrary multi-base strings from `characters`/produced text and does not normalize to NFC. The
  W3C key-value model permits zero or one non-control base character followed by combining characters, normalized to
  NFC—not arbitrary text.
- printable native characters are checked before `producedPreedit`. Some dead-key paths can therefore be reported as a
  printable accent, but simply reversing that precedence would also be wrong: ordinary IME preedit keys can have both
  printable characters and marked text.
- invalid dead-key sequences can yield more than one character; returning that entire string as one key value violates
  the single-key-value rule.
- the Darwin path uses `PressedLogicalKeyCache` to freeze the initial logical value for every repeat and release. UI
  Events resolves `key` from the modifier/layout state at each event, so holding a printable key while releasing Shift
  or changing layout can leave repeat/key-up values stale even though the current `NSEvent` was decoded.

These are not theoretical oddities. Chromium has explicit macOS cases for Fn, Help, Eisu, Kana/Kanji, keypad Clear, and
the ISO positional swap in its
[macOS key conversion implementation](https://chromium.googlesource.com/chromium/src/+/caaf97fa6dcf36324dd0742c4fe3cb78f25bd3bc/ui/events/keycodes/keyboard_code_conversion_mac.mm).
It also has an application-level
[JIS workaround](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/chrome_browser_application_mac.mm)
because AppKit can consume those key-downs during input-method processing. The required output semantics are defined by
[UI Events KeyboardEvent key Values](https://www.w3.org/TR/uievents-key/) and
[UI Events KeyboardEvent code Values](https://www.w3.org/TR/uievents-code/).

**Required fix:** make logical special-key resolution key-code-aware before printable-character fallback, query the
native keyboard type for ISO positional correction, and distinguish native layout/dead-key state rather than treating
all preedit as a dead key. Apple explicitly discourages legacy
[`UCKeyTranslate`](https://developer.apple.com/documentation/coreservices/1390584-uckeytranslate) for ordinary event
translation and recommends `NSEvent.characters(byApplyingModifiers:)`; prefer that modern API, using a legacy layout
call only if justified by dead-key or keyboard-type state the modern method cannot expose. Normalize valid character
keys to NFC and reject/resolve multi-base output according to the UI Events algorithm. Recompute logical `key` per
native repeat/release while retaining only the physical pairing needed for recovery. Decide and document how
AppKit-consumed JIS keys are surfaced without duplicating IME text callbacks.

**Required tests:** ANSI, ISO, and JIS keyboards; Eisu, Kana, Fn, Help, keypad Clear, Backquote/IntlBackslash, every
dead-key composition and invalid dead-key recovery, emoji, decomposed accents, ordinary repeat, and repeat/release after
changing Shift or layout while a key remains held.

### D-17 — Tracking-area options conflict with the public enter/leave semantics

**Severity:** Medium<br> **Confidence:** Confirmed option mismatch

The content view creates a tracking area for enter/exit with `NSTrackingActiveInKeyWindow` at
[`packages/winding/darwin/mod.ts:65`](packages/winding/darwin/mod.ts#L65) and
[`mod.ts:318`](packages/winding/darwin/mod.ts#L318). Apple's
[`NSTrackingArea.Options`](https://developer.apple.com/documentation/appkit/nstrackingarea/options) and
[`NSTrackingActiveInKeyWindow`](https://developer.apple.com/documentation/appkit/nstrackingareaoptions/nstrackingactiveinkeywindow)
definitions mean tracking is inactive when the window is not key. The options also omit “enabled during mouse drag.”

The cross-platform event type describes entering/leaving the window, not “entering/leaving only while focused.” Thus an
inactive visible window can receive no boundary events. Without `NSTrackingEnabledDuringMouseDrag`, entering a tracking
area while dragging is normally deferred or suppressed until mouse-up; this does not mean all drag-time tracking
disappears, because an exit following an earlier enter can still be delivered. This asymmetry complicates
application-side hover state after focus changes and drags.

**Required fix:** choose `ActiveInActiveApp` or `ActiveAlways` according to the intended application lifecycle and
include drag tracking if enter/leave is expected while a button is held. If focus-qualified tracking is intentional,
change the public contract to say so.

**Required test:** cross the client boundary while the window is key, non-key in an active app, and in an inactive app.
During a drag, separately test entering from outside and exiting after an earlier enter, both with and without the
enabled-during-drag option.

### D-18 — The custom application loop lacks explicit update and autorelease ownership

**Severity:** Medium<br> **Confidence:** Native-validation risk with confirmed ownership gaps

The backend implements a nonblocking loop with `nextEventMatchingMask:untilDate:inMode:dequeue:` and `sendEvent:` at
[`packages/winding/darwin/mod.ts:838`](packages/winding/darwin/mod.ts#L838), but does not run `NSApplication.run` and
does not call [`updateWindows`](https://developer.apple.com/documentation/appkit/nsapplication/updatewindows%28%29).
Apple's
[application event-loop description](https://developer.apple.com/library/archive/documentation/General/Conceptual/MOSXAppProgrammingGuide/CoreAppDesign/CoreAppDesign.html)
includes periodic window updating as part of normal application-loop work. Core Animation may still commit through its
transaction machinery, so the exact visible failure needs native testing, but the implementation should not assume
`sendEvent:` alone reproduces all `run` behavior.

Only `event()` creates a per-poll autorelease pool. `load()`, class/application construction, window construction, title
mutation, resizing, drawing, and close all invoke Cocoa without a backend-owned pool. The smoke test wraps its entire
body in an outer pool at [`packages/winding/darwin/native_smoke.ts:377`](packages/winding/darwin/native_smoke.ts#L377),
hiding this production difference. Apple's
[Advanced Memory Management Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmAutoreleasePools.html)
requires an autorelease pool in code paths that use Cocoa outside a framework-managed event loop.

The library also stores the borrowed result of `[NSDate distantPast]` across per-event pool drains. Under Cocoa's
[ownership policy](https://developer.apple.com/library/archive/documentation/General/Conceptual/DevPedia-CocoaCore/MemoryManagement.html),
a returned object that must survive the current scope needs to be retained. `distantPast` is likely process-lifetime in
current Foundation implementations, but the API contract does not give this code ownership.

Finally, the ostensibly nonblocking poll has no dispatch budget: it loops past every native event that produces no
Winding event. A continuous stream of ignored AppKit/gesture/tablet events can keep one `event()` call inside the pump
indefinitely. That is an edge rather than a proven common failure, but the public polling semantics should define a
per-call bound.

**Required fix:** establish a deliberate pool policy for every public native operation (short nested pools are safest),
retain/release stored Foundation objects, and reproduce the necessary window-update/transaction work of the standard
application loop. Verify whether an explicit Core Animation transaction/flush is needed rather than adding it
speculatively.

**Required tests:** long-running creation/title/resize/blit loops with autorelease high-water measurements,
pixel-visible update timing without unrelated events, occlude/unocclude, minimize/restore, window-server
synchronization, and a sustained stream of ignored native event types.

### D-19 — Directly assigning the view-managed backing layer's contents is fragile

**Severity:** Medium<br> **Confidence:** Documented integration risk

Window creation sets `wantsLayer = YES`, obtains `[view layer]`, and `blit()` assigns the image directly to that layer's
`contents` at [`packages/winding/darwin/mod.ts:311`](packages/winding/darwin/mod.ts#L311) and
[`mod.ts:743`](packages/winding/darwin/mod.ts#L743). Apple's
[`NSView.wantsLayer`](https://developer.apple.com/documentation/appkit/nsview/1483695-wantslayer?changes=_6_8)
documentation says that when the default `wantsUpdateLayer` is false, code should not interact directly with the
AppKit-created underlying layer.
[`wantsUpdateLayer`](https://developer.apple.com/documentation/appkit/nsview/wantsupdatelayer?changes=_6) describes the
supported layer-mutation path: override it to true and perform changes in `updateLayer()` during the view update cycle.

The current native smoke test does not call `blit()` or inspect `CALayer.contents`, so even immediate assignment is not
covered, much less persistence through a subsequent AppKit update, resize, backing-scale transition, occlusion, or
redisplay.

**Required fix:** use an AppKit-supported rendering arrangement: override `wantsUpdateLayer`/`updateLayer` and treat the
image as view state, or deliberately configure a layer-hosting view that AppKit leaves alone. A dedicated backend
sublayer is also viable when installed and managed through that supported layer-update/hosting model. Explicitly set
geometry/content scale as part of it.

**Required test:** validate pixels after resize, display invalidation, screen-scale changes, hide/show,
minimize/restore, and another complete AppKit update cycle.

### D-20 — Partial construction leaks resources and can leave phantom events

**Severity:** Medium<br> **Confidence:** Confirmed exception-safety gap

`DarwinLibrary` first opens its dynamic-library/message-shape handles and then constructs native classes, application
state, strings, and a color space at [`packages/winding/darwin/mod.ts:798`](packages/winding/darwin/mod.ts#L798). If a
later step throws, the constructor has no cleanup stack and the successfully opened handles/created objects are
unreachable.

Window construction is locally more careful, but callbacks can queue focus or resize events before the new window is
registered in the owning library at the end of setup. If a later call such as `makeFirstResponder:` fails, the catch
block releases the objects but does not remove already queued events. A subsequent `event()` can return an event
referencing a `Window` object that `open()` never successfully returned to the caller.

`makeNSString()` can also return a null pointer on allocation/UTF-8 conversion failure, but callers proceed to native
setters without distinguishing the failure.

**Required fix:** use an explicit LIFO cleanup stack in both constructors, commit each resource only after the complete
operation succeeds, and purge/mark invalid every queued event for a failed window. Either register early with rollback
or suppress callbacks until construction commits. Validate every nullable Objective-C/Core Graphics result.

**Required tests:** fault-inject every native allocation/message step, then assert no leaked handles/objects, no window
in the demultiplexer, and no event for the failed object.

### D-21 — Fixed process-global Objective-C classes are unsafe across module instances

**Severity:** Medium<br> **Confidence:** Confirmed process-global collision risk

The backend registers fixed names [`WindingWindowDelegate`](packages/winding/darwin/native_classes.ts#L185) and
[`WindingContentView`](packages/winding/darwin/native_classes.ts#L372). Objective-C class names are process-global.
[`objc_allocateClassPair`](https://developer.apple.com/documentation/ObjectiveC/objc_allocateClassPair%28_%3A_%3A_%3A%29)
returns nil if the name already exists.

The module-level singleton prevents duplicate registration for one module instance in one isolate, but it does not
protect:

- two Deno workers with independent module state in the same process;
- two copies/versions of the package loaded by an embedder;
- a host that already defines the same generic names; or
- retry after partial construction.

Partial construction is especially dangerous: the delegate class is registered before the content-view class. If the
second allocation or a later callback creation fails, the first registered class cannot be unregistered by the current
code, callback resources are permanently leaked in the live isolate, and a retry fails on the existing name. Deno
documents an `UnsafeCallback` pointer as valid until it is closed, so partial construction does not by itself prove an
immediately dangling IMP. The sharper dangling risk arises if a worker/isolate is torn down while its process-global
Objective-C class remains registered. The shared deferred-error object is likewise global to all libraries using one
module instance but cannot route an error to the correct library.

**Required fix:** create a true process-global native registration/demultiplexing layer, or use collision-resistant
names plus verified reuse of an already registered compatible class. Stage callback/class creation so failure before
registration is reversible; use `objc_disposeClassPair` for allocated-but-not-registered classes. Never leave a
registered class pointing at callbacks whose lifetime has ended.

**Required test:** concurrent workers, duplicate module URLs/versions, deliberate failure between the two registrations,
then retry and callback invocation.

### D-22 — The delegate implements methods without adopting the protocol

**Severity:** Low<br> **Confidence:** Confirmed metadata mismatch

`WindingWindowDelegate` is allocated as an `NSObject` subclass and receives delegate methods, but the class is never
given formal `NSWindowDelegate` protocol conformance at
[`packages/winding/darwin/native_classes.ts:185`](packages/winding/darwin/native_classes.ts#L185). Objective-C
delegation is structural and the methods normally fire without adoption; this is metadata cleanliness, not a
callback-delivery requirement. The object nevertheless fails conformance/introspection checks for the protocol named by
[`NSWindow.delegate`](https://developer.apple.com/documentation/appkit/nswindow/delegate?language=objc).

**Required fix:** reuse the already-bound `getProtocol`/`addProtocol` helpers to add `NSWindowDelegate`, and verify the
add succeeds before class registration.

**Required test:** assert `class_conformsToProtocol(delegateClass, NSWindowDelegate)` in the native registration smoke
test.

### D-23 — Title conversion is NUL-terminated and nullable

**Severity:** Low<br> **Confidence:** Confirmed string edge case

`makeNSString()` encodes JavaScript text, appends a zero byte, and calls `initWithUTF8String:` at
[`packages/winding/darwin/mod.ts:213`](packages/winding/darwin/mod.ts#L213). Apple's
[`initWithUTF8String:`](https://developer.apple.com/documentation/foundation/nsstring/init%28utf8string%3A%29-vg2b?language=objc)
consumes a NUL-terminated C string. A JavaScript title containing U+0000 is therefore silently truncated. The
initializer is also nullable. `TextEncoder` makes malformed UTF-8 irrelevant here, so allocation/resource failure is the
meaningful nil path; the helper does not check it.

**Required fix:** use an initializer with explicit bytes and length, preserve embedded NUL, and throw on nil before
calling a setter.

**Required tests:** empty, NUL-containing, non-BMP, and very large titles, including a forced initializer failure.

### D-24 — Text conversion and event-key filters alter valid client text

**Severity:** Low<br> **Confidence:** Confirmed edge cases

[`readCFString()`](packages/winding/darwin/ffi.ts#L315) uses the default `TextDecoder` BOM handling at
[`ffi.ts:344`](packages/winding/darwin/ffi.ts#L344). The
[WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder) defines `ignoreBOM` as false by
default and suppresses an initial U+FEFF for UTF-8 in that mode. A native string whose first scalar is U+FEFF can
therefore lose that actual character when decoded, changing both text and any UTF-16 offsets that refer to it. The
conversion also requests UTF-8 with a zero loss byte, so strings containing unpaired UTF-16 surrogates fail; that may be
an acceptable policy, but it must be deliberate and tested.

Separately, [`printableText()`](packages/winding/darwin/text_input.ts#L99) removes Apple's private-use function-key
range. That filtering is appropriate for `NSEvent.characters`, where AppKit encodes special keys in the private-use
area, but the same helper is applied to committed `insertText:` strings. An input method is allowed to commit arbitrary
NSString text, including a private-use character; it should not be discarded merely because NSEvent uses overlapping
values for function keys.

The same commit path calls [`normalizeCommittedText()`](packages/winding/input/keyboard.ts#L20), which rejects any C0,
DEL, or C1 scalar by returning no text for the entire string. Filtering those scalars can be reasonable while
classifying an `NSEvent` key, but `NSTextInputClient` receives an arbitrary committed string. Although AppKit normally
routes editing keys such as Return and Tab through command selectors, the protocol does not guarantee that every input
source will do so. A commit containing a newline, tab, other control, or valid text mixed with one control is therefore
discarded wholesale. The shared IME commit contract requires only a non-empty string and does not authorize this loss.

**Required fix:** preserve a leading U+FEFF during native string conversion, define malformed-surrogate handling, and
separate `NSEvent` key classification from arbitrary IME commit decoding. Define a deliberate commit policy for
controls; if any filtering remains, do not discard otherwise valid surrounding text accidentally.

**Required tests:** leading BOM, unpaired surrogate policy, private-use text, newline, tab, every C0/C1 boundary, and a
control mixed with ordinary committed text.

### D-25 — Unmatched key-up discards a usable native fallback

**Severity:** Low<br> **Confidence:** Confirmed fallback defect

The pressed-key cache has a release path capable of accepting a fallback logical key, and flags-changed uses it.
Ordinary key-up calls `release(keyCode)` without the already computed `native.base.key`. After a focus transition, cache
reset, missed key-down, or backend attachment mid-press, the release event can therefore report `Unidentified` even when
AppKit supplied a usable key value.

**Required fix:** pass `native.base.key` as the release fallback, while retaining physical-code-based pairing for
matched transitions.

**Required tests:** focus loss/recovery, a key held before the window becomes active, and an unmatched release after the
cache is cleared.

### D-26 — Window-position coordinate origin is not specified

**Severity:** Low<br> **Confidence:** Contract ambiguity, not a proven implementation bug

`openWindow()` passes caller `x` and `y` directly to an AppKit `NSRect` at
[`packages/winding/darwin/mod.ts:269`](packages/winding/darwin/mod.ts#L269). Apple's
[Coordinate Systems and Transforms](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaDrawingGuide/Transforms/Transforms.html)
places the system root origin at the lower-left of the primary/menu-bar screen and describes offset origins for other
displays. The cross-platform `openWindow` documentation does not define whether its origin is bottom-left, top-left,
primary-screen-relative, or virtual-desktop-relative.

The Darwin implementation is internally consistent with AppKit, so this is not necessarily wrong. It is nevertheless
impossible for a portable caller to place a window predictably without a declared coordinate convention, particularly
with multiple displays above/below the primary display.

**Required fix:** define the cross-platform screen coordinate system. If it is top-left, convert through the target
screen's visible frame; if it is native-per-platform, say so explicitly.

**Required test:** place windows on every side of a primary display in a multi-display arrangement and assert the
documented screen coordinates after moves between displays.

### D-27 — Scroll input uses the nonpreferred deltas without defining units

**Severity:** Medium<br> **Confidence:** Confirmed AppKit recommendation and cross-contract gap

The scroll importer reads `NSEvent.deltaX` and `deltaY` at
[`packages/winding/darwin/mod.ts:977`](packages/winding/darwin/mod.ts#L977). Apple says directly in the
[`deltaX` documentation](https://developer.apple.com/documentation/appkit/nsevent/deltax) that scroll-wheel events
should use `scrollingDeltaX` instead.
[`scrollingDeltaX`](https://developer.apple.com/documentation/appkit/nsevent/scrollingdeltax?language=objc) is the
preferred scroll property, and
[`hasPreciseScrollingDeltas`](https://developer.apple.com/documentation/appkit/nsevent/hasprecisescrollingdeltas)
determines whether values are fine-grained (trackpad/precision device) or coarse and may require normalization.

The public `WheelEvent` exposes only two unqualified numbers. It has no unit/delta mode, precision indicator, gesture
phase, momentum phase, or coordinate. The backend negates both axes, which may be the desired top-left/DOM-style
direction, but callers cannot interpret the magnitude consistently across a notched mouse wheel and a trackpad. Momentum
events are reduced to indistinguishable wheel samples, and D-06 can route them to the wrong content target.

**Required fix:** use `scrollingDeltaX/Y`; define the shared unit convention and normalize coarse deltas, or extend the
cross-platform event with a delta mode/precision flag. Decide whether phase/momentum must be exposed for consumers that
need gesture lifecycle. Keep the axis inversion only after the target convention is explicit.

**Required test:** notched mouse, Magic Mouse, and trackpad; horizontal/vertical, natural-scrolling on/off,
precise/coarse values, gesture start/end, momentum, and cross-window movement during momentum.

### D-28 — Objective-C exceptions have no safe FFI boundary

**Severity:** Low advisory; D-01 itself remains Critical<br> **Confidence:** Optional defense in depth

Every AppKit operation is a raw `objc_msgSend` from Deno. There is no compiled Objective-C shim containing
`@try/@catch`, so an `NSException` cannot be converted into a JavaScript error before it reaches foreign stack frames.
D-01 is a documented, routine way to trigger this. Other invalid arguments or violated Cocoa programmer invariants can
add less deterministic exception paths.

Apple's
[Exception Programming Topics](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Exceptions/)
says expected exceptions from a subsystem should be caught at that subsystem's top level and translated to an
appropriate result. Apple's
[uncaught-exception documentation](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Exceptions/Concepts/UncaughtExceptions.html)
says the default outcome is process exit. A JavaScript `try/catch` around an FFI call is not an Objective-C exception
handler.

This boundary is optional defense in depth, not a substitute for fixing programmer errors or validating inputs. Apple
recommends avoiding exceptions in shipped code rather than using catch blocks as ordinary control flow. It would not
catch stale-pointer `EXC_BAD_ACCESS`, segmentation faults, or other non-`NSException` memory failures such as D-09/D-03.

**Hardening option:** fix all known invariant violations first. Then consider a small compiled Objective-C bridge for
selected public/message-dispatch entry points that catches `NSException`, copies its name/reason to owned data,
completes native cleanup in `@finally`, and returns an error record. Regardless, native smoke/fault tests should run as
subprocesses so an uncaught exception cannot take down the full test runner.

### D-29 — The pointer-event contract discards data that AppKit already provides

**Severity:** Medium<br> **Confidence:** Confirmed cross-contract information loss

The shared `ButtonEvent` contains only the changed button, and `WheelEvent` contains only two deltas. Neither includes
client coordinates or modifiers; `MoveEvent` includes coordinates but no modifier/button state at
[`packages/winding/types.ts:106`](packages/winding/types.ts#L106). The Darwin importer correspondingly reads
`locationInWindow` only for move/drag, discarding native location and modifier data for down/up/wheel at
[`packages/winding/darwin/mod.ts:950`](packages/winding/darwin/mod.ts#L950).

AppKit's [`NSEvent`](https://developer.apple.com/documentation/AppKit/NSEvent?language=objc) supplies location, modifier
flags, button number, click count, pressed-button state, and timestamp for the relevant event types. Relying on the last
`mousemove` is not equivalent: movement may be coalesced, D-04 currently prevents ordinary moves, a click can be the
first event seen by the backend, and a wheel sample's target/location can change during momentum. Modifier state
inferred from keyboard events is also unreliable for a click that activates an unfocused window.

The missing information makes accurate application-side hit-testing, Shift/Command-click behavior, multi-click handling,
and drag-state recovery impossible without platform-specific side channels.

**Required fix:** define a shared pointer-event base containing client coordinates, modifier snapshot, timestamp (if
ordering/gesture logic needs it), and pressed-button state; add click count to button-down/up or explicitly define
application synthesis. Populate it from the original `NSEvent` in the content-view responder introduced for D-06.

**Required test:** click as the first event without prior motion, modifier-click active content and (if click-through is
adopted) inactive content, OS-configured double/triple click, drag with multiple buttons, and wheel/momentum while
moving between subregions.

### D-30 — The RGBA contract does not define color space, and Darwin chooses Device RGB

**Severity:** Low<br> **Confidence:** Confirmed ambiguity; mismatch if producers intend sRGB

The public method promises only an “RGBA pixel buffer.” Darwin creates one `CGColorSpaceCreateDeviceRGB()` value per
library at [`packages/winding/darwin/mod.ts:807`](packages/winding/darwin/mod.ts#L807) and tags every image with it.
Apple defines
[`CGColorSpaceCreateDeviceRGB`](https://developer.apple.com/documentation/coregraphics/cgcolorspacecreatedevicergb%28%29?changes=_9)
as device-dependent: values are not transformed to preserve appearance and can look different on different output
devices. Apple recommends a calibrated/device-independent space when color preservation matters.

The bitmap flags clearly choose straight, alpha-last RGBA, but the shared contract does not say whether input is
straight or premultiplied, what transfer function/gamut it uses, or how a move between sRGB and wide-gamut displays
should behave. If the software renderer produces conventional sRGB bytes, tagging them as Device RGB is not an exact
representation.

**Required fix:** define the cross-platform byte contract, for example unpremultiplied RGBA8 in sRGB. For that contract,
create/tag images with the named sRGB Core Graphics color space and decide how backing/profile changes trigger redraw.
If Device RGB is intentional, document the display-dependent result.

**Required test:** known color/alpha patches on sRGB and Display P3 screens, a mixed-profile window move, translucent
edges, and comparison against a color-managed sRGB reference.

### D-31 — Logical window size is conflated with backing-pixel size

**Severity:** Medium<br> **Confidence:** Confirmed cross-contract capability gap

Resize handling reads the content view's frame in logical points and reports those rounded values at
[`packages/winding/darwin/mod.ts:472`](packages/winding/darwin/mod.ts#L472). The `blit()` contract then requires its
image dimensions to equal those window dimensions. There is no scale-factor or backing-pixel-size query/event anywhere
in `Window` or `ResizeEvent`.

Apple distinguishes points from backing pixels.
[`NSWindow.backingScaleFactor`](https://developer.apple.com/documentation/appkit/nswindow/backingscalefactor?language=objc)
is 2 for high-resolution scaled modes, and
[`NSView.convertRectToBacking:`](https://developer.apple.com/documentation/appkit/nsview/converttobacking%28_%3A%29-3zors?language=objc)
provides pixel-aligned conversion.
[`CALayer.contentsScale`](https://developer.apple.com/documentation/quartzcore/calayer/contentsscale?changes=_2_5&language=objc)
gives the concrete example that 50×50 points at scale 2 needs a 100×100-pixel bitmap. AppKit updates the scale for
view-attached layers as a window changes screen.

The current API permits only a width×height image for a width×height-point client area. On a scale-2 display, Core
Animation must therefore upscale it to the layer's backing resolution, losing sharpness. Supplying the actual 2× pixel
dimensions would violate the shared size precondition and currently corrupt `#width/#height` as described in D-10.
Moving an unchanged-size window between 1× and 2× screens emits no resize/scale event, so the producer cannot regenerate
at the correct resolution.

**Required fix:** keep logical geometry separate from framebuffer pixel geometry. Expose backing scale or exact backing
width/height in the cross-platform contract, observe `NSWindowDidChangeBackingPropertiesNotification`, and request a new
frame when scale changes even if point size does not. Use `convertRectToBacking:` for exact pixel-aligned dimensions and
configure the managed rendering layer consistently.

**Required test:** sharp one-pixel patterns on 1× and 2× screens, moving the same logical-size window between them,
scaled display modes, and verification that mouse/IME coordinates remain logical while framebuffer dimensions change.

### D-32 — Window geometry is not validated before entering AppKit

**Severity:** Medium<br> **Confidence:** Confirmed validation and cross-contract gap

`openWindow(x, y, w, h)` writes all four JavaScript numbers directly into an `NSRect` and calls
`initWithContentRect:styleMask:backing:defer:` at
[`packages/winding/darwin/mod.ts:269`](packages/winding/darwin/mod.ts#L269). The shared overloads document no
constraints. `NaN`, infinities, negative/zero dimensions, unsafe-magnitude values, and fractional sizes all cross into
AppKit without a check. Apple's
[initializer documentation](https://developer.apple.com/documentation/appkit/nswindow/init%28contentrect%3Astylemask%3Abacking%3Adefer%3A%29)
also documents window-server limits of ±16,000 for position coordinates and 10,000 for sizes; the backend neither
enforces nor reports them.

Negative screen coordinates are valid on multi-display desktops, and fractional point positions can be valid, so the fix
is not simply “all values nonnegative integers.” The dimensions are different: later `CGImageCreate` requires integer
positive pixel counts, `blit()` converts them with `BigInt`, resize events round them, and mouse Y conversion trusts the
stored initial height. A fractional or non-finite initial size therefore has no coherent representation across the
backend even if `NSWindow` happens to accept it; AppKit may instead return nil or raise an invalid-argument exception.

**Required fix:** define the geometry contract. At minimum require finite `x`/`y`, allow their sign, and require
width/height to satisfy an explicit positive/zero-size and integer/logical-point policy consistent with D-10/D-31. Apply
checked bounds before allocating or messaging any AppKit object and report a JavaScript `RangeError`.

**Required test:** NaN/infinity in every field, negative/zero/fractional/unsafe dimensions, valid negative display
coordinates, very large finite rectangles, and a successful first `blit()` after every accepted geometry.

## Low-level FFI verification

The review found no calling-convention defect in the following areas. This matters because several higher-level defects
should not be “fixed” by changing otherwise correct ABI declarations.

| Area                                         | Result                                                        | Notes                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deno FFI carrier types                       | Correct                                                       | Current [Deno FFI documentation](https://docs.deno.com/runtime/fundamentals/ffi/) confirms `u16`/`u32`/`i64`/`u64`/`usize`, pointer, buffer, and by-value struct representations used here. Struct results are `Uint8Array`s, matching the helpers.                                                                                      |
| Objective-C runtime functions                | Correct                                                       | Pointer arguments/results and `size_t`/`ptrdiff_t`-sized fields match the 64-bit Darwin targets used by this backend.                                                                                                                                                                                                                    |
| Objective-C BOOL encoding                    | Correct                                                       | `B` on arm64 and `c` on x86_64 are the right method type encodings. Deno's one-byte boolean carrier is ABI-compatible for zero/one. Apple discusses architecture differences in [Addressing Architectural Differences](https://developer.apple.com/documentation/apple-silicon/addressing-architectural-differences-in-your-macos-code). |
| `NSPoint`, `NSSize`, `NSRect`                | Correct                                                       | All use 64-bit `CGFloat` on supported 64-bit macOS, giving the encoded layouts used in `ffi.ts`.                                                                                                                                                                                                                                         |
| `NSRange` and `NSNotFound`                   | Correct                                                       | Two 64-bit unsigned fields match `NSUInteger`; `NSNotFound` as `NSIntegerMax` is correct on 64-bit macOS.                                                                                                                                                                                                                                |
| Structure returns                            | Correct                                                       | A 32-byte `NSRect` uses `objc_msgSend_stret` on x86_64 and ordinary `objc_msgSend` on arm64. `NSPoint` and `NSRange` use ordinary dispatch. See Apple's [`objc_msgSend_stret`](https://developer.apple.com/documentation/objectivec/1456730-objc_msgsend_stret).                                                                         |
| `NSTextInputClient` selector names           | Correct                                                       | The required selector spellings are present. The protocol's newer optional methods need not be implemented for basic conformance.                                                                                                                                                                                                        |
| `NSTextInputClient` method encodings         | Correct                                                       | Object, range, point, rectangle, BOOL, and `actualRange` pointer encodings match the registered callbacks on both target architectures. Their behavior, not their ABI, causes D-07/D-08.                                                                                                                                                 |
| Core Graphics declarations                   | Correct                                                       | Color space, data provider, image creation/release declarations and integer widths match the C API.                                                                                                                                                                                                                                      |
| Bitmap flags                                 | Correct for straight RGBA                                     | `kCGImageAlphaLast                                                                                                                                                                                                                                                                                                                       |
| Provider/image ownership on the success path | Correct but incomplete                                        | Releasing the provider after successful image creation is correct because the image retains it; releasing the image after assigning it to the layer is likewise normal. The unresolved problem is ownership of the provider's _underlying JavaScript bytes_ (D-03) and cleanup on throws (D-10).                                         |
| Core Foundation string C ABI                 | Correct                                                       | The `CFStringGetLength`, maximum-size, and bytes calls use compatible widths; NSString/CFString toll-free bridging is valid.                                                                                                                                                                                                             |
| `CFRange` nominal signedness                 | ABI-compatible                                                | The binding reuses unsigned `NSRange` fields where `CFRange` is two signed `CFIndex` fields. The bits/layout are identical on 64-bit Darwin, and this code supplies only nonnegative values. A distinct signed type would be clearer but changes no current call.                                                                        |
| AppKit constants                             | Correct                                                       | Window style masks, event-type values, modifier masks, activation-policy values, backing-store value, and the base tracking-area bit values match current declarations. D-17 concerns the chosen semantics, not the numeric constants.                                                                                                   |
| General object ownership                     | Mostly correct                                                | Under nonthrowing construction, alloc/init/copy results and explicitly created Core Graphics objects are generally released. D-03, D-10, D-18, and D-20 are the material exceptions.                                                                                                                                                     |
| Unsafe callback carrier lifetime             | Correct while the module singleton/live isolate remains valid | Deno says callback pointers remain valid until `close()`. The backend roots registered IMP callbacks in its module singleton, but the Objective-C classes have process lifetime. Worker/isolate teardown and partial registration/collision therefore remain D-21 risks.                                                                 |

## Cross-platform contract assessment

The Darwin backend implements the shape of the public API, but seven contract areas need clarification or extension:

1. **Text documents and selections.** `NSTextInputClient` is a document-oriented protocol. The public backend currently
   exposes outgoing composition/commit/delete events and a cursor rectangle, but no authoritative surrounding-text
   snapshot, document-wide UTF-16 selection, replacement operation, or per-range geometry. Full AppKit conformance
   cannot be built from the existing information. D-07/D-08 therefore require both a Darwin fix and probably a
   cross-platform interface addition.
2. **Rendering dimensions and scale.** `blit()` says its buffer matches the client area, but the API must say whether
   dimensions are logical points or backing pixels and how scale changes are surfaced. The present API cannot request
   Retina-native backing dimensions explicitly, and the Darwin implementation incorrectly lets a submitted frame size
   overwrite mouse-coordinate geometry when it does not match the native client size (D-10/D-31).
3. **Window geometry.** The screen origin/multi-monitor convention and accepted finite/integer/zero-size domain are
   unspecified (D-26/D-32).
4. **Post-close behavior.** The API should define whether operations throw or become no-ops after window/library
   closure. Whichever choice is made must prevent native access and be uniform.
5. **Pointer event snapshots.** Button and wheel events need their own occurrence coordinates and modifier/button
   snapshot; relying on a separate move event loses native information (D-29).
6. **Pixel interpretation.** The RGBA contract must define straight versus premultiplied alpha and a color
   space/transfer function; Device RGB is not a stable substitute for an sRGB contract (D-30).
7. **IME activation.** The shared synchronous `activate(): boolean` action model does not fit AppKit's system-invoked
   void activation lifecycle. Darwin must report observed responder/context state, or the contract must describe routing
   permission rather than native activation (D-12).

These are not reasons to weaken the Darwin implementation. They identify information that the shared contract must
supply for a faithful backend.

## Declaration-by-declaration audit

This section records the raw declaration check independently of behavioral correctness. “Exact” means the argument and
return registers/stack layout match on arm64 and x86_64; it does not mean the call is made at a valid time or with valid
values.

### Objective-C runtime C functions

| Bound functions                                                        | Audit result                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `objc_getClass`, `objc_getProtocol`, `sel_registerName`, `sel_getName` | Exact pointer/C-string declarations. The class, protocol, and selector-name wrappers check null. `sel()` returns `sel_registerName` directly; valid non-null names normally register successfully, but that wrapper has no explicit null check. |
| `objc_allocateClassPair`                                               | Exact: `Class`, C string, `size_t` extra bytes -> `Class`. The fixed-name/process-lifetime use is D-21.                                                                                                                                         |
| `objc_registerClassPair`                                               | Exact `void(Class)`.                                                                                                                                                                                                                            |
| `class_addMethod`                                                      | Exact object/selector/IMP/C-string inputs and one-byte BOOL result. The result is checked.                                                                                                                                                      |
| `class_addProtocol`                                                    | Exact and checked. It is used for `NSTextInputClient` but not `NSWindowDelegate` (D-22).                                                                                                                                                        |
| `class_conformsToProtocol`                                             | Exact and used by smoke validation.                                                                                                                                                                                                             |

`objc_disposeClassPair` is not bound. It is not needed after successful registration, but it is needed to make
pre-registration failure cleanup in D-21 complete.

### Core Graphics and Core Foundation C functions

| Bound function                                                                                                                 | Audit result                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CGColorSpaceCreateDeviceRGB(void) -> CGColorSpaceRef`                                                                         | Exact. Created ownership is released during normal library close. Constructor failure paths remain D-20.                                                                                                     |
| `CGDataProviderCreateWithData(info, data, size, releaseData)`                                                                  | Exact C shape. Passing `null` as `info` and callback is legal only if the client independently keeps `data` valid for the provider's full life; this implementation does not (D-03).                         |
| `CGImageCreate(width, height, bits/component, bits/pixel, rowBytes, space, bitmapInfo, provider, decode, interpolate, intent)` | Exact integer, pointer, C `bool`, and enum widths. The supplied values are not validated (D-10).                                                                                                             |
| `CFRelease(CFTypeRef)`                                                                                                         | Exact. Core Graphics create-rule objects can be released through it.                                                                                                                                         |
| `CFStringGetLength`                                                                                                            | Exact 64-bit `CFIndex` result.                                                                                                                                                                               |
| `CFStringGetMaximumSizeForEncoding`                                                                                            | Exact `CFIndex`/`CFStringEncoding` shape.                                                                                                                                                                    |
| `CFStringGetBytes`                                                                                                             | ABI-exact except for the nominal `CFRange` alias discussed above. `Boolean` is an unsigned byte; Deno's bool carrier has the same one-byte zero/one ABI. `usedBufLen` uses a signed 64-bit cell as required. |

The hard-coded framework locations are the canonical system framework/dylib locations on current macOS. Availability of
individual selectors, rather than the paths, is the compatibility concern for deployment targets.

### Objective-C messages initiated by the backend

| Message family                                                                                                                                         | Actual declaration shape                                                                      | Binding result                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alloc`, `init`, `sharedApplication`, `distantPast`, `array`, `string`, `layer`, `inputContext`, `window`, `characters`, `charactersIgnoringModifiers` | `(id, SEL) -> id`                                                                             | Exact. D-01 concerns an invalid event type for the character getters.                                                                                                  |
| `initWithUTF8String:`                                                                                                                                  | `(id, SEL, const char *) -> id`                                                               | Exact call shape; NUL semantics/null handling are D-23.                                                                                                                |
| `initWithFrame:`                                                                                                                                       | `(id, SEL, NSRect) -> id`                                                                     | Exact.                                                                                                                                                                 |
| `initWithContentRect:styleMask:backing:defer:`                                                                                                         | `(id, SEL, NSRect, NSUInteger, NSUInteger, BOOL) -> id`                                       | Exact on both architectures.                                                                                                                                           |
| `initWithRect:options:owner:userInfo:`                                                                                                                 | `(id, SEL, NSRect, NSUInteger, id, id) -> id`                                                 | Exact; chosen tracking options are D-17.                                                                                                                               |
| `arrayWithObject:`                                                                                                                                     | `(id, SEL, id) -> id`                                                                         | Exact. Returned array is autoreleased inside the polling pool.                                                                                                         |
| `isKindOfClass:`, `makeFirstResponder:`                                                                                                                | `(id, SEL, id) -> BOOL`                                                                       | Exact and results are used.                                                                                                                                            |
| `setDelegate:`, `setContentView:`, `addTrackingArea:`, `setContents:`, `setTitle:`, `interpretKeyEvents:`, `sendEvent:`, `orderOut:`                   | `(id, SEL, id) -> void`                                                                       | Exact. Timing, routing, ownership, and post-close validity are covered elsewhere.                                                                                      |
| `setWantsLayer:`, `activateIgnoringOtherApps:`                                                                                                         | `(id, SEL, BOOL) -> void`                                                                     | Exact. The activation method is deprecated and the unconditional foreground policy is a D-15 concern.                                                                  |
| `setActivationPolicy:`                                                                                                                                 | `(id, SEL, NSInteger) -> BOOL`                                                                | **Return mismatch:** bound as void. Argument width is exact. See D-15.                                                                                                 |
| `makeKeyAndOrderFront:`                                                                                                                                | `(id, SEL, id) -> void`                                                                       | **Argument mismatch:** bound as BOOL. False is not guaranteed to zero all pointer-width argument bits; see D-15.                                                       |
| `finishLaunching`, `release`, `drain`, `discardMarkedText`, `invalidateCharacterCoordinates`                                                           | `(id, SEL) -> void`                                                                           | Exact. Lifecycle/use issues are D-11, D-12, D-13, and D-18.                                                                                                            |
| `acceptsFirstResponder`, `isARepeat`, `hasMarkedText` getters                                                                                          | `(id, SEL) -> BOOL`                                                                           | Exact.                                                                                                                                                                 |
| `type`, `modifierFlags`                                                                                                                                | `(id, SEL) -> NSUInteger/flags`                                                               | Exact 64-bit scalar return.                                                                                                                                            |
| `buttonNumber`                                                                                                                                         | `(id, SEL) -> NSInteger`                                                                      | Exact signed 64-bit return; mapping is D-14.                                                                                                                           |
| `keyCode`                                                                                                                                              | `(id, SEL) -> unsigned short`                                                                 | Exact.                                                                                                                                                                 |
| `deltaX`, `deltaY`                                                                                                                                     | `(id, SEL) -> CGFloat`                                                                        | Exact 64-bit floating return. They are valid for scroll events, but AppKit prefers `scrollingDeltaX/Y`; the shared abstraction does not define units/precision (D-27). |
| `locationInWindow`                                                                                                                                     | `(id, SEL) -> NSPoint`                                                                        | Exact struct return. Content routing/coordinate assumptions are D-06.                                                                                                  |
| `bounds`, `frame`, `convertRectToScreen:`, `firstRectForCharacterRange:actualRange:`                                                                   | NSRect-returning shapes                                                                       | Exact architecture split. Range/coordinate semantics are D-08/D-13.                                                                                                    |
| `nextEventMatchingMask:untilDate:inMode:dequeue:`                                                                                                      | `(id, SEL, NSEventMask /* unsigned long long */, NSDate *, NSRunLoopMode, BOOL) -> NSEvent *` | Exact `u64` shape. The stored date ownership and global-queue use are D-11/D-18.                                                                                       |

No variadic Objective-C method is called. There is no accidental use of `objc_msgSend_fpret`; 64-bit `CGFloat` and the
used struct cases are correctly covered by ordinary/stret dispatch on the supported architectures.

### Objective-C methods implemented by Deno callbacks

| Implemented methods                                                                        | Audit result                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `windowShouldClose:`                                                                       | Exact BOOL return and object argument encoding. Returning false while queuing a cross-platform close request is a coherent policy. |
| `windowDidResize:`, key/visibility delegate notifications, `mouseEntered:`, `mouseExited:` | Exact void/object encodings. Formal delegate conformance is missing (D-22).                                                        |
| `acceptsFirstResponder`, `keyDown:`, `keyUp:`, `flagsChanged:`                             | Exact encodings. `flagsChanged:` behavior is critically invalid (D-01).                                                            |
| `insertText:replacementRange:`                                                             | Exact object + by-value `NSRange` encoding; replacement value is discarded (D-07).                                                 |
| `setMarkedText:selectedRange:replacementRange:`                                            | Exact object + two by-value `NSRange` encodings; the second range is discarded (D-07).                                             |
| `unmarkText`, `hasMarkedText`, `markedRange`, `selectedRange`                              | Exact void/BOOL/struct encodings. Returned state is inconsistent (D-08).                                                           |
| `validAttributesForMarkedText`                                                             | Exact object return. An empty array is explicitly allowed.                                                                         |
| `attributedSubstringForProposedRange:actualRange:`                                         | Exact object, by-value range, and range-pointer encoding. Behavior is incomplete (D-08).                                           |
| `characterIndexForPoint:`                                                                  | Exact `NSUInteger` result and `NSPoint` argument encoding. Constant `NSNotFound` behavior is incomplete (D-08).                    |
| `firstRectForCharacterRange:actualRange:`                                                  | Exact architecture-sensitive `NSRect` result, range value, and pointer encoding. Behavior is incomplete (D-08).                    |
| `doCommandBySelector:`                                                                     | Exact selector-argument encoding (`v@::`).                                                                                         |

## Existing test coverage and what it misses

The Darwin-specific pure tests provide useful coverage of UTF-16-to-UTF-8 cursor conversion, composition state,
logical-key helpers, rectangle conversion, range serialization, and many state transitions. The native smoke test adds
valuable checks for:

- main-thread detection in the test harness;
- Objective-C class/protocol registration and required selector presence;
- selected callback ABIs through actual text/preedit/commit/command dispatch;
- arm64/x86_64 range, point, and rectangle message/callback paths;
- Foundation string conversion;
- first-rectangle screen conversion; and
- repeated native object construction/teardown.

Those tests do not currently establish production correctness because they do not cover:

- a real `FlagsChanged` dispatch (D-01);
- production enforcement of the main-thread condition (D-02);
- asynchronous data-provider/layer lifetime or forced GC (D-03);
- normal mouse movement, window chrome, click-to-focus ordering, middle/side buttons, or scroll devices (D-04–D-06,
  D-14, D-17, D-27);
- real input methods, replacement ranges, reconversion, or protocol-query consistency (D-07/D-08/D-12/D-13);
- calls after close, fault-injected construction, or concurrent libraries/workers (D-09–D-11, D-20/D-21);
- invalid initial coordinates/dimensions and their interaction with the first frame (D-32);
- persistence of layer contents after an AppKit update (D-19); or
- long-running autorelease/update behavior (D-18).

The smoke test's outer autorelease pool specifically masks D-18 for most of its body. It contains no
`blit()`/`CALayer.contents` or pixel assertion, and it exercises selected callback signatures rather than inspecting
every registered method's runtime type encoding.

## Required macOS validation matrix

All critical/high fixes should land with native subprocess tests. Pure tests are appropriate for state-machine details,
but they cannot prove Objective-C exception behavior, AppKit routing, Core Animation lifetime, or architecture-specific
message dispatch.

| Axis                     | Minimum cases                                                                                                           | Required observations                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU/ABI                  | arm64 and x86_64, if both are supported                                                                                 | `sizeof`/alignment/`@encode`; direct calls for every struct return and callback; BOOL true/false; all callback encodings                                                            |
| OS versions              | oldest supported deployment target and current macOS                                                                    | selector availability/deprecation fallback; activation and event-loop behavior                                                                                                      |
| Thread/isolate           | main thread, worker, duplicate module/worker, sequential reload                                                         | deterministic main-thread rejection; no class collision, callback dangling, or cross-instance loss                                                                                  |
| Application lifecycle    | standalone Deno process, already-launched AppKit host, two library facades                                              | launch/activation performed once; events demultiplexed; no global policy surprise                                                                                                   |
| Modifier keys            | left/right Shift, Control, Option, Command; Caps Lock; Fn                                                               | no exception; exact physical/logical transition pairing and flags                                                                                                                   |
| Keyboard hardware/layout | ANSI, ISO, JIS; several input layouts                                                                                   | correct `code`, logical `key`, location, repeat, key-up pairing, dead-key behavior                                                                                                  |
| Text input               | Japanese, Korean, Simplified/Traditional Chinese, dead-key layout, dictation/text replacement if supported              | replacement ranges honored; document-wide UTF-16 queries mutually consistent; ordered preedit/commit/delete; candidate placement                                                    |
| Pointer routing          | content, every title-bar control, title drag, every resize border, drag capture                                         | client sees only content-routed events; default inactive click yields focus only, or an explicit click-through policy retains focus plus click in defined order; no duplicates/loss |
| Mouse hardware           | left/right/middle/side buttons; move with/without focus                                                                 | correct mapping, normal move enabled, enter/leave policy documented                                                                                                                 |
| Scroll hardware          | notched wheel, Magic Mouse, trackpad; natural scrolling both settings                                                   | declared units/direction; precision/coarse normalization; momentum/phase policy; content target                                                                                     |
| Rendering                | rapid frames, forced GC, fault after each allocation, resize, backing-scale/display changes                             | exact pixels; no stale/native reads; release callback/copy ownership; no leaks; stable layer contents                                                                               |
| Lifecycle                | close during composition/drag, every method after close, library close with windows, failure at each constructor step   | no native access after release; complete rollback; no phantom events; idempotent teardown                                                                                           |
| Displays                 | 1x/2x scale, mixed-scale multi-display, negative virtual coordinates                                                    | documented logical/pixel size; accurate pointer and candidate rectangles; proper invalidation                                                                                       |
| Memory/run loop          | prolonged idle and high-frequency title/open/resize/blit/event cycles                                                   | bounded autorelease high-water; timely window/CA updates; retained stored Foundation objects                                                                                        |
| Strings                  | empty, embedded NUL, U+FEFF prefix, combining text, non-BMP, private-use, newline/tab/C0/C1, malformed surrogate policy | exact round-trip or deliberate documented rejection; no accidental whole-commit loss; correct UTF-16/UTF-8 offsets                                                                  |

A small Objective-C test helper compiled with the target SDK should print/verify `sizeof`, `_Alignof`, `@encode`,
`methodSignatureForSelector:`, and selected IMP calls. Run crash-prone cases in separate processes with NSZombieEnabled
and malloc diagnostics; use Instruments for retained objects and provider-buffer lifetime. Pixel tests should wait for
an actual Core Animation/window-server commit rather than reading the property immediately.

## Recommended remediation order

1. **Stop the normal-input crash:** implement a character-free `FlagsChanged` path (D-01) and add the modifier
   subprocess test. This should be the first patch.
2. **Close memory/lifecycle holes:** enforce main-thread access, replace guessed pixel roots with callback/copy
   ownership, validate initial geometry and transactionalize `blit()`, guard all post-close methods, and make
   construction rollback complete (D-02, D-03, D-09, D-10, D-20, D-32).
3. **Make native application state singular:** introduce one ref-counted AppKit state/event demultiplexer and robust
   process-global class registration (D-11, D-21, D-22). Do this before expanding event handling, otherwise new handlers
   will inherit the cross-instance loss.
4. **Move pointer translation into the content responder:** enable motion, honor hit-testing/capture, retain causative
   events, correct buttons/tracking, and define modern scrolling units (D-04–D-06, D-14, D-17, D-27).
5. **Define the missing cross-platform contracts:** document logical points versus pixels/backing scale,
   screen-coordinate origin, wheel units, post-close behavior, and—most importantly—surrounding
   text/selection/replacement/geometry for text clients.
6. **Rebuild text input on that contract:** honor replacement ranges, make all `NSTextInputClient` queries coherent,
   observe responder/context-managed activation, and invalidate geometry for every screen-space change (D-07, D-08,
   D-12, D-13).
7. **Complete international keyboard behavior:** add key-code-specific logical keys, ISO/JIS handling, dead-key
   ordering, NFC/single-base validation, and key-up fallback (D-16, D-24, D-25).
8. **Harden AppKit integration:** correct the two message shapes, modernize activation, establish autorelease/update
   discipline, use an AppKit-supported rendering layer model, fix exact string creation, and optionally add an
   Objective-C exception translation boundary (D-15, D-18, D-19, D-23, D-28).

## Overall conclusion

The binding layer is not broadly ABI-wrong: only two Objective-C call shapes are inaccurate. Discarding
`setActivationPolicy:`'s BOOL result is register-safe but loses failure; passing the sender of `makeKeyAndOrderFront:`
through a BOOL shape is not guaranteed pointer-safe. The much larger problem is that correct declarations are used
outside their documented domains or without the state, lifetime, routing, and global-application invariants AppKit
requires.

D-01 is a release-blocking defect because ordinary modifier input reaches a selector that Apple guarantees can raise.
D-02 through D-04, D-06, D-07, D-09, and D-11 are the other safety/reliability blockers. D-05 is a structural ordering
risk whose current content-eligible trigger needs native confirmation; D-10/D-32 are important boundary hardening rather
than proven valid-input crashes. The text-client implementation is sufficient for a narrow “composition string in,
events out” demonstration but not for the full range/query behavior of the protocol it advertises; full correctness
requires more cross-platform document state than the present interface supplies.

After the first safety fixes, the highest-leverage architectural change is to centralize AppKit state and route input
from the content view rather than reconstructing it from the global event queue. That simultaneously resolves the most
serious event-loss, hit-testing, multi-instance, and mouse-move design problems and creates the right place to enforce
thread, pool, exception, and lifecycle invariants.
