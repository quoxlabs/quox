# Wayland bindings and backend review

Review date: 2026-07-10

Repository revision: `a48ca1647f006b6bda5c1a7373475c3588c92e9c`

Upstream revisions used:

- Wayland/libwayland: `c23a8beb1ff41428e841137175c6be738ab627be`
- wayland-protocols: `afb614d5fcbd02d261a6ae91920aa91cf3915a8a`

## Executive summary

The Wayland backend is not protocol-safe in its current form. The most serious problem is the presentation path: every
same-sized `blit()` rewrites the one SHM allocation even if the compositor has not released it. That violates a core
Wayland lifetime rule and makes the displayed contents undefined. The backend needs a release-aware buffer pool before
it can reliably render more than one frame.

The hand-built extension metadata is also incomplete. Several messages with `new_id` or object arguments have a null
`wl_message.types` pointer. Normal execution often works because the return interface is passed separately to
`wl_proxy_marshal_array_flags`, but libwayland's standard `WAYLAND_DEBUG` printer dereferences the missing table.
Ordinary window construction can therefore segfault merely because protocol logging is enabled.

The next largest correctness issue is configure handling. XDG role state, configure serials, public resize events, and
rendered buffers are not retained as one generation. An old-size frame can acknowledge a newer maximized configure and
cause a fatal `invalid_surface_state` error. The constructor can hit this on the first frame, and the current
asynchronous Quox renderer makes the later-generation race reachable too.

Other confirmed problems include an invalid version-dependent `wl_surface.damage_buffer` request, silent
compositor-disconnect/protocol-error handling, permanently inert pointers after capability loss, no cursor fallback when
the optional cursor-shape protocol is absent, incorrect text-input-v3 preedit batching, and several cross-platform
semantic mismatches around visibility, wheel units, initial mapping, and IME activation.

The raw request opcodes, explicit listener signatures, libwayland function declarations, XKB declarations, and the
version-1 text-input wire definitions are otherwise mostly accurate. The report includes a dedicated section for
behavior that was checked and found correct.

### Priority overview

| ID     | Severity                | Finding                                                                                      |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| WL-01  | Critical                | The sole SHM buffer is rewritten before `wl_buffer.release`                                  |
| WL-02  | High                    | Missing `wl_message.types` tables can segfault with `WAYLAND_DEBUG`                          |
| WL-03  | High                    | XDG configure state/serials are decoupled from rendered buffers                              |
| WL-04  | High                    | Display, roundtrip, read, dispatch, and flush errors are ignored                             |
| WL-05  | High                    | `damage_buffer` is sent to surfaces whose version may be below 4                             |
| WL-06  | High                    | Pointer capability loss leaves an object that cannot work after re-add                       |
| WL-07  | High                    | No core cursor fallback exists when cursor-shape-v1 is unavailable                           |
| WL-08  | High                    | text-input-v3 can leave stale preedit visible after `done`                                   |
| WL-08a | High integration impact | The current shared consumer accepts but does not apply delete-surrounding edits              |
| WL-09  | Medium-high             | Registry removal, replacement, late globals, and multiple seats are mishandled               |
| WL-10  | Medium-high             | text-input-v3 serial synchronization is computed but not enforced                            |
| WL-11  | High-risk design issue  | A sent `enable` is treated as proof that native text input owns every printable key          |
| WL-12  | Medium                  | Pointer frame, coordinates, fixed-point precision, and wheel units are lost                  |
| WL-13  | Medium                  | Keyboard-enter state is ignored and modifier-key snapshots are stale                         |
| WL-14  | Medium                  | RGBA alpha association does not match Wayland's required premultiplication                   |
| WL-15  | Medium                  | Initial mapping, dimensions, positioning, and visibility do not match the shared API cleanly |
| WL-16  | Medium-low              | SHM formats and protocol-sized integer limits are not validated                              |
| WL-17  | Medium-low              | Partial library initialization is not unwound on failure                                     |
| WL-18  | Low/latent              | Cursor-shape manager metadata omits a version-1 request                                      |
| WL-19  | Low/portability         | `poll` and several hand-packed native layouts are not ABI-portable                           |
| WL-20  | Capability/portability  | Loading is glibc-specific and ignores some valid Wayland launch modes                        |
| WL-21  | Capability gaps         | HiDPI, decorations, app identity, and presentation pacing are absent                         |

## Scope and method

The primary scope was every file under `packages/winding/wayland`, plus the shared interface in
`packages/winding/types.ts`, the backend selector in `packages/winding/mod.ts`, and direct Quox call sites only where
they establish that a Wayland/backend contract race is reachable. Other native backends were not reviewed.

The protocol XML was fetched from the official upstream repositories because the extension definitions were not
available in this checkout:

