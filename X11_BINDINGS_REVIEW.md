# X11 FFI and backend review

Reviewed at repository commit `a48ca1647f006b6bda5c1a7373475c3588c92e9c` on 2026-07-10.

## Executive summary

The X11 backend is not currently safe to describe as a general Linux/X11 implementation. Its common happy
path—little-endian LP64, screen 0, a depth-24 TrueColor visual stored as 32-bit `0x00RRGGBB`, and a simple/local input
method—matches this machine. Outside that path there are several correctness failures, and some ordinary error cases
reach native use-after-free or Xlib's process-exiting default handler.

The raw declaration table is substantially better than the runtime implementation. I compared all 403 entries in
`x11functions` with the installed headers. There are no ordinary-function arity mismatches, all declared symbols exist
in the installed libX11 1.8.12, all event/mask constants match, and the manually used LP64 structure offsets are correct
on this host. The exact declaration defects are:

- every `GC` is modeled as an integer (`usize`) even though it is an opaque pointer;
- five `KeyCode` arguments/results use `u32` instead of the installed header's `unsigned char`;
- the fixed `u64`/`i64` descriptions of C `long` are wrong on ILP32;
- the fixed-signature aliases for variadic XIM functions are an ABI-specific workaround, not portable C declarations.

The highest-priority implementation findings are:

1. `XFilterEvent` is not called for every event, which violates the XIM dispatch contract and can break both local and
   server-backed input methods.
2. Rendering assumes screen 0, depth 24, 32-bit linear little-endian BGRX, while Xlib exposes the actual screen, depth,
   stride, bits per pixel, byte order, and color masks.
3. A newly mapped window can upload uninitialized `malloc` data on its first `Expose`.
4. Selecting nearly every event mask enables `SubstructureRedirectMask`, silently intercepting child map/configure
   requests that the backend never handles.
5. `setImeCursorArea` uses XIM styles for which the Xlib specification says `XNSpotLocation` and `XNArea` are ignored;
   the public API is therefore not implemented by standard XIM.
6. Focus loss clears only the JavaScript preedit state, not the XIC, so text announced as canceled can later be returned
   and committed.
7. `blit`, `reblit`, and `setTitle` remain callable after close; `blit` then writes through a typed-array view of freed
   native memory.
8. The runtime installs no X error trap. Invalid dimensions, visual/depth mismatches, stale resources, and other
   protocol errors can terminate the entire process through Xlib's default handler.
9. In the fallback lookup path, Alt/Meta shortcuts are converted into text commits. This was reproduced against the
   active server with Alt+A and Meta+A.
10. XIM-filtered physical keys are omitted even though Winding's shared contract says text-input keydowns remain
    observable.

These are not merely declaration-style concerns. The renderer, event selection, XIM filtering, focus reset, post-close
access, and shortcut behavior should be fixed before treating this backend as production-safe.

## Scope

Included:

- every file under `packages/winding/x11`;
- X11-facing Linux key conversion in `packages/winding/linux`;
- the shared `Window`, `Library`, input-event, IME, and queue contracts that the X11 backend implements;
- top-level backend selection only where it changes whether this X11 implementation can run.

Excluded:

- implementation review of Darwin, Win32, and Wayland;
- application behavior above the shared Winding contract, except where useful to show the impact of a violated contract;
- features not represented by Winding's API, such as clipboard, drag-and-drop, and OpenGL.

## Method and evidence

The review used four complementary checks.

### Installed-header and symbol audit

The host is x86-64, little-endian LP64. Installed packages report libX11/libX11-dev 1.8.12. All 403 descriptors were
compared with Clang AST declarations from:

- `/usr/include/X11/Xlib.h`
- `/usr/include/X11/Xutil.h` with `XUTIL_DEFINE_FUNCTIONS`
- `/usr/include/X11/XKBlib.h`

The 401 unique requested symbol names were checked against `/usr/lib/x86_64-linux-gnu/libX11.so.6`; all are exported by
the installed library.

### Native layout probes

A C probe compiled against the installed headers confirmed the LP64 layouts used by the TypeScript decoder. Selected
results are recorded later in this report. Clang layout checks for i386 and AArch64 were also compared: AArch64 LP64
agrees with x86-64 for the structures used here, while i386 does not.

### Read-only active-server probes

The active X.Org server reports:

- one screen, default screen 0;
- default depth 24;
- a 32-bpp depth-24 pixmap format with 32-bit scanline padding;
- `LSBFirst` image order;
- red/green/blue masks `0xff0000`, `0xff00`, `0xff`.

That explains why the current pixel loop works on this machine. It does not make those values X11 invariants.

A second probe confirmed that, for the active keymap, `XLookupString` returns printable `"a"` for each of plain A,
Mod1+A, and Mod4+A, while Control+A returns byte `0x01`. This directly confirms the Alt/Meta commit finding.

The installed libX11 also tolerated `XkbKeysymToModifiers` before an explicit `XkbQueryExtension` and returned the
expected Mod5 mask. The XKB specification still requires initialization, so this is recorded as a
portability/specification concern rather than a reproduced failure on this host.

### Specifications

Behavioral claims were checked against the official documents:

- [Xlib — C Language X Interface](https://www.x.org/releases/current/doc/libX11/libX11/libX11.html)
- [X Keyboard Extension Library Specification](https://www.x.org/releases/current/doc/libX11/XKB/xkblib.html)
- [Inter-Client Communication Conventions Manual](https://www.x.org/releases/current/doc/xorg-docs/icccm/icccm.html)
- [Deno FFI documentation](https://docs.deno.com/runtime/fundamentals/ffi/)

The Deno executable and Xvfb are not installed in this environment, so the TypeScript unit suite and `xvfb_smoke.ts`
could not be run. The C ABI/layout and active-server probes above were run instead. This limitation does not affect
findings derived directly from control flow, installed declarations, or normative Xlib behavior, but it means no real
callback-style/server-backed XIM was exercised end-to-end.

## Severity guide

- **High**: native memory safety, unintended data exposure, process termination, or failure of a core advertised feature
  under a valid X11 configuration.
- **Medium**: observable API/semantic mismatch, important interoperability problem, or a conditional failure requiring a
  less common configuration.
- **Low**: narrow edge, nominal type mismatch without an effect on the current ABI, or hardening/test debt.

## Findings at a glance

| ID     | Severity   | Finding                                                                                  |
| ------ | ---------- | ---------------------------------------------------------------------------------------- |
| X11-01 | High       | XIM events are filtered only for active, known-window key events                         |
| X11-02 | High       | The image pipeline hard-codes screen 0/depth 24/32-bit little-endian BGRX                |
| X11-03 | High       | Initial `Expose` can upload uninitialized native heap data                               |
| X11-04 | High       | `SubstructureRedirectMask` intercepts child operations that are never serviced           |
| X11-05 | High       | `setImeCursorArea` is ignored for every negotiated standard XIM style                    |
| X11-06 | High       | Blur cancels local preedit without resetting pending native XIC state                    |
| X11-07 | High       | Post-close window methods can use freed native memory/resources                          |
| X11-08 | High       | X protocol and I/O errors retain Xlib's process-exiting behavior                         |
| X11-09 | High       | Alt/Meta printable shortcuts become text commits in fallback lookup                      |
| X11-10 | High       | Filtered key transitions violate Winding's observable-key contract                       |
| X11-11 | Medium     | `NotifyWhileGrabbed` and focus details are handled incorrectly                           |
| X11-12 | Medium     | XIM caret callback implements only absolute movement                                     |
| X11-13 | Medium     | XIM style negotiation rejects compatible combinations and misuses callback-only fallback |
| X11-14 | Medium     | Synthetic XIM keycode zero becomes a phantom/repeating public key                        |
| X11-15 | Medium     | Modifier mapping and modifier-transition snapshots are not correct                       |
| X11-16 | Medium     | DOM `code` assumes the non-standard `X keycode = evdev + 8` convention                   |
| X11-17 | Medium     | Internal Xlib/XIM connections are never polled or processed                              |
| X11-18 | Medium     | Configure events and `blit` do not maintain the shared size invariant                    |
| X11-19 | Medium     | Window destruction is buffered and constructor failures can leave a mapped ghost         |
| X11-20 | Medium     | `OwnerGrabButtonMask` breaks normal implicit capture across Winding windows              |
| X11-21 | Medium     | Horizontal core scrolling is discarded                                                   |
| X11-22 | Medium     | External `DestroyNotify` leaves a live wrapper around a dead X resource                  |
| X11-23 | Medium     | Process-global locale/modifier state and Xlib threading are unmanaged                    |
| X11-24 | Medium     | Callback unregister/creation error paths can retain stale contexts or pointers           |
| X11-25 | Medium     | Preedit start/feedback/error recovery do not preserve the public/native semantics        |
| X11-26 | Low/Medium | X11 never implements surrounding-text/reconversion events exposed by the shared union    |
| FFI-01 | Medium     | `GC` is declared as `usize` in 61 positions instead of `pointer`                         |
| FFI-02 | Low        | Five Linux `KeyCode` positions use `u32` instead of `u8`                                 |
| FFI-03 | Medium     | Binding 403 entries eagerly creates an unnecessary libX11 1.7 minimum                    |
| FFI-04 | Medium     | The backend is LP64, little-endian, and glibc-specific without a runtime guard           |
| FFI-05 | Low/Medium | Variadic XIM symbols are invoked through fixed non-variadic descriptors                  |
| FFI-06 | Low        | `Screen` is decoded by private offsets despite being specified as opaque                 |
| X11-27 | Low        | Several smaller event-validation and repeat edges remain                                 |

## Detailed runtime and contract findings

### X11-01 — XIM filtering violates the all-event dispatch contract

Severity: **High**

Evidence:

- [`packages/winding/x11/mod.ts:405`](packages/winding/x11/mod.ts#L405) enters filtering only for
  `KeyPress`/`KeyRelease` and only after resolving the event to a Winding window.
- [`packages/winding/x11/xim.ts:221`](packages/winding/x11/xim.ts#L221) additionally refuses to call `XFilterEvent`
  unless the particular context's activation state is active.
- [`packages/winding/x11/xim.ts:309`](packages/winding/x11/xim.ts#L309) obtains `XNFilterEvents` and adds its mask to
  the window, so the backend explicitly asks Xlib to deliver events that it then does not filter.
- Events whose `window` is an XIM protocol/preedit window cannot be found in `X11Library.windows` and are ultimately
  discarded by [`importEvent`](packages/winding/x11/mod.ts#L561).

Xlib says any client using XIM should call `XFilterEvent` after `XNextEvent`, and should discard an event only if the
filter returns true. The Xlib manual specifically names preedit-window `Expose` events and input-server protocol events
as examples that client code must not consume first.

Consequences include:

- XIM `ClientMessage` and `PropertyNotify` transport traffic can be removed from the queue without the IM seeing it;
- an input method's local/preedit child-window events can be misrouted or discarded;
- the instantiate callback registered when the preferred IM is unavailable may not be driven reliably;
- IM-server destroy/restart handling can stall, leaving activation or XIC state stale;
- selecting `XNFilterEvents` is ineffective for non-key types.

This should be reorganized so every event is offered to `XFilterEvent(event, None)` immediately after `XNextEvent` and
before Winding routing. Key-event staging can remain, but it should not be the gate to filtering. XIM filters are
display/event based and must also run when there is no active Winding XIC.

### X11-02 — renderer assumes one particular visual and image format

Severity: **High**

Evidence:

- The window parent comes from the actual default `Screen` at [`mod.ts:77-92`](packages/winding/x11/mod.ts#L77).
- Image creation instead uses `XDefaultVisual(display, 0)` at [`mod.ts:123`](packages/winding/x11/mod.ts#L123) and
  [`mod.ts:187`](packages/winding/x11/mod.ts#L187), even when the display's default screen is not screen 0.
- [`native_image.ts:45-55`](packages/winding/x11/native_image.ts#L45) hard-codes depth 24, `ZPixmap`, bitmap pad 32, and
  calculated stride.
- [`mod.ts:202-207`](packages/winding/x11/mod.ts#L202) always writes tightly packed four-byte BGRX pixels.

`XCreateImage` fills `byte_order`, `bytes_per_line`, `bits_per_pixel`, and RGB masks from the display/visual. The
current code never reads them. It also never obtains the actual default-window depth. Valid X11 configurations include
16-bit, 30-bit, and other depths; depth 24 can use a storage format other than the assumed one; TrueColor masks can be
reversed; and image byte order is a server/display property.

Failure modes:

- default screen other than zero combines a drawable from one screen with a visual from another;
- a depth-24 image sent to a non-depth-24 window produces `BadMatch`;
- alternate masks or byte order produce swapped/incorrect colors;
- a non-32-bpp depth-24 format makes the linear four-byte write disagree with `bytes_per_line` and pixel boundaries;
- because no X error trap exists, `BadMatch` normally terminates the process.

Use `XDefaultVisualOfScreen` and `XDefaultDepthOfScreen` for the same `Screen` as the root window. After `XCreateImage`,
validate/read the returned image's stride, bpp, byte order, and masks; allocate `bytes_per_line * height`; and pack RGBA
by those values. A small native shim that owns `XImage` creation and pixel conversion would remove much of the fragile
manual layout work.

### X11-03 — initial expose uploads uninitialized heap contents

Severity: **High**

Evidence:

- [`native_image.ts:38-44`](packages/winding/x11/native_image.ts#L38) allocates pixels with `malloc` and creates a
  typed-array view without initializing it.
- [`mod.ts:95-100`](packages/winding/x11/mod.ts#L95) changes the window background pixmap to `None`.
- The window is mapped before the application supplies a frame at [`mod.ts:110`](packages/winding/x11/mod.ts#L110).
- Every `Expose`, including the initial expose, calls full-window `reblit()` at
  [`mod.ts:501-506`](packages/winding/x11/mod.ts#L501).

Thus a normal event loop can send recycled process heap bytes to the X server and put them on screen before the first
public `blit`. With a remote X display, those bytes are transmitted to the remote server. A second same-sized window can
also reuse image memory containing a previous window's pixels.

Either initialize the image to a defined opaque color immediately, use zero-initialized allocation, or track `hasFrame`
and never `XPutImage` until a real frame has been supplied. Keeping background `None` is reasonable for flicker
reduction only after there is known retained content.

### X11-04 — selecting “all masks” enables unimplemented redirection

Severity: **High**

Evidence:

- [`mod.ts:33-41`](packages/winding/x11/mod.ts#L33) selects every core mask except `PointerMotionHintMask` and
  `ResizeRedirectMask`.
- This includes `SubstructureRedirectMask` and `SubstructureNotifyMask` from
  [`ffi.ts:62-63`](packages/winding/x11/ffi.ts#L62).
- The broad mask is set at window creation and every time an XIC adds its filter mask:
  [`mod.ts:101`](packages/winding/x11/mod.ts#L101), [`mod.ts:352-354`](packages/winding/x11/mod.ts#L352).

`SubstructureRedirectMask` is not passive observation. If another client tries to map or configure a
non-override-redirect child, the server does not perform the operation; it sends this client
`MapRequest`/`ConfigureRequest`. Winding ignores both, so the child remains unmapped/unconfigured. Xlib explicitly
allows an input method to create child windows in the supplied client window, making this relevant to the XIM code in
scope.

`SubstructureNotifyMask` creates a second bug. For child structure events, offset 32 is the parent/event window and
offset 40 is the changed child. The dispatcher resolves only offset 32 at
[`mod.ts:395-397`](packages/winding/x11/mod.ts#L395). It can then report a child `ConfigureNotify` as a resize of the
Winding parent or a child map/unmap as parent visibility.

Replace the broad mask with the exact application events consumed by the dispatcher, plus the exact `XNFilterEvents`
mask. Do not select redirect masks unless their request events are intentionally implemented.

### X11-05 — the public IME cursor area is a standards-level no-op

Severity: **High**

Evidence:

- Style negotiation considers only `XIMPreeditCallbacks`, `XIMPreeditNothing`, and `XIMPreeditNone` composites at
  [`xim.ts:44-51`](packages/winding/x11/xim.ts#L44) and [`xim.ts:450-475`](packages/winding/x11/xim.ts#L450).
- [`xim.ts:347-356`](packages/winding/x11/xim.ts#L347) sets `XNSpotLocation` and `XNArea` for those contexts.
- The shared method promises a candidate-window anchor at [`types.ts:151-154`](packages/winding/types.ts#L151), and the
  README repeats that promise.

The Xlib XIC-values table says:

- `XNSpotLocation` is used only for `XIMPreeditPosition` and ignored for every other preedit style;
- `XNArea` is ignored for callback/nothing/none styles, and for `XIMPreeditPosition` it means the preedit clipping
  region rather than a caret rectangle.

The backend never negotiates `XIMPreeditPosition`, so a conforming input method is required to ignore both values. The
non-null error-name result from `XSetICValues` is also ignored.

There is a genuine capability/design conflict: standard XIM does not guarantee both client-side preedit callbacks and
candidate positioning through `XNSpotLocation`. The backend must either negotiate `PreeditPosition` where positioning is
more important, use a supported IM-specific protocol, or document that candidate positioning cannot be guaranteed on
X11. Passing the tiny caret rectangle as `XNArea` should not be retained if `PreeditPosition` is added; use a real
clipping region or omit it. If a spot is used, the Xlib definition is insertion x and text baseline y, not automatically
bottom-right `(x + width, y + height)`.

### X11-06 — blur cancels JavaScript state but not native composition

Severity: **High**

Evidence:

- [`xim.ts:552-557`](packages/winding/x11/xim.ts#L552) calls `#clearPreedit(true)` on focus loss.
- [`xim.ts:727-739`](packages/winding/x11/xim.ts#L727) deactivation only calls `XUnsetICFocus`.
- The already declared `Xutf8ResetIC` is never called.

`XUnsetICFocus` tells the IM that focus was lost; it does not reset the context. Xlib explicitly permits a later lookup
on an unfocused/refocused XIC to return input composed before focus loss. `XmbResetIC`/`XwcResetIC` (and the UTF-8
variant exposed by libX11) exist to delete pending input and clear native preedit state.

The current public sequence can therefore be:

1. emit an empty preedit that semantically cancels composition;
2. keep the native XIC's pending composition;
3. refocus or perform a later lookup;
4. commit text the application was told had been canceled, or receive incremental draw indexes against an empty local
   buffer.

If blur means cancellation in the shared contract, reset the XIC before/while unsetting focus, discard or explicitly
handle the reset return string, and `XFree` any returned allocation as required by Xlib.

### X11-07 — disposed windows remain native-memory-unsafe

Severity: **High**

Evidence:

- [`X11Window.close`](packages/winding/x11/mod.ts#L237) destroys the XIC, frees the XImage data/structure, frees the GC,
  and queues `XDestroyWindow`.
- [`setTitle`](packages/winding/x11/mod.ts#L157), [`blit`](packages/winding/x11/mod.ts#L182), and
  [`reblit`](packages/winding/x11/mod.ts#L218) do not test `#closed`.

After close:

- `blit` writes through `NativeXImage.pixels`, a `Uint8Array` backed by freed `malloc` memory;
- `reblit` passes a freed `XImage *` to Xlib;
- `setTitle` sends requests to a destroyed Window and can trigger `BadWindow`;
- after `Library.close`, the same methods can additionally call symbols from a closed dynamic-library handle.

This is a real native UAF, even if post-dispose use is caller error. Every public window method should consistently
throw a JavaScript disposed-state error before touching internal state. `NativeXImage.pixels` should not remain
reachable by code paths after close.

### X11-08 — protocol errors and server loss can exit the host process

Severity: **High**

Evidence:

- `XSetErrorHandler`, `XSetIOErrorHandler`, and `XSetIOErrorExitHandler` are declared but never installed.
- [`openWindow`](packages/winding/x11/mod.ts#L76) passes position and dimensions to `XCreateSimpleWindow` before
  `NativeXImage` performs positive-integer validation.
- The constructor flushes at [`mod.ts:111`](packages/winding/x11/mod.ts#L111), delivering asynchronous errors before a
  later TypeScript range check can help.

Xlib documents that its default protocol and fatal-I/O handlers print a message and exit. Concrete paths to that
behavior include:

- zero, negative-after-conversion, fractional, or out-of-range window dimensions;
- the renderer's image/drawable depth mismatch;
- calls through a stale/closed Window;
- `BadAccess` from exclusive event-mask selection;
- ordinary `BadWindow`, `BadDrawable`, or `BadGC` caused by external resource destruction;
- loss of the X server connection.

Validate all representable geometry before the first X request. Install a coordinated X error handler and use
serial-bounded synchronous error traps around operations whose success matters. This needs process-global coordination
because Xlib error handlers are global. Fatal I/O recovery is more constrained, but an embeddable library should at
least define and document its behavior instead of inheriting an unconditional process exit.

### X11-09 — Alt and Meta shortcuts can generate text edits

Severity: **High**

Evidence:

- [`xim.ts:225-269`](packages/winding/x11/xim.ts#L225) accepts lookup text based only on returned content.
- [`mod.ts:455-479`](packages/winding/x11/mod.ts#L455) assigns `text-input` and queues a commit whenever normalized text
  exists; Alt/Meta/accelerator state is not considered.
- `key-default` is documented as the application-owned path for shortcuts in the README.

The active-server probe returned:

| State          | `XLookupString` result for A |
| -------------- | ---------------------------- |
| none           | `"a"`                        |
| Mod1           | `"a"`                        |
| Mod4           | `"a"`                        |
| Control        | byte `0x01`                  |
| Control + Mod1 | byte `0x01`                  |

Control happens to work because `normalizeCommittedText` rejects the C0 byte. Alt and Meta do not modify the printable
lookup, so Alt+A/Meta+A become an IME commit of `"a"` and a `text-input` keydown, preventing normal shortcut behavior
whenever the core fallback is used. An XIC can exhibit the same class of result depending on the IM.

Suppress printable commits owned by unconsumed Alt/Meta/accelerator modifiers unless composition or a correctly detected
AltGraph/group level owns the text. The robust solution is to use XKB consumed-modifier information rather than a
hard-coded modifier rule.

### X11-10 — filtered keys contradict the public observable-key contract

Severity: **High**

Evidence:

- The shared contract says `text-input` and `platform` keydowns remain observable at
  [`types.ts:36-44`](packages/winding/types.ts#L36).
- If `XFilterEvent` returns true, [`mod.ts:411-425`](packages/winding/x11/mod.ts#L411) produces only queued IME events
  or silently continues.
- `filteredKeys` suppresses the corresponding release at [`mod.ts:431-435`](packages/winding/x11/mod.ts#L431).

Xlib correctly requires the native filtered event to be discarded from ordinary X dispatch. That does not resolve
Winding's separate wrapper contract, which promises an observable causative transition with
`editDisposition: "text-input"`. Current X11 behavior can produce preedit/commit events with neither keydown nor keyup.

There is also a snapshot-order bug: `wasComposing` is read only after `XFilterEvent` at
[`mod.ts:450`](packages/winding/x11/mod.ts#L450). A synchronous filter callback can start/end composition for this
event, so `isComposing` no longer describes the state immediately before the native transition as required by
[`types.ts:55-60`](packages/winding/types.ts#L55).

Either revise the cross-platform contract explicitly for filtered XIM keys, or snapshot the raw physical transition and
pre-event composition state before filtering and publish a wrapper-level `text-input` key event without reprocessing the
filtered native event. Synthetic keycode-zero notifications, discussed below, must remain excluded.

### X11-11 — focus mode/detail handling is semantically wrong

Severity: **Medium**

Evidence:

- [`ffi.ts:70-74`](packages/winding/x11/ffi.ts#L70) states that only `NotifyNormal` is a real focus transition.
- [`mod.ts:485-499`](packages/winding/x11/mod.ts#L485) discards every other focus mode and ignores `detail`.

Xlib groups `NotifyNormal` and `NotifyWhileGrabbed` together as real focus moves. `NotifyGrab`/`NotifyUngrab` are the
pseudo-transitions produced when a keyboard grab activates/deactivates. A WM can change focus while it owns a keyboard
grab (for example during an Alt-Tab workflow), so discarding `NotifyWhileGrabbed` can leave:

- the old window marked focused;
- its XIC active;
- pressed and filtered-key caches uncleared;
- no public blur/focus event.

The detail also matters. A `NotifyInferior` transition can mean focus moved between the top-level and a child; treating
that as the whole native window losing focus produces false blur/IME cancellation. Focus events are returned even when
`XimContext.setNativeFocused` detects no state change, so duplicates can also surface.

Accept `NotifyNormal` and `NotifyWhileGrabbed`, interpret detail relative to the top-level/descendant focus policy, and
deduplicate public transitions. Pointer enter/leave has a related lower-severity detail problem: parent/child crossings
can emit leave/enter even while the pointer remains within the top-level bounds promised by the shared type.

### X11-12 — caret callback ignores most required directions

Severity: **Medium**

Evidence:

- [`xim.ts:624-639`](packages/winding/x11/xim.ts#L624) changes and writes back the caret only when direction is
  `XIMAbsolutePosition`.
- `/usr/include/X11/Xlib.h:1311-1319` defines forward/backward character and word, up/down, next/previous line, line
  start/end, absolute, and no-change directions.

The XIM callback contract requires the client to perform the requested move synchronously and write the resulting
character position back into `call_data.position`. Relative navigation currently leaves a stale position and emits a
stale public cursor. Supporting callback style means implementing these directions (within the one-line/preedit model
where possible) or choosing a style whose required callbacks the backend can satisfy.

### X11-13 — XIM style matching is too narrow and has an invalid fallback

Severity: **Medium**

Evidence:

- [`xim.ts:44-51`](packages/winding/x11/xim.ts#L44) defines only three exact composites:
  - PreeditCallbacks + StatusNothing;
  - PreeditNothing + StatusNothing;
  - PreeditNone + StatusNone.
- [`xim.ts:466-475`](packages/winding/x11/xim.ts#L466) rejects other compatible status combinations.

Valid, usable combinations such as PreeditCallbacks + StatusNone, PreeditNothing + StatusNone, and PreeditNone +
StatusNothing are needlessly rejected. If only callback style is available, `none` falls back to that style; the
disabled-context path then calls the simple `XCreateIC` alias without the mandatory callback attributes, so creation
must fail.

Other style edges:

- only the first 64 advertised styles are inspected, although `count_styles` is an unsigned short and ordering is not
  guaranteed;
- Nothing/None contexts are marked “available” and can produce `ime/enabled`, but cannot emit public preedit callbacks
  or accurate `isComposing`, making degraded activation indistinguishable from full semantic support;
- when no UTF-8 locale is detected, callback style is rejected because the decoder assumes callback multibyte text is
  UTF-8. That guard is correct for the decoder, but the fallback behavior should be explicit.

Match preedit and status capabilities independently, never instantiate a callback style without callbacks, scan the
validated advertised list, and expose/document degraded modes.

### X11-14 — XIM keycode zero is treated as a physical key

Severity: **Medium**

The Xlib XIM conventions reserve a `KeyPress` with keycode zero exclusively as a signal that composed input can be
retrieved by lookup. It can be sent by an IM server, inserted by a filter, or created by modifying an event.

The event loop treats it as an ordinary press:

- derives `Unidentified` physical code;
- calls lookup and emits a public keydown;
- stores keycode zero in `PressedLogicalKeyCache`;
- waits for a release that normally never exists.

The next synthetic keycode-zero commit can then be mislabeled as repeat. Handle keycode zero as an XIM lookup/commit
notification only, without physical key publication or pressed-key caching.

### X11-15 — modifier state and mapping do not match the shared DOM-like fields

Severity: **Medium**

Evidence:

- [`mod.ts:42-61`](packages/winding/x11/mod.ts#L42) hard-codes Mod1 as Alt, Mod4 as Meta, and LockMask as Caps Lock.
- [`mod.ts:427-430`](packages/winding/x11/mod.ts#L427) exports the raw `XKeyEvent.state` bits.

X modifier assignment is configurable. Mod1 is not intrinsically Alt, Mod4 is not intrinsically Meta/Super, and Lock can
implement ShiftLock rather than CapsLock. The masks should be derived from the current modifier/XKB map and refreshed on
mapping changes.

Xlib also defines `XKeyEvent.state` as the state immediately before the event. Therefore the modifier key's own
transitions are inverted relative to a current-state DOM-style snapshot: Shift keydown reports `shiftKey: false`, and
Shift keyup reports `shiftKey: true`; Control, Alt, Meta, and AltGraph have the same problem, and lock transitions lag
by one event. Normalize the transition key into the reported snapshot or clarify that fields are pre-transition rather
than DOM-like.

AltGraph detection calls `XkbKeysymToModifiers` without first calling `XkbQueryExtension`/`XkbOpenDisplay`, even though
the XKB specification requires initialization before non-exempt XKB calls. The installed libX11 lazily tolerated this in
the probe, but the backend should query support/version and fall back cleanly if XKB is unavailable.

### X11-16 — physical code assumes an evdev/Xorg convention

Severity: **Medium**

[`packages/winding/linux/dom_code.ts:199-201`](packages/winding/linux/dom_code.ts#L199) defines every X core keycode as
the corresponding evdev code plus eight. Xlib specifies keycode as an arbitrary server representation of a physical key.
The `+8` relationship is common for modern Xorg/Xwayland evdev keymaps; it is not guaranteed for remote servers, legacy
drivers, nested servers, or custom XKB keycode maps.

On such servers, both public `code` and the location derived from it are wrong despite the layout-independent contract.
Query XKB key names/keycode metadata rather than deriving them arithmetically.

### X11-17 — internal Xlib connections cannot make progress

Severity: **Medium**

Xlib may open internal connections to other servers, explicitly including input method servers. Clients that block
inside Xlib's event functions can let Xlib manage them. This backend does not block:
[`mod.ts:389`](packages/winding/x11/mod.ts#L389) polls only `XPending` on the main display connection and returns
`undefined`.

Although `XAddConnectionWatch`, `XInternalConnectionNumbers`, and `XProcessInternalConnection` are declared, none is
used. Data waiting only on an internal IM fd can therefore stall indefinitely even while the application repeatedly
calls `event()`.

Track internal fds and non-blockingly poll/process readable ones on each event pump, or extend the event-loop
integration to expose/wait on both the main display fd and internal connections. `XProcessInternalConnection` must be
called only after poll/select says the fd is readable.

### X11-18 — native size and frame size are not kept coherent

Severity: **Medium**

The shared contract says `blit` dimensions must match the window at
[`types.ts:147-148`](packages/winding/types.ts#L147). X11 does not enforce that:

- `blit` verifies only `rgba.length == width * height * 4` and recreates the image for any supplied dimensions at
  [`mod.ts:182-201`](packages/winding/x11/mod.ts#L182);
- `ConfigureNotify` never updates window geometry; it simply returns a resize event at
  [`mod.ts:592-597`](packages/winding/x11/mod.ts#L592);
- every configure event is labeled resize even if only position, border, stacking, or an unchanged synthetic configure
  changed.

A 1x1 frame is accepted for an 800x600 live window and paints only one pixel/corner. Move-only configure events can
cause unnecessary renderer resize work. Expose repainting uses the last arbitrary image size rather than authoritative
native size.

Maintain separate live-window and image dimensions. Update/deduplicate the former from self `ConfigureNotify`, validate
every blit against it, and use the actual affected `XConfigureEvent.window`, not the generic event/parent field.

### X11-19 — close is buffered rather than complete on return

Severity: **Medium**

[`X11Window.close`](packages/winding/x11/mod.ts#L237) queues `XFreeGC`/`XDestroyWindow` but does not flush. If the
library remains open and the application stops polling after close, the server may retain and display the window until a
later Xlib flush.

The constructor maps and flushes before all fallible local/XIM initialization is complete. Its failure handlers queue
`XDestroyWindow` but do not flush, so allocation or context-creation failure after mapping can leave a visible ghost
even though `openWindow` threw.

Flush after standalone window destruction and after cleanup of a previously flushed map. Prefer completing all fallible
local setup before mapping where possible.

### X11-20 — `OwnerGrabButtonMask` changes implicit capture semantics

Severity: **Medium**

The broad event mask includes `OwnerGrabButtonMask`. X11 automatically grabs the pointer after a selected button press.
With this mask set, that grab uses `owner_events = True`: subsequent motion/release is delivered normally to another
window owned by the same client when applicable, rather than being consistently reported relative to the press window.

With multiple Winding windows, a drag beginning in one and ending over another can therefore deliver down and up to
different windows and break per-window button/capture state. Remove `OwnerGrabButtonMask` unless owner-events behavior
is intentional and the shared contract explicitly models it.

### X11-21 — horizontal core wheel input is lost

Severity: **Medium**

[`mod.ts:570-583`](packages/winding/x11/mod.ts#L570) maps only buttons 4/5 to vertical wheel deltas and discards buttons
6/7. The shared `WheelEvent` already includes `deltaX`. Conventional core X mappings use 6/7 for horizontal scrolling;
map them to negative/positive `deltaX`.

High-resolution/smooth scrolling requires XI2 and is a separate feature gap. Core 6/7 support should still be added.

### X11-22 — external destruction is selected but ignored

Severity: **Medium**

`StructureNotifyMask` selects `DestroyNotify`, but the dispatcher ignores it. If another X client or server-side action
destroys a Winding window, the wrapper remains registered and appears live. Later `blit` or `close` issues requests
against a dead resource, reaching `BadDrawable`/`BadWindow` and normally the process-exiting default handler.

Handle self-window `DestroyNotify` by invalidating the native resource exactly once, removing it from routing, clearing
input state, and emitting the closest shared lifecycle event. Ensure close does not send a second destroy request.

### X11-23 — process-global locale and threading assumptions are unmanaged

Severity: **Medium**

- [`xim.ts:144`](packages/winding/x11/xim.ts#L144) calls process-global `setlocale(LC_CTYPE, "")` and never restores it.
- [`xim.ts:411-447`](packages/winding/x11/xim.ts#L411) repeatedly changes Xlib's locale modifiers and never
  restores/co-ordinates them.
- `XInitThreads` is declared but not called before `XOpenDisplay`.

Multiple `X11Library` instances, unrelated native libraries, or Deno workers can interfere through locale/modifier
state. If multiple threads can call Xlib anywhere in the process, Xlib requires successful `XInitThreads` before any
other Xlib call. JavaScript tasks in one isolate are serialized, but multiple workers or another native component are a
valid embedding scenario.

Define the supported concurrency model. If process-wide Xlib use can be concurrent, initialize threading once before the
first call. Serialize/coordinate locale initialization, avoid repeatedly changing modifiers after XIMs are open, and
document unavoidable process-global effects.

### X11-24 — XIM callback lifetime and constructor rollback edges

Severity: **Medium**

Two related ownership paths are incomplete:

1. `XUnregisterIMInstantiateCallback` return values are ignored at [`xim.ts:390-404`](packages/winding/x11/xim.ts#L390)
   and [`xim.ts:434-443`](packages/winding/x11/xim.ts#L434). The flag is cleared and the `UnsafeCallback` is eventually
   closed even if Xlib says it was not removed. A later native callback would target a freed trampoline. Changing global
   locale modifiers between registration and removal can make matching more fragile.
2. [`xim.ts:179-184`](packages/winding/x11/xim.ts#L179) inserts a new context into `#contexts` before
   `context.recreate()` and does not roll it back if callback allocation/FFI throws. The window constructor destroys the
   X window, but the manager can retain a context referencing that dead ID and recreate it later.

Respect unregister failure by retaining the callback at least until the display is closed, and make context creation
transactional. Similarly, check `XCloseIM`/value-setting results before releasing callback storage on which native code
may still rely.

### X11-25 — preedit publication loses required semantics and recovery

Severity: **Medium**

Several smaller issues combine here:

- Preedit-start immediately publishes empty text at [`xim.ts:579-585`](packages/winding/x11/xim.ts#L579). The README
  defines an empty preedit with null cursor as cancellation, so consumers cannot distinguish start from cancel. Start
  composition internally, but wait for `PreeditDraw` before publishing.
- `XIMText.feedback` is ignored. Callback style requires the client to render per-character converted/selected/highlight
  feedback and visibility hints. The shared event type currently cannot express it, so complex IMs lose clause/selection
  presentation even when text is correct.
- If `applyPreeditChange` rejects a native incremental range at [`xim.ts:611-619`](packages/winding/x11/xim.ts#L611),
  the update is silently ignored without resetting/resynchronizing. Later changes are relative to the IM's updated
  buffer and can remain permanently divergent.
- Only a zero-width caret range is emitted. That is faithful to the explicit XIM caret but cannot substitute for ignored
  feedback selection ranges.

Clarify/extend the public preedit model if callback-style fidelity is required. On malformed/inconsistent incremental
updates, reset the XIC/local composition rather than continuing with known divergent buffers.

### X11-26 — surrounding-text and reconversion are not implemented

Severity: **Low/Medium**

The X11 dispatcher contains a `deleteSurrounding` branch at [`mod.ts:343-347`](packages/winding/x11/mod.ts#L343), but no
X11 code can produce that event. The backend does not register `XNStringConversionCallback`, and the shared API has no
synchronous way to provide surrounding text to an XIM callback.

This prevents XIM context-sensitive conversion and reconversion/substitution features. They are optional in XIM, so this
is not a core conformance failure, but the exposed cross-platform event union suggests support that the X11
implementation does not have. Document it as unsupported or expand the shared request/response contract.

## Raw FFI declaration audit

### FFI-01 — `GC` is an opaque pointer, not an XID-sized integer

Severity: **Medium** (exact mismatch; ABI-compatible on current targets)

The header defines:

```c
typedef struct _XGC *GC;
```

See `/usr/include/X11/Xlib.h:205-218`. The binding describes all 61 `GC` positions across 60 functions as `usize`.
Active paths are:

| Function                | Binding                                                     | Header       |
| ----------------------- | ----------------------------------------------------------- | ------------ |
| `XCreateGC` result      | `usize` at [`ffi.ts:153`](packages/winding/x11/ffi.ts#L153) | `GC` pointer |
| `XPutImage` GC argument | `usize` at [`ffi.ts:453`](packages/winding/x11/ffi.ts#L453) | `GC` pointer |
| `XFreeGC` GC argument   | `usize` at [`ffi.ts:286`](packages/winding/x11/ffi.ts#L286) | `GC` pointer |

The same mismatch occurs in all draw/fill/GC setter functions, `XDefaultGC*`, `XCopyGC`, `XFlushGC`, `XGContextFromGC`,
and the multibyte/wide/UTF-8 draw functions.

On x86-64 and AArch64, a pointer and `usize` have the same width and integer ABI class, so the bigint round trip works.
It is still not the API's type: null is `0n` rather than `null`, TypeScript cannot enforce pointer use, and
capability/pointer-authentication-oriented ABIs need not permit this representation. Use Deno `pointer` and retain a
`Deno.PointerObject`. `GContext`, in contrast, really is an integer XID.

### FFI-02 — five `KeyCode` positions have the wrong width

Severity: **Low** on this host

`KeyCode` is `unsigned char` in `/usr/include/X11/X.h:108`. Linux sets narrow prototypes (`NeedWidePrototypes == 0`) in
`/usr/include/X11/Xfuncproto.h:51-64`.

| Descriptor                                                                        | Current | Installed prototype |
| --------------------------------------------------------------------------------- | ------- | ------------------- |
| `XDeleteModifiermapEntry` arg 2, [`ffi.ts:209`](packages/winding/x11/ffi.ts#L209) | `u32`   | `KeyCode` / `u8`    |
| `XGetKeyboardMapping` arg 2, [`ffi.ts:327`](packages/winding/x11/ffi.ts#L327)     | `u32`   | `KeyCode` / `u8`    |
| `XInsertModifiermapEntry` arg 2, [`ffi.ts:378`](packages/winding/x11/ffi.ts#L378) | `u32`   | `KeyCode` / `u8`    |
| `XKeycodeToKeysym` arg 2, [`ffi.ts:383`](packages/winding/x11/ffi.ts#L383)        | `u32`   | `KeyCode` / `u8`    |
| `XKeysymToKeycode` result, [`ffi.ts:384`](packages/winding/x11/ffi.ts#L384)       | `u32`   | `KeyCode` / `u8`    |

Valid core keycodes fit in one byte, and the current ABIs preserve the relevant low byte. The installed return
implementation zero-extends, so no current failure was reproduced. These remain real source/FFI type mismatches; use
`u8` for the supported narrow-prototype targets.

The event structure's `XKeyEvent.keycode` is `unsigned int`, so the existing 32-bit event read at offset 84 is correct.
Likewise, reading `XButtonEvent.button` with `getInt32` instead of `getUint32` is a nominal signedness mismatch only;
valid button values are small.

### FFI-03 — the oversized declaration table raises the minimum libX11 version

Severity: **Medium**

`x11functions` has 403 keys but only 51 are referenced anywhere outside `ffi.ts` (including smoke-test-only references).
Deno registers/resolves the entire interface during `Deno.dlopen`, so any missing unused symbol prevents the backend
from loading.

The concrete current example is unused `XSetIOErrorExitHandler` at [`ffi.ts:545`](packages/winding/x11/ffi.ts#L545). The
installed X11 changelog records it as added by commit `9f9c536...` for libX11 1.7.0. A system with otherwise
ABI-compatible libX11 1.6.x therefore cannot open this backend solely because an unused symbol is in the descriptor.

Reduce the descriptor to production-used symbols. Put optional/versioned APIs in a separately opened interface or
resolve them through a small compatibility shim.

### FFI-04 — the implementation is silently LP64, little-endian, and glibc-specific

Severity: **Medium**

All 52 fixed `u64`/`i64` slots in `ffi.ts` correspond to C `unsigned long`/`long`. That is correct in width on LP64, but
wrong on ILP32 where Xlib `long` is four bytes. `usize`/`isize` should be used for client-side Xlib longs if 32-bit
support is intended.

The manually decoded layout diverges correspondingly:

| Item                                   | Current LP64 host | i386 C ABI |
| -------------------------------------- | ----------------: | ---------: |
| `sizeof(XEvent)`                       |               192 |         96 |
| `Screen.root`                          |                16 |          8 |
| `Screen.white_pixel` / `black_pixel`   |           88 / 96 |    52 / 56 |
| `XKeyEvent.window`                     |                32 |         16 |
| `XKeyEvent.time`                       |                56 |         28 |
| `XKeyEvent.state` / `keycode`          |           80 / 84 |    48 / 52 |
| `XIMStyles.supported_styles`           |                 8 |          4 |
| `sizeof(XIMCallback)`                  |                16 |          8 |
| `XIMText.encoding_is_wchar` / `string` |           16 / 24 |     8 / 12 |
| `sizeof(XIMText)`                      |                32 |         16 |
| `XIMPreeditDraw.text`                  |                16 |         12 |

Explicit little-endian `DataView` operations appear throughout `mod.ts`, `input.ts`, `xim_abi.ts`, and the smoke test.
Xlib structs use native byte order, so big-endian LP64 would also be decoded/packed incorrectly. AArch64 little-endian
LP64 layout matches the current x86-64 layout, but the fixed-varargs calling path still deserves an architecture smoke
test.

The dynamic library name `libc.so.6` at [`mod.ts:295`](packages/winding/x11/mod.ts#L295) makes the backend
glibc-specific. A musl Linux system can have a valid `libX11.so.6` but no `libc.so.6`. The top-level loader routes every
non-Windows/non-Darwin platform to Wayland-or-X11, so non-Linux Unix targets can also reach Linux library names and the
locally assumed `LC_CTYPE == 0`.

Either enforce and document `linux + glibc + little-endian LP64` with an early, clear guard, or replace
widths/layouts/library names with platform-derived equivalents and test each supported target.

### FFI-05 — XIM varargs are represented as fixed functions

Severity: **Low/Medium**

The aliases at [`ffi.ts:162-181`](packages/winding/x11/ffi.ts#L162),
[`ffi.ts:275-284`](packages/winding/x11/ffi.ts#L275), [`ffi.ts:534-542`](packages/winding/x11/ffi.ts#L534), and
[`ffi.ts:644-664`](packages/winding/x11/ffi.ts#L644) bind C variadic symbols as several fixed signatures because Deno
has no variadic descriptor.

The actual shapes used here were checked and are correct for the current all-GPR LP64 calls:

- `XIMStyle` and Window values occupy unsigned-long slots;
- names/nested lists/output destinations are pointers;
- callback and geometry records are passed by address;
- every call supplies the terminating null pointer;
- no floating-point or by-value aggregate vararg is present.

There is no attribute/value ordering error in the current calls. The residual concern is calling-convention portability:
the descriptor tells the FFI engine the function is non-variadic even though the callee uses `va_start`. Keep these
aliases isolated and test them on every supported ABI. A tiny compiled C shim with non-variadic wrapper functions would
make the contract exact and also centralize native struct packing.

### FFI-06 — `Screen` is manually decoded despite being opaque

Severity: **Low** on the installed ABI

[`mod.ts:77-80`](packages/winding/x11/mod.ts#L77) reads root, white pixel, and black pixel from hard-coded `Screen`
offsets. Those offsets are correct on this host, but `/usr/include/X11/Xlib.h:245-248` explicitly says the
implementation-dependent `Screen` contents should be treated as opaque.

The binding already exposes `XRootWindowOfScreen`, `XWhitePixelOfScreen`, `XBlackPixelOfScreen`,
`XDefaultVisualOfScreen`, and `XDefaultDepthOfScreen`. Use them. This removes several architecture offsets and fixes the
screen-0 visual bug at the same time.

### What was verified correct

The audit found no mismatch in:

- all `XEventType` values against `/usr/include/X11/X.h:181-215`;
- all `XEventMask` values against `/usr/include/X11/X.h:150-175`;
- `NotifyNormal`, XIM style/status/caret constants, and `LC_CTYPE` on this installed libc;
- `free`, `malloc`, `memcpy`, and `setlocale` descriptors;
- ordinary non-variadic function arity/ABI categories, apart from `GC` and `KeyCode` typing described above;
- current callback record ordering and callback signatures;
- current XIM nested-list attribute/value/null ordering;
- current LP64 event/XIM layout offsets listed below.

The `ffi.ts` comment saying all declarations come from `Xlib.h` is slightly inaccurate: `XDestroyImage` and
`XLookupString` are declared by `Xutil.h`, while `XkbKeysymToModifiers` is from `XKBlib.h`. `XDestroyImage` is normally
a macro, but the installed library exports the function trampoline used by the binding.

## Confirmed LP64 structure layout

These values match both the TypeScript offsets and the installed C headers:

| Structure/member                              | Size or offset |
| --------------------------------------------- | -------------: |
| `sizeof(long)` / `sizeof(void *)`             |          8 / 8 |
| `sizeof(XEvent)`                              |            192 |
| `sizeof(XKeyEvent)`                           |             96 |
| `Screen.root`                                 |             16 |
| `Screen.root_depth` / `root_visual`           |        56 / 64 |
| `Screen.white_pixel` / `black_pixel`          |        88 / 96 |
| `XAnyEvent.window`                            |             32 |
| `XKeyEvent.time`                              |             56 |
| `XKeyEvent.state` / `keycode`                 |        80 / 84 |
| `XFocusChangeEvent.mode`                      |             40 |
| `XCrossingEvent.mode` / `detail`              |        80 / 84 |
| `XConfigureEvent.event` / `window`            |        32 / 40 |
| `XConfigureEvent.width` / `height`            |        56 / 60 |
| `XClientMessageEvent.message_type` / `data`   |        40 / 56 |
| `sizeof(XIMStyles)` / styles pointer          |         16 / 8 |
| `sizeof(XIMCallback)` / callback pointer      |         16 / 8 |
| `sizeof(XIMText)`                             |             32 |
| `XIMText.encoding_is_wchar` / string union    |        16 / 24 |
| `sizeof(XIMPreeditDrawCallbackStruct)` / text |        24 / 16 |
| `sizeof(XIMPreeditCaretCallbackStruct)`       |             12 |
| `sizeof(XPoint)` / `sizeof(XRectangle)`       |          4 / 8 |
| `sizeof(wchar_t)`                             |              4 |

This is useful positive evidence: on the intended little-endian LP64 layout, the current event offsets, XIM callback
fields, `XPoint`, and `XRectangle` packers are internally consistent. The problem is the absence of a platform guard and
the use of those values as if X11 itself guaranteed them.

## Smaller edge cases

### X11-27 — event validation, repeat, and state edges

Severity: **Low**, except where compounded by earlier findings

- WM_DELETE handling at [`mod.ts:598-605`](packages/winding/x11/mod.ts#L598) checks `message_type` and `data.l[0]` but
  not `format == 32`. A malformed/synthetic ClientMessage using the same atoms can trigger close. Other X clients are
  already mutually untrusted, so this is hardening rather than a security boundary.
- The legacy repeat heuristic at [`input.ts:31-39`](packages/winding/x11/input.ts#L31) treats any adjacent release/press
  with equal window, millisecond timestamp, and keycode as repeat. Very fast or synthetic same-time transitions
  (especially timestamp zero) can lose a real keyup. XKB detectable auto-repeat is cleaner where available.
- If filtering behavior changes while a key is held, `filteredKeys` can suppress only one side or turn a later press
  into a fresh press. Correct all-event filtering and an explicit physical-transition state machine would make this
  easier to reason about.
- Every `MapNotify`/`UnmapNotify` becomes visibility true/false, including initial map, duplicate notifications, and
  currently child notifications. The shared type describes minimized/restored state; track/deduplicate self-window
  state.
- `VisibilityChangeMask` is selected but `VisibilityNotify` is discarded, creating traffic with no behavior.
- The image allocation validates only JavaScript safe integer size. If `malloc` succeeds but V8 cannot create a
  typed-array view of an extremely large allocation, construction throws before freeing `data`. Add a practical maximum
  and a `try/finally` around view creation.
- `XSetWMProtocols`' failure result is ignored. If WM_DELETE registration fails, a WM may use a more destructive close
  policy. Check it before mapping.
- Very large titles can exceed X request limits and reach the default error handler; embedded NUL produces different
  `_NET_WM_NAME` and `XStoreName` interpretations. Bound/normalize title input if hostile strings are in scope.

## Testing gaps and recommended additions

The existing pure tests validate useful helper behavior, and the smoke test verifies a basic screen-0 Xvfb path. It does
not exercise the invariants that fail above.

Add the following in priority order.

### Native ABI gate

- Generate/compile a tiny C helper in CI that exports `sizeof`/`offsetof` values and non-variadic XIM wrappers.
- Assert the runtime ABI/endian/data model before direct decoding.
- Test x86-64 and AArch64 explicitly; either test i386/big-endian or reject them clearly.
- Check only the production symbol set against the oldest supported libX11.

### Rendering matrix

- First `Expose` before any user blit; assert deterministic initialized pixels.
- Depth 16, 24, 30, and 32 X servers/visuals where Xvfb/Xephyr supports them.
- A nonzero default screen (`DISPLAY=:N.1`) with different screen formats.
- Widths whose scanlines expose padding assumptions.
- Alternate color masks/byte order through a shim/unit-tested pixel packer.
- Blit dimensions different from the live configured window; require a JavaScript error.
- Blit/setTitle/reblit after Window and Library disposal; require a JavaScript error without native access.

### XIM integration

- A real server-backed XIM transport, not only local fallback.
- Non-key `ClientMessage`, `PropertyNotify`, and preedit-window events offered to `XFilterEvent`.
- Preferred IM unavailable at startup, later instantiate, destroy, and restart.
- Callback style with multibyte and wide `XIMText`.
- Every caret direction and synchronous position write-back.
- Blur/cancel/refocus proving no stale commit and no incremental-buffer divergence.
- Synthetic keycode-zero commit notification.
- Every compatible preedit/status style combination.
- Candidate positioning test, with expected capability/degradation documented.
- More than 64 advertised styles or removal of that semantic cap.

### Input/event semantics

- XIM-filtered keys against the public keydown/keyup contract.
- `isComposing` snapshot before filter callbacks.
- Alt+A, Meta+A, Control+A, and AltGraph text on several layouts.
- Modifier key self-transition snapshots and remapped Alt/Meta/Lock.
- A custom/non-evdev XKB keycode map.
- `NotifyWhileGrabbed`, `NotifyGrab`, `NotifyUngrab`, and child-focus details.
- Parent/child configure/map/unmap/crossing events.
- Multi-window pointer drag/capture with and without `OwnerGrabButtonMask`.
- Horizontal buttons 6/7.
- Move-only versus size-changing `ConfigureNotify`.
- External `DestroyNotify`.
- Zero, negative, fractional, huge, and out-of-range geometry without process exit.

### Teardown and integration

- `Window.close()` with no subsequent event polling; assert the server window is gone.
- Failure after map but before constructor completion; assert no ghost window/context.
- Failed IM instantiate-callback unregister; assert callback storage remains valid.
- Two libraries and worker-thread/concurrent Xlib initialization if that use is supported.
- An internal XIM connection whose fd becomes readable while the main X socket does not.

## Recommended fix sequence

1. **Remove immediate native hazards:** initialize pixels, guard all disposed methods, validate geometry before X calls,
   flush teardown, and define X error handling.
2. **Make rendering visual-correct:** use the actual default screen/depth/visual and returned XImage layout.
3. **Repair event ownership:** select only consumed masks, remove redirect/owner-grab masks, route structure events by
   the affected window, and handle destruction.
4. **Repair XIM dispatch/state:** filter every event, process internal connections, reset on cancellation, recognize
   keycode zero, and make callback/style ownership coherent.
5. **Resolve public semantic conflicts:** filtered key observability, candidate-position capability, degraded IME
   activation, modifier snapshots, and preedit feedback.
6. **Fix keyboard behavior:** prevent Alt/Meta commits, derive modifier masks, and replace the evdev+8 assumption with
   XKB key metadata.
7. **Tighten the FFI surface:** pointer-correct `GC`, narrow `KeyCode`, `usize`/`isize` for C long where portable,
   production-only symbols, accessor functions instead of `Screen` offsets, and preferably a small compiled shim for
   variadic XIM/layout-sensitive operations.
8. **State or broaden the platform contract:** either enforce Linux/glibc/little-endian LP64 up front or implement and
   test the missing libc/data-model/endian variants.

## Bottom line

On this host, the raw LP64 declarations and offsets are mostly sound and the common 24-depth renderer format happens to
match. That positive result should not obscure the runtime issues: XIM event flow is not used according to its contract,
candidate positioning is not implemented by the negotiated styles, broad event selection changes server behavior,
rendering assumes non-guaranteed visual properties, and normal errors/disposal can cross into process exit or native
UAF.

The safest architectural direction is a deliberately small binding plus a small native compatibility shim for XIM
varargs and image/struct details. Even without a shim, the backend can be made robust by narrowing masks/symbols, using
Xlib accessors, validating and trapping errors, respecting every-event XIM filtering, and keeping explicit native state
for focus, geometry, capture, and disposal.