- [Wayland core protocol](https://gitlab.freedesktop.org/wayland/wayland/-/blob/c23a8beb1ff41428e841137175c6be738ab627be/protocol/wayland.xml)
- [Stable xdg-shell](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/afb614d5fcbd02d261a6ae91920aa91cf3915a8a/stable/xdg-shell/xdg-shell.xml)
- [Staging cursor-shape-v1](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/afb614d5fcbd02d261a6ae91920aa91cf3915a8a/staging/cursor-shape/cursor-shape-v1.xml)
- [Unstable text-input-v3](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/afb614d5fcbd02d261a6ae91920aa91cf3915a8a/unstable/text-input/text-input-unstable-v3.xml)
- [Official libwayland client API](https://wayland.freedesktop.org/docs/html/apb.html)
- [Reviewed libwayland `connection.c`](https://gitlab.freedesktop.org/wayland/wayland/-/blob/c23a8beb1ff41428e841137175c6be738ab627be/src/connection.c)
- [Reviewed libwayland client implementation](https://gitlab.freedesktop.org/wayland/wayland/-/blob/c23a8beb1ff41428e841137175c6be738ab627be/src/wayland-client.c)
- [libxkbcommon keyboard-state API](https://xkbcommon.org/doc/current/group__state.html)

I generated private C protocol metadata from all four XML files with `wayland-scanner`, compiled the generated metadata
with `cc -fsyntax-only`, and compared its interface versions, method/event counts, signatures, type tables, and opcodes
to `ffi.ts`. I then checked each marshal call and listener callback against that metadata and traced lifecycle/state use
through the backend.

This machine does not have `deno`, Weston, Cage, or another headless Wayland compositor installed, so the TypeScript
unit suite and native smoke test could not be executed. Findings described as confirmed below follow directly from the
protocol and code. WL-11 is explicitly labeled as a high-risk design issue because its final user-visible failure mode
depends on compositor/input-method behavior and deserves native matrix testing.

## Binding conformance summary

| Interface/API                                |         Upstream current version |                 Version used here | Result                                                                                            |
| -------------------------------------------- | -------------------------------: | --------------------------------: | ------------------------------------------------------------------------------------------------- |
| Core Wayland interfaces                      | Loaded from installed libwayland | compositor <= 4, SHM 1, seat <= 5 | Core opcodes are correct; one request is not version-gated                                        |
| `xdg_wm_base`, `xdg_surface`, `xdg_toplevel` |                                7 |                                 7 | Names, order, signatures, nullability, and `since` prefixes match; `types` metadata is incomplete |
| cursor-shape-v1 manager/device               |                                2 |                                 1 | Binding v1 is legal; `get_pointer` types are missing and a v1 manager request is omitted          |
| text-input-v3 manager/input                  |                                2 |                                 1 | Binding v1 is legal; v1 wire order/signatures and used object types match                         |
| libwayland-client functions                  |                      Current ABI |                               N/A | Declared signatures match                                                                         |
| libxkbcommon functions                       |                      Current ABI |                               N/A | Declared signatures are ABI-compatible                                                            |
| libc helpers                                 |                       glibc LP64 |                               N/A | `poll` uses `u32` where `nfds_t` is `unsigned long`/`usize`                                       |

Using version 1 of cursor-shape-v1 and text-input-v3 is not itself an error. Both protocols currently advertise version
2, but a client may deliberately bind an older supported version. The report only flags definitions that are wrong even
for the chosen version, and functionality that is missing because the downgrade or the public API cannot represent it.

## Detailed findings

### WL-01 — Critical: committed SHM storage is overwritten before release

Local evidence:

- `packages/winding/wayland/shm_buffer.ts:27-57` owns one `wl_buffer`, mapping, and fd and rewrites the mapping on every
  same-size call.
- `packages/winding/wayland/shm_buffer.ts:96-104` creates that buffer but never adds a `wl_buffer.release` listener.
- `packages/winding/wayland/window.ts:211-242` attaches and commits the same object on each `blit()`.

After a committed attachment, the compositor is allowed to read the pixels at any time until it sends
`wl_buffer.release`. Only after that event may the client reuse the buffer or its backing storage. The second same-sized
`blit()` writes directly into storage that may still be scanned out or copied by the compositor.

A minimal failure sequence is:

1. `blit(frameA, 800, 600)` writes, attaches, and commits the buffer.
2. The compositor keeps the buffer busy for presentation.
3. Before a release event, `blit(frameB, 800, 600)` overwrites the same mapping.
4. The compositor observes a mixture of A and B, or B where A was promised.

This is not just a missed optimization. The protocol makes the content undefined. Direct scanout, slow compositors, and
a producer rendering faster than refresh make corruption or tearing more likely. The backend does not use frame
callbacks either, so nothing naturally throttles this sequence.

The fix should be a bounded pool of at least two buffers. Each buffer needs a release listener and a busy flag. `blit()`
may write only a free buffer; when all are busy it must either retain/drop the latest frame, allocate within a defined
bound, or expose backpressure. A `wl_surface.frame` callback should be added for presentation pacing, but it is not a
substitute for release-based storage ownership.

The resize and close paths destroy an old `wl_buffer` before release. That is not reported as a separate violation here:
the current core specification allows early object destruction as long as the underlying storage is not subsequently
reused or mutated. This implementation creates a new memfd on a size change and does not mutate the old one. The
same-size rewrite is the real violation.

### WL-02 — High: incomplete `wl_message.types` can crash protocol logging

Local evidence:

- `packages/winding/wayland/ffi.ts:72-89` makes a message's type array optional and stores a null `wl_message.types`
  pointer when it is absent.
- Nearly all xdg-shell request definitions at `ffi.ts:121-166` omit it.
- `wp_cursor_shape_manager_v1.get_pointer` at `ffi.ts:168-173` omits it too.

Generated protocol metadata contains one type-table entry for every argument, using null entries for primitive
arguments. Examples used by this backend are:

| Message                                                      | Required per-argument types               |
| ------------------------------------------------------------ | ----------------------------------------- |
| `xdg_wm_base.get_xdg_surface(new_id, wl_surface)`            | `xdg_surface`, `wl_surface`               |
| `xdg_surface.get_toplevel(new_id)`                           | `xdg_toplevel`                            |
| `wp_cursor_shape_manager_v1.get_pointer(new_id, wl_pointer)` | `wp_cursor_shape_device_v1`, `wl_pointer` |

Normal execution often survives because the call separately passes the return interface to
`wl_proxy_marshal_array_flags`, so libwayland can allocate the new proxy without consulting `message->types`.

The standard debug path is different. For a `new_id` argument, `wl_closure_print()` evaluates
`closure->message->types[i]` to print the new object's interface. It checks whether the array element is null, but first
indexes the array; if the `types` pointer itself is null, this dereferences address zero. With `WAYLAND_DEBUG=1` or
`WAYLAND_DEBUG=client`, the first used xdg constructor can therefore segfault during ordinary window creation. The
cursor constructor has the same defect.

The omitted metadata also covers currently unused but declared object-bearing methods such as `create_positioner`,
`get_popup`, `set_parent`, `show_window_menu`, `move`, `resize`, and `set_fullscreen`. That makes the declared
interfaces structurally different from scanner output even outside the immediate crash path.

The safest fix is to stop maintaining native protocol structs by hand. Generate the protocol C data and expose it
through a tiny native shim, or generate a checked data asset as part of the package. If the JavaScript builder remains,
it needs a two-pass allocation/backpatch scheme so mutually referring interfaces can have complete type arrays, plus a
test that byte-compares all method/event metadata against `wayland-scanner` output.

### WL-03 — High: configure state, serials, events, and rendered frames are not one generation

Local evidence:

- `packages/winding/wayland/window.ts:125-129` keeps only the latest `xdg_surface.configure` serial.
- `window.ts:138-149` immediately emits resize and visibility events from `xdg_toplevel.configure` instead of staging
  role state until the ending `xdg_surface.configure`.
- `window.ts:167-180` acknowledges whichever serial is currently newest.
- `window.ts:211-241` commits any dimensions supplied by the caller, with no association to the acknowledged configure.
- `window.ts:103-105` acknowledges the initial configure before the caller can consume the resize queued during the
  constructor roundtrip.

An xdg configure sequence consists of role events followed by one `xdg_surface.configure`. The ending event latches the
role state as an atomic configuration. A client may discard older complete sequences, but the content it commits in
response to a serial must correspond to that sequence.

The backend can currently do this:

1. Receive A: `800x600`, normal state, serial A; enqueue resize A.
2. Receive B: `1920x1080`, maximized state, serial B; enqueue resize B and retain only serial B.
3. The caller consumes resize A and renders `800x600`.
4. `blit()` acknowledges B and commits the A-sized buffer.

For maximized state, xdg-shell says the configured window geometry must be obeyed; otherwise the compositor may raise
`xdg_wm_base.invalid_surface_state`. Less strict configurations still produce stale sizing and visible resize glitches.

The initial frame has the same problem. `WaylandWindow` completes the bufferless configure handshake and sets
`#configured` before returning, while the public resize event remains queued. The current Quox code creates its renderer
at the requested dimensions and does not start event polling until later (`packages/quox/dom/window.ts:123-164`). A
tiled/maximized initial configure can therefore be acknowledged and then answered with the requested, not configured,
size.

There is also a later asynchronous generation race. Quox captures `renderWidth`/`renderHeight` before awaiting the
renderer and then blits those captured values (`packages/quox/dom/window.ts:225-244`). A configure arriving during the
await updates the renderer and the Wayland serial, but the completed old-size raster can still acknowledge/commit
against the new serial.

The backend should stage the latest role fields until the ending `xdg_surface.configure`, then retain a complete record
such as `{ serial, width, height, states, generation }`. Public resize/visibility changes should be emitted only from
complete records. Rendering must carry the generation it started for, and `blit()` must never acknowledge a serial with
a raster from another generation. Coalescing older complete records is allowed.

### WL-04 — High: fatal display and protocol failures become silent hangs

Local evidence:

- `packages/winding/wayland/mod.ts:197` and `mod.ts:321` ignore initialization roundtrip results.
- `packages/winding/wayland/window.ts:103` ignores its window roundtrip result.
- `mod.ts:468-493` ignores `wl_display_flush`, `poll`, `wl_display_read_events`, and `wl_display_dispatch_pending`
  failures.
- Flushes in `window.ts:194,242` and `text_input_controller.ts:99-105,
  239-270` are likewise unchecked.
- The FFI exposes neither `wl_display_get_error` nor `wl_display_get_protocol_error`.

Libwayland reports failures from roundtrip, read, and dispatch with `-1`. Protocol errors and compositor disconnects
make the display unusable. The current pump can see `POLLHUP` or `POLLERR`, cancel the prepared read because it checks
only `POLLIN`, ignore a failed dispatch, and return `undefined` forever. A failed constructor roundtrip can also leave a
nominal object whose server-side setup never completed.

`wl_display_flush` needs separate handling. It is non-blocking and may return `-1` with `EAGAIN`; the correct response
is to include `POLLOUT` until the buffer drains. The pollfd is permanently configured only for `POLLIN`, so
backpressured requests depend on callers repeatedly spinning `event()` and are not integrated into readiness correctly.

Add the display error APIs and a central connection state. Check every roundtrip/read/dispatch result; inspect
`POLLERR`, `POLLHUP`, and `POLLNVAL`; and handle flush `EAGAIN` through writable readiness. Once a fatal display error
occurs, make `event()`, `openWindow()`, and mutating window methods fail deterministically rather than returning no
events indefinitely.

### WL-05 — High: `damage_buffer` is not gated by the surface version

Local evidence:

- `packages/winding/wayland/mod.ts:206-209` binds a compositor at `min(offered, 4)`, including valid versions 1
  through 3.
- `packages/winding/wayland/window.ts:226-233` always sends opcode 9, `wl_surface.damage_buffer`.
- `packages/winding/wayland/ffi.ts:243-245` already defines the older `wl_surface.damage` opcode but never uses it.

`damage_buffer` exists only since `wl_surface` version 4. On a surface inherited from a compositor bound at versions
1-3, opcode 9 is an invalid method and may terminate the client with a fatal display error.

Use `wl_proxy_get_version(surface)` to select `damage_buffer` at version 4 or newer and `damage` below version 4, or
reject compositors below a clearly documented minimum. The existing bind logic implies that the intended behavior is
compatibility, so the fallback is preferable.

### WL-06 — High: pointer capability removal is not symmetric with acquisition

Local evidence:

- `packages/winding/wayland/mod.ts:296-305` creates a pointer when the seat gains the capability and releases a keyboard
  when keyboard capability disappears.
- There is no corresponding pointer-removal branch.
- Pointer and cursor-device cleanup happens only during whole-library shutdown at `mod.ts:513-562`.

The core protocol says clients should destroy pointer objects when the capability is removed. More importantly, a
version-5-or-newer pointer created before the most recent capability-add event must not resume sending events if the
capability later returns.

Here, `#pointer` remains non-null after removal, so a later capability-add event does not call `#initPointer()`. The old
pointer and its cursor-shape device are inert forever. Pointer focus may remain set too, leaving hover/button state
stale.

On removal, destroy the cursor-shape device, version-correctly release the pointer, clear focus and accumulated
pointer-frame state, and decide whether a synthetic public leave/reset is required. A later add must create both objects
fresh.

### WL-07 — High: cursor-shape-v1 is treated as mandatory even though it is optional

Local evidence:

- `packages/winding/wayland/mod.ts:257-268` silently returns when no cursor-shape device exists.
- The pointer-enter callback at `mod.ts:350-359` invokes only that helper.
- No `wl_pointer.set_cursor`, cursor surface, theme, or SHM cursor fallback is implemented.

The core pointer protocol makes the pointer image undefined on enter and tells the client to set an appropriate image.
cursor-shape-v1 is an optional staging extension offering an alternative mechanism, not a replacement that every
compositor must advertise.

On a conforming compositor without the extension, the application may have no cursor or an arbitrary/stale cursor.
Implement the core cursor path, normally using a cursor theme and a dedicated `wl_surface`, and prefer cursor-shape-v1
only when available. If the cursor-shape manager appears after pointer setup, the backend should also create a device
for the already-live pointer.

### WL-08 — High: `done` does not reliably clear the previous preedit

Local evidence:

- `packages/winding/wayland/text_input.ts:24-29` tracks whether a preedit is visible.
- `text_input.ts:60-77` clears it only when an explicitly pending preedit is empty and no nonempty commit is pending.
- `text_input.ts:52-54` collapses null, empty, and filtered commit strings into the same `undefined` state as “no commit
  event”.
- `packages/winding/wayland/input_test.ts:256-268` explicitly expects a second bare `done` to leave
  `hasVisiblePreedit === true`.

text-input-v3 event fields are double-buffered and reset to their initial values after each `done`. The prescribed
application order begins by replacing the existing preedit with the cursor, then applying surrounding deletion and the
commit, and finally inserting the new preedit. A batch with no new `preedit_string` therefore has an empty pending
preedit. Bare `done`, a delete-only batch, or an explicit empty/null commit must not strand the prior composition.

This is not purely theoretical: [Chromium issue 409716545](https://issues.chromium.org/issues/409716545) records KWin
using a bare `done` to clear preedit. The current test codifies the opposite behavior.

Represent event presence independently from normalized semantic text. On every `done`, apply the full protocol order and
make old-preedit removal explicit. If the public API wants a commit to end preedit atomically without a separate clear
event, the batching layer must still ensure delete-only and empty-commit sequences clear correctly and that consumers
can observe protocol order.

Two smaller text-normalization issues are exposed by the same path:

- `TextInputV3Batch.setCommit()` applies the keyboard-oriented `normalizeCommittedText()` filter. It discards an entire
  nonempty native IME commit if it contains any C0/C1 control code point. text-input-v3 requires valid UTF-8 but does
  not impose that filter; a multiline input method may legitimately commit a newline. Keyboard shortcut/control
  filtering should not silently redefine native `commit_string`.
- `packages/winding/input/ime.ts:56-65` rejects a preedit cursor pair when `cursor_begin > cursor_end`. The protocol
  permits two endpoints for a highlighted range and does not require their order. A reverse selection is currently
  reported as a hidden/unknown cursor. Normalize the endpoints, or extend the public range type if direction matters.

### WL-08a — High integration impact: delete-surrounding is delivered but not applied

The Wayland controller correctly creates a byte-counted delete-surrounding event at
`packages/winding/wayland/text_input_controller.ts:316-319`, and the shared Quox adapter forwards it. However,
`packages/quox/src/interaction.rs:518-527` explicitly records that the pinned editor accepts but does not apply the
event.

In a normal replacement/autocorrection batch, text-input-v3 first asks the client to delete text around the cursor and
then commits replacement text. The current integration can insert the replacement without removing the original,
diverging application text from the input method's model. This is not a wire binding defect, but it means the
repository's direct cross-platform consumer does not currently uphold the Wayland edit invariant. Either implement the
editor operation before enabling native text input in that editor, or suppress the capability with a documented
degradation that cannot produce corrupt edits.

### WL-09 — Medium-high: registry/global lifecycle and seat selection are incomplete

Local evidence:

- `packages/winding/wayland/mod.ts:187-190` installs a no-op `wl_registry.global_remove` callback.
- `mod.ts:200-254` discards each global's registry name after binding.
- Every `wl_seat` overwrites the one `#seat`; only the value present during the one-time `#initSeat()` at
  `mod.ts:292-322` gets listeners/controllers.
- Earlier seat proxies are not retained or destroyed.

The core registry contract says a client that bound a removed global should destroy the resulting object. Requests on it
are ignored until destruction. Because names are not retained, this implementation cannot correlate a removal with its
compositor, SHM object, XDG factory, seat, cursor manager, or text manager.

Consequences include:

- a removed seat leaves stale input focus/proxies;
- a removed factory remains non-null, so later window/buffer construction uses an inert object;
- replacement globals overwrite fields without systematically destroying old proxies;
- a seat announced after construction is assigned but never initialized;
- multiple seats select whichever happened to be announced last, leak all earlier proxies, and may choose a seat with no
  useful capabilities;
- a cursor-shape manager announced after pointer creation never gets a device.

Track every bound global by registry name and interface. Handle removal with the same controller-aware cleanup used at
shutdown. If the shared API supports only one seat, select one deliberately, ignore/release extras, and define how a
replacement is chosen. Otherwise the controller model needs to become per-seat.

### WL-10 — Medium-high: stale text-input serial state is detected and discarded

Local evidence:

- `packages/winding/wayland/text_input.ts:79-84` computes `serialMatches` against the number of client commits.
- `packages/winding/wayland/text_input_controller.ts:207-216` immediately throws that distinction away and emits only
  `.edits`.
- `text_input_controller.ts:99-105` can send and commit a new cursor rectangle immediately afterward.

For a mismatched `done` serial, text-input-v3 requires the application to apply the incoming edits normally, but not to
update current protocol state as if the compositor had seen the newest client commit. Pending surrounding/content/
cursor state should be sent and committed only after a later `done` with a matching serial.

The batch object already exposes exactly the signal needed, but the controller does not use it. The current Quox
integration recalculates/sends native IME requests after handling input events, making an immediate cursor-state commit
after stale edits reachable.

Keep an “awaiting matching done” state. Apply edits regardless of match, but coalesce outgoing cursor, surrounding, and
content updates until a matching serial arrives, then resend the latest full state.

### WL-11 — High-risk design issue: protocol enable is treated as exclusive per-key ownership

Local evidence:

- `packages/winding/wayland/text_input_controller.ts:227-275` marks activation successful immediately after marshalling
  `enable` and `commit`; the protocol has no activation acknowledgement.
- `packages/winding/wayland/keyboard_controller.ts:224-267` disables local Compose/XKB commits whenever that local
  active flag is true and returns after the keydown without emitting text.
- `packages/winding/README.md:53-61` promises a normal character keydown followed by exactly one nonempty IME commit and
  says activation events report actual activation.

text-input-v3 does not acknowledge that an input-method daemon is actually present, does not report that a particular
`wl_keyboard.key` was consumed, and does not promise one `commit_string` for every printable key. Advertising the
manager and accepting `enable` proves protocol availability, not per-key text ownership.

On a compositor that exposes the manager but has no active IME path, plain keys can therefore produce a `text-input`
keydown while neither the compositor nor the local XKB path commits text. Client-generated repeat keydowns have the same
ambiguity. This failure mode needs live testing with and without fcitx/IBus on wlroots, KWin, and Mutter; no suitable
compositor was available here.

There is a related representation gap. The protocol requires a new `enable` whenever focus moves to a different logical
text input, including within the same `wl_surface`. The public API exposes only a per-window boolean, and
`WaylandWindow.setImeEnabled(true)` returns early if the desired boolean was already true (`window.ts:197-201`). A
caller can force a false/true cycle, but there is no editor-context identity or reset generation. The current Quox IME
mailbox stores only the latest desired boolean (`packages/quox/src/lib.rs:56-127`), so a same-turn false/true focus
handoff can erase that cycle entirely.

The API should distinguish “native text services are desired” from “this key's edit is owned”, and should carry an
editor-context generation/reset operation. `ime/enabled` should be documented as a locally committed protocol state
unless there is a real native confirmation. Native tests must establish how fallback plain text and repeat are produced
without duplicating commits when an IME is active.

The shared API also cannot send content purpose/hints or surrounding text. Omitting surrounding text is protocol-valid
when the client does not support it, but it limits IME behavior. Omitting password/PIN purpose and sensitive-data hints
is a privacy/quality gap for a general text editor. These should be part of a future editor-context API rather than more
independent setters.

### WL-12 — Medium: pointer v5 semantics and the shared wheel contract are lossy

Local evidence:

- The seat is bound through version 5 at `packages/winding/wayland/mod.ts:212-214`.
- `mod.ts:348-412` handles only pointer event slots 0-4 and fills `frame`, `axis_source`, `axis_stop`, and
  `axis_discrete` with no-ops.
- Motion and axis fixed-point values are converted with `>> 8` at `mod.ts:377,399`.
- Pointer-enter coordinates are accepted by the native callback signature but ignored at `mod.ts:350-359`.
- `packages/winding/types.ts:115-119` does not define wheel units or source.

At pointer version 5, events within a frame are one logical group and clients should accumulate them before processing.
The current code emits horizontal and vertical axes independently, drops source/discrete/stop information, and cannot
represent one diagonal wheel vector atomically.

Signed right shift also destroys useful data: `+0.5` becomes `0`, while `-0.5` becomes `-1`, and all subpixel pointer
coordinates are lost. Smooth touchpad scroll can generate zero-delta events or disappear entirely. Divide by 256 to
obtain a JavaScript number instead.

Ignoring enter coordinates creates an integration bug. A click or wheel event may occur after entering a surface but
before any motion. Public button events contain no coordinates, and the current Quox router uses its last remembered
mousemove position, which can still be `(0,0)` or belong to an earlier surface.

Finally, Wayland axis values are logical-coordinate distances, while the current Quox consumer treats Winding deltas as
wheel detents and multiplies them by 40 (`packages/quox/dom/input.ts:51-83`). A common Wayland wheel value of 10 becomes
400 application units. The shared API needs defined units (or a delta mode/source), and the Wayland adapter needs a
version-aware frame accumulator. For pointer versions below 5, immediate legacy dispatch remains appropriate.

### WL-13 — Medium: held-key and modifier-key state do not meet the shared event semantics

Local evidence:

- `packages/winding/wayland/keyboard_controller.ts:151-170` ignores the `wl_keyboard.enter` array of currently held
  keys.
- Key events are materialized immediately at `keyboard_controller.ts:187-198`.
- The XKB modifier state is updated only by the following modifiers callback at `keyboard_controller.ts:200-204`.

The core protocol defines the enter array as the keyboard's currently logically down keys. It also says clients should
not synthesize press events from the array. Ignoring it entirely, however, leaves the internal pressed-logical-key cache
empty. A later release can produce a keyup with no matching keydown and can resolve a different logical key if layout
state changed while focus moved.

For modifier-changing keys, Wayland deliberately sends the resulting `modifiers` event after the key event. The backend
snapshots the previous modifier state into the public event. As a result, Shift keydown can carry `shiftKey: false`, and
Shift keyup can carry `shiftKey: true`, contrary to the DOM-style complete modifier snapshot described by the shared
API.

Seed held-key bookkeeping from enter without synthesizing keydowns, and design key/modifier batching or provisional
modifier handling so the modifier key's own public transition has the intended state.

### WL-14 — Medium: Wayland requires premultiplied alpha but the conversion only swaps channels

Local evidence:

- `packages/winding/wayland/shm_buffer.ts:47-55` copies `RGBA` to `BGRA` byte order without changing RGB values.
- `shm_buffer.ts:96-103` declares the buffer as `WL_SHM_FORMAT_ARGB8888`.
- `packages/winding/types.ts:147-148` describes the public input only as RGBA and does not require premultiplied values.

Current core Wayland specifies premultiplied alpha for buffers with alpha and for all `wl_shm` formats unless another
extension says otherwise. A straight RGBA pixel `(255, 0, 0, 128)` is currently stored as red 255/alpha 128. Valid
premultiplied content would have red near 128.

Opaque pixels are unaffected, which hides the issue in the current smoke test. For semitransparent content the result
can have bright fringes and incorrect blending. Either define the cross-platform buffer contract explicitly as
premultiplied RGBA and enforce it everywhere, or premultiply in this conversion (for example, rounded
`channel * alpha / 255`). Using XRGB is an alternative only if transparency is intentionally unsupported.

### WL-15 — Medium: XDG behavior does not fully implement the shared window contract

This is a group of related semantic mismatches rather than one wire-signature error.

**A newly opened window remains unmapped until its first blit.**

`packages/winding/wayland/window.ts:95-105` correctly performs the required initial commit without a buffer, waits for
configure, and acknowledges it. That commit is only a handshake; an xdg toplevel is not mapped until a non-null buffer
is committed. The README example at `packages/winding/README.md:23-30` opens a window and polls once without ever
blitting, so it displays nothing on Wayland. Either map a blank initial buffer after configure or document that Wayland
windows are intentionally unmapped until `blit()`.

**Requested dimensions and configure dimensions are not retained.**

The `WaylandWindow` constructor deliberately ignores its `_width` and `_height` arguments (`window.ts:56`), and `blit()`
accepts any positive dimensions. The public comment says blit dimensions must match the window, but the backend cannot
enforce or even check that invariant. An xdg configure may set either dimension independently to zero, meaning the
client chooses only that dimension; `window.ts:140-143` drops the whole resize unless both are positive. For `1200x0`,
the known width is lost instead of being combined with the current/client-chosen height.

**Position arguments cannot be honored.**

`WaylandLibrary.openWindow()` discards `x` and `y` (`mod.ts:460-465`). Standard xdg toplevels do not provide arbitrary
client positioning, so this is an unavoidable platform difference, but the shared overload should document it instead of
appearing portable.

**`suspended` is not “minimized”.**

`window.ts:144-148` maps the xdg `suspended` state to public `visibilitychange`, whose shared documentation says
minimized/restored (`types.ts:136-139`). XDG defines suspended as “not ordinarily being repainted”, including complete
occlusion and outputs switched off for screen locking. Separately, `set_minimized` explicitly says there is no way for a
client to know whether minimization occurred. The current event therefore reports screen lock or occlusion as
minimization and cannot report many actual minimizations. If kept, it should be named/documented as best-effort render
suspension and latched with the complete configure sequence.

**Serial zero is used as a sentinel.**

`#pendingSerial === 0` means “none”. Protocol serials are unsigned 32-bit and can wrap; zero is not reserved by the
interface definition. After an extremely long compositor lifetime, a real configure serial zero would be skipped. Use
`number | undefined` instead. This sub-item is low severity but easy to fix while restructuring configure state.

### WL-16 — Medium-low: SHM capability and protocol integer constraints are assumed

Local evidence:

- `packages/winding/wayland/mod.ts:244-245` retains the `wl_shm` proxy but adds no listener for its `format` events.
- `packages/winding/wayland/shm_buffer.ts:102` always selects ARGB8888.
- `shm_buffer.ts:204-210` validates only positive JavaScript safe integers.

The protocol says actual valid SHM formats are advertised. It strongly says renderers should support ARGB8888 and
XRGB8888, so this is normally safe, but “should” is not an unconditional client guarantee. A custom conforming
compositor can omit ARGB8888 and reject the buffer.

Pool size, buffer width/height/stride, and damage dimensions are protocol signed 32-bit integers. The current
safe-integer check permits values far beyond that range. In particular, `width * 4` and `width * height * 4` can exceed
`INT32_MAX` before the JavaScript arithmetic becomes unsafe. Raw union packing then truncates the values, leading to
invalid stride/fd errors or a fatal protocol error.

Record advertised formats during initialization and fail clearly if no usable format exists. Validate every marshalled
signed integer, including stride and pool size, before allocating. A practical SHM image must have positive width and
height, `width * 4 <= INT32_MAX`, and total pool size within the protocol's positive signed-int range.

### WL-17 — Medium-low: `WaylandLibrary` has no constructor unwind path

`packages/winding/wayland/mod.ts:80-161` opens libc, libdl, libwayland, libxkbcommon, an extra loader handle, a display
connection, callbacks, and controllers directly in the constructor. Any later throw leaves everything acquired earlier
without deterministic cleanup. Likely triggers include a missing symbol, failed display connection, XKB context failure,
failed native callback construction, or an initialization callback/roundtrip error once those results are checked
correctly.

`WaylandWindow` and the individual controllers already use cleanup aggregation, so the library constructor should follow
the same staged-ownership pattern. Create resources into locals/optional fields, unwind them in reverse order on
failure, and transfer to the fully initialized object only on success.

All `wl_proxy_add_listener` return values are also ignored. They normally fail only for duplicate listener/dispatcher
installation, but a failed listener is important enough to turn into a deterministic initialization error.

### WL-18 — Low/latent: cursor-shape manager v1 metadata has the wrong method count

`packages/winding/wayland/ffi.ts:168-173` declares only:

1. `destroy`
2. `get_pointer`

The upstream version-1 manager also has opcode 2,
`get_tablet_tool_v2(new_id wp_cursor_shape_device_v1,
zwp_tablet_tool_v2)`. It predates the interface's version-2
additions, so binding version 1 does not justify omitting it. The local `method_count` is 2 where scanner output has 3.

There is no tablet call site today, so current behavior does not index the missing method. It remains an exact
API/metadata mismatch and would make a future opcode-2 marshal read past the local method array. Generating complete
metadata as recommended for WL-02 fixes this too.

### WL-19 — Low/portability: several native declarations assume one ABI

**`poll` argument width.** `packages/winding/wayland/protocol.ts:11` declares the `nfds` argument as `u32`. On glibc
LP64, `nfds_t` is `unsigned long`, so the exact Deno type is `usize`. Passing the constant 1 works on common x86-64 and
AArch64 calling conventions because it is zero-extended, but the declaration is not ABI-exact.

**No-op listener prototype.** `mod.ts:126` creates one zero-argument native callback and `protocol.ts:68-79` installs it
in event slots whose real prototypes take multiple pointers/integers. Common ABIs ignore surplus argument registers, and
this normally works, but the callback function type is formally incompatible. Typed no-ops per listener shape, or a
single libffi dispatcher API, would avoid depending on that behavior.

**LP64 little-endian packing.** `ffi.ts:9-21,50-118` hard-codes 8-byte pointers, 40-byte `wl_interface`, 24-byte
`wl_message`, and explicit little-endian writes. `protocol.ts:32-34,54-64,68-79` assumes 8-byte `wl_argument` slots and
LP64 `wl_array` offsets. `MAP_FAILED`, vtables, and `pollfd` writes make similar assumptions. This is correct for the
currently relevant x86-64/AArch64 little-endian Linux targets, but not for 32-bit or big-endian ABIs. Add an explicit
architecture guard at load time if those systems are intentionally unsupported.

### WL-20 — Capability/portability: selection is broader and narrower than the implementation

- `packages/winding/wayland/mod.ts:81-84` hard-codes `libc.so.6` and `libdl.so.2`.
- `packages/winding/wayland/protocol.ts:26-27` hard-codes the Wayland/XKB SONAMEs.
- `packages/winding/wayland/shm_buffer.ts:69` requires `memfd_create` with no portable anonymous-file fallback.
- `packages/winding/mod.ts:37-46` chooses this path for any non-Windows, non-Darwin build when `WAYLAND_DISPLAY` is
  readable and nonempty.

This is a glibc/Linux implementation, not a generic Wayland client backend. Musl layouts and other Unix systems can have
a valid Wayland stack but fail the library names or `memfd_create`. Conversely, libwayland also supports inherited
connections via `WAYLAND_SOCKET`; the selector ignores that valid launch mode and can choose the non-Wayland backend. A
stale/nonfunctional `WAYLAND_DISPLAY` causes a hard failure rather than a documented selection error or fallback.

Either constrain the top-level selector to supported Linux/libc targets and document the dependency floor, or resolve
platform libraries and anonymous SHM files portably. Include `WAYLAND_SOCKET` in selection if inherited sockets are
intended to work.

### WL-21 — Capability gaps: scale, decorations, identity, and pacing

These are not malformed protocol requests, but they are significant edge cases for a cross-platform window abstraction.

- **HiDPI:** the backend binds the compositor only through version 4, never binds outputs, and never calls
  `wl_surface.set_buffer_scale`. It also does not use fractional-scale or viewporter protocols. Buffers remain scale 1
  and are typically compositor-upscaled/blurry on HiDPI displays. Resize dimensions are logical coordinates while the
  shared API calls them pixels.
- **Decorations:** no xdg-decoration protocol or client-side title bar/borders are implemented. XDG toplevel clients are
  generally responsible for their full visual representation unless server decorations are negotiated/policy, so valid
  compositors can show a borderless surface with no move/resize/close controls.
- **Application identity:** `xdg_toplevel.set_app_id` is defined in metadata but never called. Taskbar grouping,
  desktop-file matching, and icon association may be degraded.
- **Presentation pacing:** there are no frame callbacks. Besides wasting work, this makes WL-01 easy to trigger and
  prevents a principled minimized/occluded repaint policy. XDG explicitly recommends frame callbacks rather than trying
  to infer minimization.
- **Long initialization without dispatch:** the current Quox integration opens the native surface and then awaits
  renderer setup before starting event polling. Pings and later configures are not serviced during that interval, so
  sufficiently slow GPU/WASM initialization can make the client appear unresponsive.

## Behavior verified as correct

The following points were checked against scanner output or normative protocol text and should not be changed merely as
fallout from this review:

- All `WlOp` values currently used for core Wayland, xdg-shell, cursor-shape-v1, and text-input-v3 are numerically
  correct.
- The xdg-shell method/event order, signatures, nullable markers, and version prefixes match version 7. In particular,
  `configure_bounds` is `4ii` and `wm_capabilities` is `5a`.
- The version-1 text-input-v3 request/event order, string nullability, and manager constructor type array match
  upstream. Binding version 1 when version 2 is offered is legal.
- Binding cursor-shape-v1 version 1 and using shape value `DEFAULT = 1` are legal. The defects are the missing type
  array and omitted manager request, not the chosen bound version.
- All explicitly implemented native listener callback signatures match their event ABI, including fd, fixed, array,
  signed, unsigned, nullable string, and object arguments.
- The declared libwayland-client and xkbcommon function signatures are ABI-compatible apart from the separate libc
  `poll` issue.
- Registry bind's untyped `new_id` argument packing and all used constructor argument orders are correct.
- Window setup creates `wl_surface`, then `xdg_surface`, then `xdg_toplevel`, installs listeners, and performs the
  required initial bufferless commit. That handshake is correct; the later mapping/size association is not.
- Responding to `xdg_wm_base.ping` with the received serial is correct.
- A client may acknowledge only the newest of several complete configure sequences. The bug is losing the state
  associated with that serial.
- Window teardown destroys `xdg_toplevel` before `xdg_surface` before `wl_surface`, and library teardown destroys
  windows before `xdg_wm_base`.
- Pointer/keyboard/seat release requests are correctly gated during shutdown, with local proxy destruction used for
  versions predating those requests.
- The cursor-shape request correctly uses the pointer-enter serial.
- Destroying a `wl_shm_pool` immediately after creating the buffer is expressly permitted; buffers retain the
  server-side pool reference.
- The keymap callback maps read-only/private, passes the size to xkbcommon, unmaps, and closes the compositor-provided
  fd. Raw Wayland keycodes are correctly converted to XKB keycodes by adding 8.
- `xkb_state_update_mask(state, depressed, latched, locked, 0, 0, group)` is the standard Wayland client update pattern.
- On the supported LP64 little-endian targets, the `wl_array` state parsing, interface/message struct sizes, pointer
  slots, and ARGB byte order are laid out as intended. Alpha association remains the separate WL-14 issue.
- Each successful `wl_display_prepare_read` is paired with either `wl_display_read_events` or `wl_display_cancel_read`.
  The event-loop defects are unchecked return/readiness states, not a missing cancellation on the visible branches.

## Recommended remediation order

### P0 — Required for protocol safety

1. Replace the single SHM allocation with a release-aware buffer pool.
2. Generate complete extension metadata or fully populate/backpatch every `wl_message.types` table; add a
   `WAYLAND_DEBUG=client` smoke test.
3. Redesign configure handling around complete, generation-tagged records and reject stale rendered frames.
4. Add display-terminal-error handling and a correct writable flush path.
5. Version-gate `damage_buffer` with a `damage` fallback.

### P1 — Required for robust input and compositor compatibility

6. Implement pointer capability teardown/reacquisition and registry removal.
7. Add a core cursor-surface fallback.
8. Correct text-input preedit reset/order and honor matching versus stale done serials.
9. Implement the direct consumer's delete-surrounding editor operation.
10. Define and test native-text ownership/fallback, repeat, and editor-context transitions across compositors and IME
    daemons.
11. Preserve fixed-point pointer data, implement pointer-frame accumulation, and define cross-platform wheel units.
12. Premultiply straight-alpha input or explicitly change/document the shared pixel contract.

### P2 — Contract completeness and maintainability

13. Make initial mapping/dimensions and Wayland's lack of top-level positioning explicit in the shared API.
14. Seed keyboard held state and repair modifier-key snapshots.
15. Validate advertised SHM formats and signed-32 sizes.
16. Add constructor unwind logic and check listener registration.
17. Add scale, app-id, decoration, and frame-callback support.
18. Guard or generalize the LP64/glibc assumptions and improve backend selection.

## Suggested tests

The existing pure tests and `headless_smoke.ts` do not cover the high-risk paths. The following tests would prevent
regressions:

1. **Generated metadata parity:** compare every handwritten interface's version, counts, names, signatures, and
   per-argument type pointers with `wayland-scanner` output.
2. **Debug smoke:** run window creation with `WAYLAND_DEBUG=client`; this should catch null type-table dereferences
   immediately.
3. **Delayed buffer release:** use a test compositor that withholds `wl_buffer.release`, call same-size `blit()`
   repeatedly, and assert busy storage is never written.
4. **Version-3 compositor:** advertise `wl_compositor` version 3 and verify the client sends `wl_surface.damage`, never
   opcode 9.
5. **Configure generation:** send A and B before the client renders, including a maximized B, and assert only a B-sized
   buffer can acknowledge B. Repeat while an asynchronous render for A is in flight.
6. **Disconnect/protocol error:** close the compositor socket and inject an invalid-state error; `event()` must report a
   terminal failure rather than return `undefined` forever.
7. **Capability toggle:** remove and re-add pointer capability and confirm new pointer/cursor objects and cleared focus
   state.
8. **No cursor-shape global:** verify pointer enter still installs a visible core cursor.
9. **Text batching:** cover bare `done`, delete-only, null/empty commit, commit-plus-new-preedit, stale/matching serial
   transitions, and actual application of delete-surrounding by the shared consumer.
10. **IME matrix:** type and repeat plain text with no IME daemon, fcitx, and IBus on wlroots/KWin/Mutter, checking for
    both lost and duplicate commits.
11. **Pointer frames:** send fractional motion, fractional touchpad scroll, a diagonal frame, discrete wheel input, and
    click-immediately-after-enter.
12. **Alpha fixture:** blit a known semitransparent pixel and verify the SHM bytes and compositor blend result.
13. **Global lifecycle/multiseat:** announce multiple seats, remove the selected one, and advertise a replacement after
    initial roundtrips.
14. **HiDPI:** move a surface across differently scaled outputs and verify logical size, buffer size, pointer
    coordinates, and IME rectangle remain coherent.

For CI, a standard headless compositor is useful for lifecycle smoke tests, but a small purpose-built protocol server is
needed to deterministically delay releases, control advertised versions, inject configure sequences, and toggle
globals/capabilities.
