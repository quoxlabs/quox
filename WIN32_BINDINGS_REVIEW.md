# Win32 bindings review

Review date: 2026-07-10 Repository revision: `a48ca1647f006b6bda5c1a7373475c3588c92e9c` Primary implementation:
`packages/winding/win32`

## Scope and method

This review covers only:

- the Win32 backend in `packages/winding/win32/`;
- the public cross-platform `Window`, `Library`, and event contracts in `packages/winding/types.ts` that the Win32
  backend implements; and
- shared input state helpers under `packages/winding/input/` where the Win32 controller relies on their invariants.

The Darwin, X11, Wayland, DOM, and renderer implementations were deliberately excluded. They are mentioned nowhere as a
correctness baseline; the only cross-platform baseline used here is the shared public contract itself.

This was a static review on Linux. Each hand-written declaration, native structure, message field, lifetime rule, and
relevant return-value contract was checked against current Microsoft Learn/Windows SDK documentation. Deno-specific
native types and supported targets were checked against Deno's documentation and `deno_ffi` source. There is no Windows
SDK or Win32 loader on this host, and `deno` is not installed, so neither the pure TypeScript tests nor the live Windows
smoke test could be executed locally. Findings that need behavior from a real installed IME are explicitly marked as
native-validation risks rather than presented as reproduced defects.

Confidence wording uses the following bases. Domain suffixes such as “lifecycle,” “painting,” or “cross-contract”
classify the subject; they are not additional confidence levels.

- **Confirmed mismatch/defect/gap**: the declaration, code path, or missing invariant follows directly from repository
  code plus the documented native/shared contract.
- **Documented integration risk**: Microsoft documents the dangerous interaction, and this implementation has the
  described call pattern.
- **Native-validation/conditional risk**: authoritative documentation or a reachable defensive path identifies a problem
  shape, but a current Windows/IME/device ordering reproduction is still required.

Severity means:

- **Critical**: a permitted failure path can leave native code calling freed executable state, with crash or
  memory-corruption potential.
- **High**: ordinary lifecycle, rendering, text, pointer, or window behavior can be lost or materially wrong.
- **Medium**: an important edge case, international input path, embedding scenario, failure path, or contract detail is
  wrong.
- **Low**: a narrow robustness issue, future-target problem, or nominal ABI mismatch with no current register-level
  consequence.

## Executive assessment

The backend's hand-encoded structures and much of its keyboard/IMM parsing are careful and substantially correct. In
particular, the 64-bit `WNDCLASSEXW`, `MSG`, and `TRACKMOUSEEVENT` layouts; all pointer-free IMM layouts;
`BITMAPINFOHEADER`; top-down 32-bpp DIB conversion; UTF-16 IMM reads; surrogate-aware `WM_CHAR` decoding; physical
scan-code mapping; and successful `ImmGetContext`/`ImmReleaseContext` ownership are sound for Deno's current Windows x64
and ARM64 targets.

The integration around those pieces is not production-safe yet. The most serious defect is conditional but critical: if
native window destruction or class unregistration fails, library teardown can free the Deno WNDPROC trampoline while
Windows still has a live HWND or registered class pointing to it. A later message can therefore enter freed callback
state.

There are also nine high-severity defects:

1. Every Win32 `BOOL` result is declared as Deno's one-byte `bool`, not Win32's 32-bit `int`.
2. A visible HWND is published only after `CreateWindowExW` has synchronously run its creation/show path and may already
   have delivered size, focus, and IME messages.
3. `openWindow(x, y, w, h)` ignores every argument.
4. The fixed `"Winding"` class prevents concurrent library instances and predictable constructor failures leak all
   acquired native resources.
5. The backend has no `WM_PAINT` path, so blitted pixels are not recoverable after invalidation.
6. Captured mouse coordinates are decoded unsigned, `mouseenter` is absent, and leave tracking can repeat spuriously.
7. Mouse-capture state can become permanently stale after capture loss or close-during-drag.
8. Physical Ctrl+Alt text on AltGr layouts is classified as a platform shortcut and discarded.
9. With an affected installed IME and cross-thread sent-message reentry, the message loop has Microsoft's documented
   `TranslateMessage`/IMM crash pattern.

The remaining findings cover IMM association and error-state divergence, `WM_QUIT` ownership, resize/repeat loss,
inaccurate IME geometry, Japanese target-clause loss, Korean insert-on-type compatibility, DPI semantics, unsafe error
formatting, unchecked blit invariants, logical-key/Unicode-injection mistakes, and lower-risk declaration or IME
recovery gaps.

The backend should not be treated as production-ready until W32-01 through W32-10 are corrected and the resulting
lifecycle, paint, mouse, AltGr, and real-IME paths are exercised on Windows. All Medium findings, including W32-26,
W32-27, and W32-31, should be resolved before claiming robust international-input and host-embedding support.

## Finding index

| ID     | Severity | Confidence                                               | Finding                                                                          | Principal effect                                                  |
| ------ | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| W32-01 | Critical | Confirmed invariant defect                               | Failed native teardown can free a live WNDPROC callback                          | Native use-after-free and process crash                           |
| W32-02 | High     | Confirmed API mismatch                                   | Win32 `BOOL` results use Deno's one-byte `bool`                                  | ABI mismatch and possible false-failure decisions                 |
| W32-03 | High     | Confirmed implementation defect                          | The visible HWND is published after synchronous creation messages                | Initial size/focus loss and first-focus IME failure               |
| W32-04 | High     | Confirmed contract defect                                | `openWindow` ignores position and size                                           | Requested geometry and drawable-size invariant are false          |
| W32-05 | High     | Confirmed lifecycle defect                               | A fixed class name rejects concurrent libraries and failed construction leaks    | Predictable load failure and native-resource leaks                |
| W32-06 | High     | Confirmed painting defect                                | There is no `WM_PAINT` implementation                                            | Window content disappears after invalidation                      |
| W32-07 | High     | Confirmed input/contract defect                          | Mouse coordinates, enter, and leave tracking are wrong                           | Huge negative coordinates, missing enter, repeated leave          |
| W32-08 | High     | Confirmed invariant defect                               | Mouse-capture state has no owner or loss recovery                                | Later drags permanently lose capture/up delivery                  |
| W32-09 | High     | Confirmed international-input defect                     | Physical Ctrl+Alt AltGr text is discarded                                        | Valid localized characters never commit                           |
| W32-10 | High     | Documented integration risk                              | IMM calls are possible during `TranslateMessage` reentrancy                      | Microsoft-documented IME crash                                    |
| W32-11 | Medium   | Confirmed state-model gap; native ordering test needed   | HIMC association and observed active state are conflated                         | Backend can report disabled while a context remains associated    |
| W32-12 | Medium   | Confirmed failure-handling defect                        | Native IMM failures are ignored while JS state advances                          | Native composition/activation diverges from public events         |
| W32-13 | Medium   | Confirmed embedding defect                               | `event()` removes `WM_QUIT` and other thread messages                            | Host quit requests and thread messages are swallowed              |
| W32-14 | Medium   | Confirmed event defect                                   | Restore suppresses resize and `WM_SIZE` words can truncate                       | Consumers retain stale dimensions                                 |
| W32-15 | Medium   | Confirmed event-loss defect                              | Native key repeat counts are collapsed                                           | Repeat multiplicity is unavailable to consumers                   |
| W32-16 | Medium   | Confirmed API mismatch                                   | `IMR_QUERYCHARPOSITION` fabricates arbitrary-character geometry                  | IME receives wrong glyph and document rectangles                  |
| W32-17 | Medium   | Confirmed information-loss defect                        | Japanese target clause/selection flags are swallowed                             | Preedit target-clause highlighting is wrong or absent             |
| W32-18 | Medium   | Native-validation risk                                   | Korean insert-on-type composition is modeled as irreversible commits             | Interim Hangul may be committed and cannot be replaced            |
| W32-19 | Medium   | Contract/integration gap                                 | DPI awareness and `WM_DPICHANGED` policy are undefined                           | Pixel and logical-coordinate semantics vary by host context       |
| W32-20 | Medium   | Confirmed API misuse                                     | `FormatMessageW` omits `FORMAT_MESSAGE_IGNORE_INSERTS`                           | Unsafe or failed reporting of arbitrary system errors             |
| W32-21 | Medium   | Confirmed robustness defect                              | `blit()` does not validate inputs or native completion                           | Stale pixels, coercion errors, and silent rendering failure       |
| W32-22 | Low      | Confirmed API mismatch                                   | Several handles and signed pointer-width values use nominally wrong FFI types    | Weaker type safety and incorrect signed JS values                 |
| W32-23 | Low      | Defensive/native-validation recovery gap                 | A new composition does not clear stale state and messages use desired state only | Bad recovery after missed/churned IME messages                    |
| W32-24 | Low      | Confirmed completeness gap                               | Only candidate-list index zero is positioned                                     | Secondary candidate lists use default/stale placement             |
| W32-25 | Low      | Native-validation risk                                   | `CS_INSERTCHAR` has no supplementary-character assembly                          | A surrogate-enabled IME could corrupt preedit/cursor state        |
| W32-26 | Medium   | Confirmed cross-contract mismatch                        | Several virtual keys map to the wrong/incomplete DOM logical key                 | Language/media/control keys are mislabeled                        |
| W32-27 | Medium   | Documented invariant gap; native translation test needed | `VK_PACKET` has no explicit text-input classification                            | Unicode-injected keydown can be assigned the wrong edit owner     |
| W32-28 | Low      | Forward-integration risk                                 | Consumed mouse messages still call `DefWindowProcW`                              | Unnecessary default processing; future wheel propagation risk     |
| W32-29 | Low      | Layout-dependent robustness defect                       | AltGr probing/filter state is incomplete                                         | Some AltGr layouts or interleaved Ctrl transitions are mishandled |
| W32-30 | Low      | Confirmed cross-contract mismatch                        | Printable logical keys are not normalized or validated                           | Non-NFC/invalid DOM-style `key` strings escape                    |
| W32-31 | Medium   | Confirmed lifecycle defect                               | `setTitle()` and `blit()` use a retained HWND after close                        | A recycled handle can target an unrelated window                  |

## Detailed findings

### W32-01 — Failed teardown can free a callback still referenced by Windows

**Severity:** Critical **Confidence:** Confirmed invariant defect

`Win32Window.close()` commits its JavaScript teardown before it knows whether native teardown succeeded:

1. it sets `#closed = true` at [`mod.ts:181`](packages/winding/win32/mod.ts#L181);
2. detaches input, purges queued events, and removes the HWND from `lib.windows` at
   [`mod.ts:183`](packages/winding/win32/mod.ts#L183); and
3. only then calls `DestroyWindow` at [`mod.ts:190`](packages/winding/win32/mod.ts#L190).

[`DestroyWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-destroywindow) returns zero on
failure and, among other constraints, cannot destroy a window owned by another thread. A zero result does not prove that
the HWND ceased to exist. In that case the implementation has a live but untracked native window, a window object that
refuses cleanup retries because `#closed` is already true, and an input controller that has forgotten the HWND.

`Win32Library.close()` makes the failure memory-unsafe. It marks the library closed, attempts every window close,
attempts `UnregisterClassW`, but then unconditionally proceeds to `#wndProc.close()` and closes `user32` at
[`mod.ts:475`](packages/winding/win32/mod.ts#L475).
[`UnregisterClassW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-unregisterclassw) is
required to fail while a window of the class exists. The implementation records that error and still frees the callback.
Deno documents the [`UnsafeCallback`](https://docs.deno.com/api/deno/ffi/#Deno.UnsafeCallback) pointer as unusable after
`close()`.

The resulting native graph is:

    live HWND or registered WNDCLASS
        -> lpfnWndProc
        -> closed Deno UnsafeCallback trampoline

Any later native message or a later window created from a class that failed to unregister can enter freed
executable/callback state. This is a native use-after-free, not just a resource leak. A generic `UnregisterClassW`
failure cannot be treated as absence. A result that is positively established to mean the class was already absent is
safe; the invariant is confirmed absence, not literally one particular successful return.

**Required fix:** make close transactional and native-state-driven.

- Use separate `closing` and `destroyed` states. Do not set the terminal state, purge the HWND mapping, or make retry
  impossible until destruction is confirmed.
- Prefer finalizing the mapping and input state from `WM_NCDESTROY`, which is the native lifetime boundary.
- If any HWND remains or class unregistration is not confirmed, retain the WNDPROC and `user32`. A reported leak is
  safer than freeing an actively referenced callback.
- Close DLLs and the callback only after all windows have reached `WM_NCDESTROY` and class absence is confirmed, either
  by successful unregistration or a specifically verified already-absent result.
- Reset mouse-capture ownership as part of successful HWND destruction.

**Required tests:** inject a failing `DestroyWindow`, an unresolved `UnregisterClassW` failure, and an already-absent
class result; close while a button is captured; and verify that callback retention/release follows confirmed native
state. A subprocess test should deliver a message after each unresolved failure and prove that the process neither
crashes nor enters a freed callback.

### W32-02 — Every Win32 `BOOL` result has the wrong Deno FFI type

**Severity:** High **Confidence:** Confirmed API mismatch

Windows defines [`BOOL`](https://learn.microsoft.com/en-us/windows/win32/winprog/windows-data-types) as
`typedef int BOOL`: a four-byte signed integer whose success rule is nonzero, not specifically the value one. Deno's
native `"bool"` represents a native one-byte boolean; the current `deno_ffi` implementation maps `NativeType::Bool` with
`U8` to libffi's [`Type::u8`](https://docs.rs/crate/deno_ffi/0.240.0/source/symbol.rs).

The following production results are all declared as `"bool"`:

- `GetKeyboardState`, `ClientToScreen`, `GetClientRect`, `ReleaseCapture`, `SetWindowTextW`, `DestroyWindow`, and
  `TrackMouseEvent` at [`ffi.ts:33`](packages/winding/win32/ffi.ts#L33);
- `UnregisterClassW`, `PeekMessageW`, and `TranslateMessage` at [`ffi.ts:52`](packages/winding/win32/ffi.ts#L52); and
- `ImmReleaseContext`, `ImmAssociateContextEx`, `ImmSetCandidateWindow`, `ImmSetCompositionWindow`, and `ImmNotifyIME`
  at [`ffi.ts:88`](packages/winding/win32/ffi.ts#L88).

The smoke test repeats the mismatch for `ShowWindow` and `PostMessageW` at
[`native_smoke.ts:7`](packages/winding/win32/native_smoke.ts#L7).

On current Windows x64 and ARM64 calling conventions, these integer results use the same result register, so this is not
expected to shift the stack. It is still an incorrect call interface: Deno observes only the low byte. Win32 permits any
nonzero result, so a valid `0x00000100` result would be observed as false. Conversely, the declaration cannot express
the actual 32-bit value for diagnostics or tests. Incorrect decisions are particularly consequential around
`PeekMessageW`, `DestroyWindow`, `UnregisterClassW`, and IMM association.

**Required fix:** declare every Win32 `BOOL` result as `"i32"` and test `result !== 0`. Do not replace C/C++ `bool` uses
indiscriminately; this correction is specifically for Win32's `BOOL` typedef.

**Required test:** add a tiny native test helper returning a nonzero `BOOL` whose low byte is zero, and assert that the
Deno binding treats it as success. That catches a future regression better than testing system APIs that usually happen
to return exactly one.

### W32-03 — The visible HWND is published after synchronous creation and activation messages

**Severity:** High **Confidence:** Confirmed implementation defect

The creation style `0x10CF0000` at [`mod.ts:76`](packages/winding/win32/mod.ts#L76) is
`WS_VISIBLE | WS_OVERLAPPEDWINDOW`. All four geometry values are `CW_USEDEFAULT`. Microsoft documents
[`CreateWindowExW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexw) as
synchronously sending creation messages before it returns; with `WS_VISIBLE` and this `CW_USEDEFAULT` use, the system
also shows/activates the window during creation.

The backend does not put the HWND in `lib.windows` until after `CreateWindowExW` returns, and attaches input even later,
at [`mod.ts:86`](packages/winding/win32/mod.ts#L86). During every synchronous WNDPROC call, the lookup at
[`mod.ts:251`](packages/winding/win32/mod.ts#L251) therefore produces `win === undefined`. Guaranteed creation messages,
plus any initial `WM_SIZE`, `WM_SETFOCUS`, and `WM_IME_SETCONTEXT` messages that activation produces, either fall
through to `DefWindowProcW` or are skipped by the controller.

The IME consequence is deterministic if initial focus was delivered in this interval:

- `attach()` later disassociates the default HIMC and creates an activation state whose `focused` bit is false at
  [`input_controller.ts:130`](packages/winding/win32/input_controller.ts#L130).
- `setImeEnabled(true)` cannot activate because shared `ImeActivationState.shouldBeActive` requires desired, available,
  and focused at [`activation.ts:32`](packages/winding/input/activation.ts#L32).
- The native window may actually remain focused, so no later `WM_SETFOCUS` repairs the state until a full blur/refocus
  cycle.

The initial public focus event and initial client resize can also be absent, and reentrant hooks/automation can deliver
other messages before the object exists.

**Required fix:** create the HWND without `WS_VISIBLE`, publish it, attach the input state, query initial client
size/focus, and only then call
[`ShowWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow). The other sound
design is to pass a provisional owner through `lpParam` and associate it during `WM_NCCREATE`/`WM_CREATE` using window
userdata, as described in Microsoft's
[application-state guidance](https://learn.microsoft.com/en-us/windows/win32/learnwin32/managing-application-state-).
Merely querying [`GetFocus`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getfocus) after the
current construction sequence repairs only one of the already-lost messages.

**Required test:** create a foreground-capable visible window, assert exactly one initial focus event and an
authoritative initial client-size event, enable IME immediately, and assert a real enabled transition without forcing a
blur/refocus.

### W32-04 — `openWindow(x, y, w, h)` ignores its complete geometry contract

**Severity:** High **Confidence:** Confirmed implementation and contract defect

The public library exposes position/size overloads at [`types.ts:157`](packages/winding/types.ts#L157). The Win32
implementation names the values `_x`, `_y`, `_w`, and `_h`, then discards them at
[`mod.ts:412`](packages/winding/win32/mod.ts#L412). Its constructor always supplies `CW_USEDEFAULT` for X, Y, width, and
height at [`mod.ts:72`](packages/winding/win32/mod.ts#L72).

Consequences include:

- `openWindow(0, 0, 64, 48)` does not request either that position or that size;
- the smoke test makes exactly that call but never observes geometry, so it cannot catch the defect;
- the client dimensions are unrelated to a frame the caller prepares under the `blit` precondition; and
- callers cannot place a window on a monitor with negative virtual-screen coordinates.

There are two native details the eventual implementation must not miss. First,
[`CreateWindowExW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexw) declares X,
Y, width, and height as signed `int`, but the FFI uses four `"u32"` parameters at
[`ffi.ts:62`](packages/winding/win32/ffi.ts#L62). Negative multi-monitor coordinates would therefore be coerced
incorrectly. Second, top-level `CreateWindowExW` width/height include non-client chrome. The shared resize/blit model
implies drawable client dimensions, so requested client size must be converted to an outer rectangle with
[`AdjustWindowRectEx`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-adjustwindowrectex) or its
DPI-aware equivalent.

**Required fix:** thread all four values into creation, validate finite signed/integer bounds, change the four FFI types
to `"i32"`, define whether `w`/`h` mean client size explicitly, and adjust non-client size at the window's intended DPI.

**Required test:** assert both window position and `GetClientRect` for positive and negative coordinates, including a
non-100%-DPI monitor. The existing 64x48 smoke case should verify a 64x48 client rectangle rather than merely survive
creation.

### W32-05 — The fixed class name rejects concurrent libraries and failed construction leaks

**Severity:** High **Confidence:** Confirmed lifecycle defect

Every `load()` registers the local class name `"Winding"` at [`mod.ts:204`](packages/winding/win32/mod.ts#L204) using
the process executable's same HINSTANCE. Microsoft documents local
[window classes](https://learn.microsoft.com/en-us/windows/win32/winmsg/about-window-classes) as process-specific and
identified by name plus instance. A second simultaneously live `Win32Library` therefore reaches `RegisterClassExW` with
an already-registered identity and fails with
[`ERROR_CLASS_ALREADY_EXISTS`](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1300-1699-).

The second library cannot safely treat that result as success. Each instance owns a distinct WNDPROC closure, `windows`
map, input controller, deferred-error slot, and event queue. Reusing the first class would route second-library HWNDs
into the first library's callback.

Construction is also not transactional. Four DLLs are opened at [`mod.ts:223`](packages/winding/win32/mod.ts#L223), an
input controller is allocated, and the `UnsafeCallback` is created at [`mod.ts:246`](packages/winding/win32/mod.ts#L246)
before module/cursor lookup and registration can throw. There is no constructor rollback. The predictable second-load
failure therefore leaks all four dynamic-library handles, the callback trampoline, and the closure/object graph it
retains. Other failures at `GetModuleHandleW`, `LoadCursorW`, layout validation, or registration have the same leak
pattern.

**Required fix:** either generate a process-unique class name per library or implement one process-global
class/dispatcher with explicit reference counting. Wrap acquisition in reverse-order cleanup so every partially acquired
callback, class, controller, and DLL is released on failure—subject to W32-01's rule that a registered class must retain
its callback until unregistration is confirmed.

**Required test:** keep two libraries alive concurrently, create a window in both, route events to the correct queue,
then close them in both orders. Also inject every constructor-stage failure and enable resource sanitization.

### W32-06 — Blitted pixels are not repainted after invalidation

**Severity:** High **Confidence:** Confirmed painting defect

The class has a null `hbrBackground` at [`mod.ts:380`](packages/winding/win32/mod.ts#L380), which means the application
owns client painting. Its style includes `CS_HREDRAW | CS_VREDRAW` at
[`mod.ts:241`](packages/winding/win32/mod.ts#L241), causing broad invalidation on relevant size changes. But the WNDPROC
has no `WM_PAINT` case anywhere in [`mod.ts:255`](packages/winding/win32/mod.ts#L255).

`blit()` obtains a DC and calls `SetDIBitsToDevice` immediately at [`mod.ts:155`](packages/winding/win32/mod.ts#L155).
It does not establish persistent backing storage. Microsoft's
[`WM_PAINT`](https://learn.microsoft.com/en-us/windows/win32/gdi/wm-paint) documentation says `DefWindowProc` validates
the update region; it does not reconstruct application pixels. Uncovering, resizing, display/DWM invalidation, or
explicit invalidation can therefore erase the frame. The initially visible client can also expose uninitialized content
before the first blit.

`#bgra` happens to retain the last converted bytes, but the backend does not retain their dimensions as authoritative
frame state and never uses them from paint dispatch.

**Required fix:** retain the last valid frame plus dimensions and handle `WM_PAINT` with paired
[`BeginPaint`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-beginpaint)/`EndPaint`, redrawing
the invalid region or whole retained frame. Define a clear color for the pre-first-frame state. Reassess whether
`CS_HREDRAW`, `CS_VREDRAW`, and `CS_OWNDC` remain useful after a correct paint path exists.

**Required test:** blit a known pattern, cover/uncover it, call `InvalidateRect`/`UpdateWindow`, resize it, and compare
pixels. Run the test with DWM and at multiple DPI scales.

### W32-07 — Mouse coordinates, enter events, and leave tracking violate the public contract

**Severity:** High **Confidence:** Confirmed API and contract defect

The `WM_MOUSEMOVE` handler extracts each `lParam` half as an unsigned word at
[`mod.ts:275`](packages/winding/win32/mod.ts#L275). Microsoft explicitly warns in
[`WM_MOUSEMOVE`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousemove) documentation not to use
unsigned low/high-word extraction because both client coordinates are signed 16-bit values. This is observable in the
backend's normal capture path: dragging left or above the client rectangle delivers negative coordinates, and `-1` is
reported as `65535`.

The shared interface also promises both `mouseenter` and `mouseleave` at
[`types.ts:128`](packages/winding/types.ts#L128). The Win32 WNDPROC emits only `mouseleave`; no branch can ever
construct `mouseenter` at [`mod.ts:275`](packages/winding/win32/mod.ts#L275).
[`TrackMouseEvent`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-trackmouseevent) requests
leave notification, not entry notification.

Finally, the backend arms `TME_LEAVE` on every movement. Tracking remains active until the leave occurs, so rearming on
every in-window move is unnecessary. More importantly, the
[`TRACKMOUSEEVENT`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-trackmouseevent) contract
permits an immediate leave notification when the pointer is already outside the requested area. Capture continues to
deliver outside moves; each outside move can rearm tracking and cause another immediate `WM_MOUSELEAVE`. Consumers may
therefore see multiple leave events for one boundary crossing.

**Required fix:**

- sign-extend both 16-bit coordinate fields, equivalent to `GET_X_LPARAM` and `GET_Y_LPARAM`;
- keep per-window inside/outside and tracking-active state;
- on the first qualifying client movement after outside/creation, emit `mouseenter` before `mousemove` and arm one leave
  request;
- clear tracking/inside state on `WM_MOUSELEAVE` and destruction; and
- treat `TrackMouseEvent` failure as a deferred native error rather than silently claiming tracking exists.

**Required test:** cross each edge normally; drag under capture into negative X/Y; hold capture while generating several
outside moves; then reenter. Assert one enter and one leave per crossing and exact signed coordinates.

### W32-08 — Mouse capture bookkeeping can become permanently stale

**Severity:** High **Confidence:** Confirmed invariant defect

The library stores one unqualified `#captureCount` for all windows at
[`mod.ts:217`](packages/winding/win32/mod.ts#L217). Button down increments it and calls `SetCapture` only for the
zero-to-one transition at [`mod.ts:292`](packages/winding/win32/mod.ts#L292); button up decrements it and calls
`ReleaseCapture` only at zero at [`mod.ts:303`](packages/winding/win32/mod.ts#L303).

The counter is not associated with:

- the HWND that owns capture;
- which buttons are actually down;
- a `WM_CAPTURECHANGED` notification;
- `WM_CANCELMODE` or modal cancellation;
- destruction of the capture owner; or
- success of `ReleaseCapture`.

Windows allows capture to be moved or canceled.
[`WM_CAPTURECHANGED`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-capturechanged) is sent to the losing
window, including after explicit release. Closing a Winding window while a button is held is an immediate
repository-only trigger: close never resets the counter. A later window's first press sees a positive count, skips
[`SetCapture`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcapture), and can lose the
outside release forever. A later stale zero transition may also call
[`ReleaseCapture`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-releasecapture) against
capture now owned by a different same-thread HWND.

`SetCapture` returning null must not be treated as failure: null validly means that no window previously owned capture.
Actual ownership should be queried/tracked through messages rather than inferred from that return.

**Required fix:** store a capture owner HWND and a set/bitmask of pressed buttons. Reset both on `WM_CAPTURECHANGED`,
cancellation, owner `WM_NCDESTROY`, and explicit release. Reconcile or report `ReleaseCapture` failure rather than
advancing JavaScript state unconditionally.

**Required test:** cover capture theft, close-during-drag, multi-button chords, release failure, `WM_CAPTURECHANGED`,
and a new drag in another Winding window after each case.

### W32-09 — Physical Ctrl+Alt text on AltGr layouts is discarded

**Severity:** High **Confidence:** Confirmed international-input defect

The backend recognizes AltGraph only as right Alt plus Control at
[`input.ts:136`](packages/winding/win32/input.ts#L136). Microsoft warns that Windows interprets `Ctrl+Alt` as AltGr on
some language layouts and that it generates alphanumeric characters; see the
[Windows keyboard guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-keyboard) and Raymond Chen's
explanation of [why Ctrl+Alt must remain text-capable](https://devblogs.microsoft.com/oldnewthing/20040329-00/?p=40003).

On an AltGr-capable German layout, for example, physical left Ctrl + left Alt + Q is a valid way to type `@`. The
current path is:

1. `isAltGraphActive` returns false because right Alt is not down.
2. `keyboardStateForTranslation` clears every Ctrl/Alt bit before `ToUnicodeEx` at
   [`input.ts:193`](packages/winding/win32/input.ts#L193), so the keydown resolves to the unmodified `q`, not `@`.
3. Because the native message is `WM_SYSKEYDOWN` and `altGraphKey` is false, `win32KeyEditDisposition` marks it
   `platform` at [`input.ts:152`](packages/winding/win32/input.ts#L152).
4. The real `TranslateMessage` still uses Windows' native state and can post `WM_SYSCHAR('@')`, but the controller
   consumes `WM_SYSCHAR` only for right-Alt-based AltGraph at
   [`input_controller.ts:250`](packages/winding/win32/input_controller.ts#L250). It passes the character to
   `DefWindowProcW`, producing no Winding commit.

This is not merely a modifier-label mismatch: valid localized text disappears.

**Required fix:** separate two concepts that the current `altGraphKey` boolean conflates. Synthetic-left-Control
suppression should remain narrowly tied to the right-Alt message pattern. Text level/ownership on an AltGr-capable
layout must also recognize Control plus either Alt when Windows translates it as AltGr. Prefer using the actual
`ToUnicodeEx` result and pending translated-message ownership rather than relying solely on physical modifier identity.

**Required test:** on German/Polish/Czech layouts, exercise right Alt, left Ctrl+left Alt, left Ctrl+right Alt,
Shift+AltGr levels, and ordinary Ctrl/Alt shortcuts. Verify key disposition, modifier snapshot, `WM_SYSCHAR` ownership,
and exactly one text commit.

### W32-10 — The message loop has Microsoft's documented IMM reentrancy crash pattern

**Severity:** High **Confidence:** Documented integration risk

The event pump calls `TranslateMessage` at [`mod.ts:435`](packages/winding/win32/mod.ts#L435). The WNDPROC paths can
call numerous `Imm*` APIs while handling focus, `WM_IME_SETCONTEXT`, composition, cancellation, and placement messages
in [`input_controller.ts:197`](packages/winding/win32/input_controller.ts#L197).

Microsoft documents an
[IME crash while processing a cross-thread sent message](https://learn.microsoft.com/en-us/troubleshoot/windows/win32/ime-crash-processing-cross-thread-sent-message)
under exactly this shape:

- the UI thread is inside `TranslateMessage` processing keyboard input;
- a Windows IME internally calls `PeekMessage`;
- that call dispatches a pending message sent from another thread; and
- the reentered WNDPROC calls an `Imm*` function while the IME is already active on the stack.

The message filter does not prevent the problem because sent messages are non-queued and are delivered as part of
`PeekMessage` processing. The current implementation has no “inside TranslateMessage/IME” guard and no
`InSendMessageEx`-style detection/defer path. A cross-thread `SendMessage` that reaches any IMM-calling branch can
therefore trigger the documented crash.

The same reentrancy exposes a separate event-correlation weakness: `#takePreparedKey` consumes a prepared key after
comparing type/keycode/code but not the window or full native-message identity at
[`input_controller.ts:544`](packages/winding/win32/input_controller.ts#L544). A reentered matching key message for
another Winding HWND can consume an event that still references the original window. The ordinary non-reentrant dispatch
path is safe; the sent-message guard should also make prepared-key matching window/message exact and leave the outer
prepared record intact on a mismatch.

**Required fix:** mark the `TranslateMessage` interval, detect WNDPROC reentry caused specifically by a cross-thread
sent message, and defer `Imm*` operations reached through that sent-message reentry until the outer translation has
returned. Do not defer ordinary queued/IME composition processing merely because it is related to the key being
translated. The deferred work must preserve focus/association ordering and remain inside the owner UI thread. Avoid
solving this with a broad lock; the issue is same-thread reentrancy and a lock can deadlock.

**Required test:** a native helper thread should synchronously send focus/IME-relevant messages while the UI thread
translates input under an installed Microsoft IME. Run the scenario repeatedly in a subprocess so any native crash is a
clean test failure.

### W32-11 — HIMC association and observed IME-active state are conflated

**Severity:** Medium **Confidence:** Confirmed state-model gap; native message ordering requires validation

`ImeActivationState` has one `active` bit representing the public native activation transition. The Win32 controller
also implicitly uses it as proof of whether an HIMC is associated. Those are not the same native state.

On `WM_IME_SETCONTEXT(FALSE)`, the controller cancels composition and calls `markActive(false)` at
[`input_controller.ts:306`](packages/winding/win32/input_controller.ts#L306). It does **not** call
`ImmAssociateContextEx(hwnd, NULL, 0)`. If the later `WM_KILLFOCUS` branch sets `focused = false` and calls reconcile at
[`input_controller.ts:213`](packages/winding/win32/input_controller.ts#L213), shared reconciliation sees
`shouldBeActive === active === false` and returns without invoking its deactivation action at
[`activation.ts:48`](packages/winding/input/activation.ts#L48). Turning desired IME off in the same state has the same
skip.

[`WM_IME_SETCONTEXT`](https://learn.microsoft.com/en-us/windows/win32/intl/wm-ime-setcontext) reports
activation/deactivation of the input context/UI for that window; it is not evidence that the window's persistent
input-context association was removed. Microsoft's
[input-context model](https://learn.microsoft.com/en-us/windows/win32/intl/input-context) keeps associations separately
and selects the associated context when focus returns. The permitted state is therefore:

    desired=false, focused=false, public active=false, HIMC still associated=true

On later focus, Windows can select that retained context before the backend's event-facing state says IME is enabled,
and default handling may expose native UI/composition while the controller gates it as disabled. The reviewed
documentation does not specify the relative order needed for this native trigger, so it requires a Windows ordering
test. The model gap itself is direct: once the order above produces the inconsistent state, ordinary reconciliation does
not repair it while desired remains false. A later successful active/deactivate transition, detach, or unconditional
teardown can repair it.

**Required fix:** track `associated` independently from desired/focused/public-active state. Whenever desired or focus
becomes false, attempt and confirm `ImmAssociateContextEx(hwnd, NULL, 0)` regardless of the event-facing active bit.
Treat SETCONTEXT as a native activation/UI observation, not association ownership.

**Required test:** cover both SETCONTEXT-before-KILLFOCUS and KILLFOCUS-before-SETCONTEXT, disabling while blurred,
switching between two Winding windows, and refocusing after each order. Query or instrument the actual HIMC association.

### W32-12 — Ignored IMM results let native and public state diverge

**Severity:** Medium **Confidence:** Confirmed failure-handling defect

After correcting W32-02's `BOOL` declarations, the controller still ignores several return values whose success is
required for its next JavaScript transition:

- `attach()` ignores the result of initial disassociation and then sets availability true at
  [`input_controller.ts:130`](packages/winding/win32/input_controller.ts#L130).
- `detach()` ignores cancellation and disassociation failures at
  [`input_controller.ts:152`](packages/winding/win32/input_controller.ts#L152).
- reconciliation checks activation success, but its deactivation closure ignores `ImmAssociateContextEx` and shared
  state unconditionally reports disabled at
  [`input_controller.ts:741`](packages/winding/win32/input_controller.ts#L741).
- cancellation ignores [`ImmNotifyIME`](https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-immnotifyime)
  failure, then clears composition and echo state at
  [`input_controller.ts:756`](packages/winding/win32/input_controller.ts#L756).
- candidate and composition placement ignore both setter results at
  [`input_controller.ts:767`](packages/winding/win32/input_controller.ts#L767).
- the `finally` path calls but does not check
  [`ImmReleaseContext`](https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-immreleasecontext) at
  [`input_controller.ts:651`](packages/winding/win32/input_controller.ts#L651).

The most consequential failures are association and cancellation. A failed disassociation can leave native IME enabled
after an `ime/disabled` event. A false cancellation result means cancellation was not confirmed, while the shared model
nevertheless emits a preedit clear; native composition may remain live and must be observed/recovered rather than
assumed gone. Depending on the actual association/context state, such residue may affect a subsequently focused Winding
window. An ignored release failure is separately a resource/error-observability problem. Placement failure is less
severe but makes the public cursor-area setter silently ineffective.

[`ImmAssociateContextEx`](https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-immassociatecontextex) and the
setters/notifier all specify success through `BOOL`; optimistic local state is not an allowed substitute.

**Required fix:** make association-state changes conditional on confirmed success. Extend the activation action model so
deactivation can fail, or track native association separately as W32-11 requires. Native errors reached inside WNDPROC
must be captured/deferred rather than thrown through the ABI. If the cross-platform model requires clearing public
composition despite native cancel failure, retain a separate degraded/native-dirty state and force/retry disassociation
before reporting a clean transition.

**Required test:** inject false results independently for association, cancellation, both placement setters, and
release. Assert that public activation never claims a native transition that did not happen and that failure recovery
does not leak composition to another window.

### W32-13 — `event()` removes and silently discards `WM_QUIT` and thread messages

**Severity:** Medium **Confidence:** Confirmed embedding defect

The pump calls `PeekMessageW` with `hWnd = NULL`, no message filter, and `PM_REMOVE` at
[`mod.ts:428`](packages/winding/win32/mod.ts#L428). This selects the entire current thread queue, not only Winding
HWNDs. Microsoft states that
[`PeekMessageW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-peekmessagew) always retrieves
`WM_QUIT`, irrespective of filters.

The loop does not inspect `MSG.message`. It passes every removed record to `TranslateMessage` and `DispatchMessageW`.
[`WM_QUIT`](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-quit) has no HWND and is not dispatched to a
WNDPROC, so its exit code and termination request disappear. Other application-defined thread messages with
`hwnd == NULL` are likewise removed and generally have nowhere to dispatch. The backend continues polling as if no quit
were requested.

Pumping ordinary messages for other same-thread HWNDs can be a legitimate cooperative-loop design. Consuming non-window
messages and quit without a documented ownership contract is not. It makes Winding hazardous inside a host that already
owns the thread queue.

**Required fix:** inspect the `MSG` before translation/dispatch and define thread-queue ownership. Options include
exposing a quit/thread-message result, reposting `WM_QUIT` once while entering a persistent quit-seen state, or changing
the API so the host pumps and forwards messages. Simply peeking `WM_QUIT` with `PM_NOREMOVE` on every call would create
a permanent polling obstruction and needs an accompanying state policy.

**Required test:** post `WM_QUIT` with a distinctive exit code and post custom `WM_APP` thread messages; assert they are
preserved or surfaced exactly according to the documented policy.

### W32-14 — Restore can suppress resize, and packed `WM_SIZE` dimensions are not authoritative

**Severity:** Medium **Confidence:** Confirmed event defect

The `WM_SIZE` handler makes visibility and size mutually exclusive at
[`mod.ts:256`](packages/winding/win32/mod.ts#L256): if minimized state changes, it emits only `visibilitychange`; the
`resize` branch is an `else if`. A `SIZE_RESTORED` message that changes the window from minimized to visible therefore
cannot report its dimensions. If the window was resized while minimized, the consumer retains the pre-minimize render
size until an unrelated later resize. Zero-width or zero-height non-minimized sizes are also silently discarded even
though the shared interface does not declare a positive-only invariant.

There is an independent native-width issue. [`WM_SIZE`](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-size)
packs width and height into 16-bit halves even though Win32 window dimensions are otherwise signed `int`. The current
low/high-word decode at [`mod.ts:258`](packages/winding/win32/mod.ts#L258) can truncate an extremely large client area.
Microsoft recommends obtaining full dimensions through `GetClientRect` when the 16-bit message fields are insufficient.

**Required fix:** process minimized/restored visibility and client-size changes independently. Query `GetClientRect` for
authoritative dimensions, particularly on restore and for any value near the packed limit. Explicitly define and
consistently handle zero-sized drawable surfaces.

**Required test:** resize while minimized and restore; restore to unchanged and changed dimensions; force a zero client
dimension if the system permits; and use a programmatic oversized window to verify no 16-bit wrap.

### W32-15 — `WM_KEYDOWN` repeat counts are collapsed to one semantic event

**Severity:** Medium **Confidence:** Confirmed event-loss defect

`decodeKeyLParam` correctly reads the documented low-word repeat count at
[`input.ts:110`](packages/winding/win32/input.ts#L110). Both prepared and fallback key paths then retain only bit 30 as
a boolean `repeat` value at [`input_controller.ts:399`](packages/winding/win32/input_controller.ts#L399) and
[`input_controller.ts:584`](packages/winding/win32/input_controller.ts#L584).

Microsoft's [`WM_KEYDOWN`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-keydown) contract allows one
message to represent multiple autorepeats. The character path preserves that multiplicity because the later `WM_CHAR`
repeat count is expanded by `WmCharDecoder`. The non-character path exposes only one event, so the consumer has no way
to know that five Backspace, Delete, arrow, PageUp, or shortcut repeats were represented; a conventional
one-event/one-edit consumer therefore performs one edit. The public boolean tells it only whether the represented
transition is a repeat, not how many operations were coalesced.

**Required fix:** enqueue one public keydown for every native count represented. If bit 30 is clear, the first is
non-repeat and any remaining represented transitions are repeats; if it is set, all are repeats. Alternatively extend
the shared event contract with an explicit count and make every consumer honor it, but that is a broader API change.

**Required test:** synthesize counts greater than one for printable input, Backspace, Delete, arrows, and shortcuts.
Assert matching keydown multiplicity and exactly matching commit/edit multiplicity without double-expanding characters.

### W32-16 — `IMR_QUERYCHARPOSITION` fabricates geometry for arbitrary characters

**Severity:** Medium **Confidence:** Confirmed API mismatch

The `WM_IME_REQUEST` handler reads the caller's `dwCharPos`, but always answers it with the one cached editor cursor
rectangle at [`input_controller.ts:813`](packages/winding/win32/input_controller.ts#L813). `encodeImeCharPosition`
simply echoes the requested position and writes that same rectangle's top-left/height at
[`imm.ts:74`](packages/winding/win32/imm.ts#L74). It also reports the entire HWND client rectangle as `rcDocument` at
[`input_controller.ts:801`](packages/winding/win32/input_controller.ts#L801).

The [`IMR_QUERYCHARPOSITION`](https://learn.microsoft.com/en-us/windows/win32/intl/imr-querycharposition) contract asks
for the screen position of the **requested character offset** in the composition string.
[`IMECHARPOSITION`](https://learn.microsoft.com/en-us/windows/win32/api/imm/ns-imm-imecharposition) defines `pt` as that
character's top-left and `rcDocument` as the application's editable text area. A single candidate anchor is not a
mapping from all UTF-16 composition offsets to glyphs, and the full client area is not necessarily the editor. The
current response cannot faithfully answer arbitrary non-current offsets and will generally be wrong for them,
multiline/proportional preedit, scrolling, or an editor smaller than the window. It also returns success without
requiring focused/active composition.

The coordinate-space choice is correct for normalized, representable input: character-position responses use screen
coordinates, and `ClientToScreen` is appropriate after W32-02's result fix. The data being converted is the wrong data,
and even equality with the cached composition cursor would not prove that the application has published a current
rendered anchor.

**Required fix:** extend the synchronous cross-platform input contract so the backend can obtain character geometry for
composition UTF-16 offsets and the actual editable-document rectangle. Until then, return zero/default processing unless
the requested offset can be proven to be the currently cached collapsed caret and an accurate document rectangle is
available. Gate success on focused active composition.

**Required test:** request the caret, earlier/later offsets, multiline text, proportional glyphs, scrolling, and an
editor occupying a subset of the client. Verify `pt`, line height, and `rcDocument` in screen coordinates.

### W32-17 — Composition target-clause and selection changes are consumed but lost

**Severity:** Medium **Confidence:** Confirmed information-loss defect

The controller includes `GCS_COMPATTR`, `GCS_COMPCLAUSE`, and the related flags in `GCS_ALL` at
[`input_controller.ts:71`](packages/winding/win32/input_controller.ts#L71). `#handleImeComposition` then reads only
result text, composition text, and cursor position at
[`input_controller.ts:705`](packages/winding/win32/input_controller.ts#L705). It never retrieves the attribute or clause
arrays. A `WM_IME_COMPOSITION` carrying only a target/attribute change is nevertheless reported as handled and does not
reach default processing.

Microsoft's [composition-string model](https://learn.microsoft.com/en-us/windows/win32/intl/composition-string) uses
`ATTR_TARGET_CONVERTED` and `ATTR_TARGET_NOTCONVERTED` to identify the selected target clause. The official
[IMM application guidance](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/using-an-input-method-editor-in-a-game)
uses clause/attribute data so Japanese clause movement highlights the complete target. The shared `ImeCursorRange` can
represent a non-collapsed selection, but Win32 always supplies a collapsed range derived only from `GCS_CURSORPOS`.

The result is stale or absent target highlighting while the user moves among conversion clauses, even though the backend
claims ownership of native preedit rendering. The shared range is structurally capable of representing a target, but its
documentation does not explicitly assign it that IMM meaning.

**Required fix:** retrieve and validate the composition attribute and clause arrays whenever flagged and identify the
target clause. Decide at the shared-contract level whether the non-collapsed cursor range represents that target; if so,
convert validated composition-string boundaries to UTF-8 offsets and expose it. If the range is intentionally
caret-only, make that limitation explicit and add another target-clause representation.

**Required test:** use a current Microsoft Japanese IME, type multi-clause text, move the target between clauses,
convert/unconvert it, and assert every selection-range update including supplementary characters.

### W32-18 — Korean insert-on-type behavior may be emitted as irreversible commits

**Severity:** Medium **Confidence:** Native-validation risk

Every unmatched `WM_CHAR` or `WM_IME_CHAR` is converted into `{ result: ... }` at
[`input_controller.ts:614`](packages/winding/win32/input_controller.ts#L614). `#applyImeUpdate` treats any such result
as final: it calls `composition.commit()` and emits an irreversible public commit at
[`input_controller.ts:597`](packages/winding/win32/input_controller.ts#L597).

Microsoft's
[IMM application guidance](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/using-an-input-method-editor-in-a-game)
documents Korean “insert on type” behavior in which the IME sends a character immediately and later keystrokes modify
that character while composition is still logically active. The backend's `ResultEchoSuppressor` only suppresses
`WM_CHAR` text matching a result already retrieved through `GCS_RESULTSTR`; it cannot retract an unmatched interim
character.

If a current supported Microsoft Korean IME still uses this compatibility path, Winding can commit an intermediate
Hangul syllable, end the shared preedit, and later emit a new update instead of replacing the prior syllable. The public
commit contract explicitly makes that edit atomic and irreversible, so the backend has no repair event. `WM_IME_CHAR`
itself is documented as a conversion result; the plausible interim risk centers on unmatched `WM_CHAR` or another
compatibility stream, which is why an exact modern trace is essential.

This is rated as a native-validation risk because the Microsoft source is authoritative but its sample targets older
DirectX/IMM integration. It should be promoted to High if reproduced with the current inbox Korean IME.

**Required fix if reproduced:** keep insert-on-type characters replaceable while the native composition is active, with
`GCS_COMPSTR`/actual result state authoritative, or extend the shared semantic-edit model to express replacement of
already inserted interim text.

**Required test:** install the current Microsoft Korean IME and record START/COMPOSITION/CHAR/END ordering while
building and modifying Hangul syllables. Assert the final editor contents and the exact public preedit/commit stream.

### W32-19 — DPI awareness and logical/pixel coordinate semantics are undefined

**Severity:** Medium **Confidence:** Contract and integration gap

The backend does not establish or document a DPI-awareness model, does not query per-window DPI, and has no
`WM_DPICHANGED` branch in [`mod.ts:255`](packages/winding/win32/mod.ts#L255). The shared API calls the IME cursor
rectangle “logical client coordinates” at [`types.ts:151`](packages/winding/types.ts#L151), while creation, resize
events, mouse coordinates, DIB pixels, and candidate placement are all passed directly between JS and Win32.

Windows coordinate virtualization depends on the process/thread DPI awareness inherited from the Deno host. Microsoft's
[high-DPI application model](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)
distinguishes DPI-unaware/system-aware virtualized coordinates from per-monitor physical coordinates. Under per-monitor
awareness, [`WM_DPICHANGED`](https://learn.microsoft.com/en-us/windows/win32/hidpi/wm-dpichanged) supplies a suggested
rectangle that the application is expected to apply. Ignoring it makes logical size and physical pixel density drift
when the window crosses monitors. Under an unaware host, GDI/window coordinates can instead be virtualized and bitmap
content scaled/blurry.

Because this is a library loaded into an existing process, unilaterally changing process-wide awareness is unsafe and
may be too late after another component creates a window. But inheriting an arbitrary context without recording it also
fails to define the shared contract.

**Required fix:** define whether public dimensions and blit pixels are logical or physical. Inspect the effective
thread/window awareness, use `GetDpiForWindow` and `AdjustWindowRectExForDpi` where appropriate, handle `WM_DPICHANGED`
under per-monitor awareness, and keep IME/mouse/resize/blit coordinates in one documented space. If the host must set
awareness before `load()`, enforce and document that precondition.

**Required test:** run under unaware, system-aware, and Per-Monitor-V2 host contexts; move between 100%, 150%, and 200%
monitors; assert client size, resize/mouse coordinates, candidate placement, and one-to-one frame pixels according to
the chosen policy.

### W32-20 — `FormatMessageW` is used unsafely for arbitrary system errors

**Severity:** Medium **Confidence:** Confirmed API misuse

`getLastError()` calls `FormatMessageW` with only `FORMAT_MESSAGE_FROM_SYSTEM` (`0x1000`), a null `Arguments` pointer,
and no `FORMAT_MESSAGE_IGNORE_INSERTS` at [`mod.ts:448`](packages/winding/win32/mod.ts#L448).

Microsoft's [`FormatMessageW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-formatmessagew)
security remarks explicitly require care with arbitrary system error codes: messages can contain typed insert sequences,
and omitting `FORMAT_MESSAGE_IGNORE_INSERTS` while supplying no valid argument array is unsafe. At minimum formatting
can fail and hide useful context; an insert-bearing template can also make the formatter interpret nonexistent
arguments.

The fixed 2,048-WCHAR buffer, character-count `nSize`, UTF-16 decoding, and numeric-code fallback text are otherwise
reasonable.

**Required fix:** use `FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS` (`0x1000 | 0x0200`). Preserve the
original numeric code even if formatting itself fails.

**Required test:** format known system messages with and without inserts and fuzz a range of error codes in a subprocess
or native test helper.

### W32-21 — `blit()` does not enforce buffer/size invariants or native completion

**Severity:** Medium **Confidence:** Confirmed robustness defect

The shared method says width and height must match the window dimensions at
[`types.ts:142`](packages/winding/types.ts#L142). The Win32 implementation neither validates that condition nor
validates the more fundamental `rgba.byteLength === width * height * 4` condition at
[`mod.ts:129`](packages/winding/win32/mod.ts#L129).

Concrete failure behavior is poor:

- a short RGBA array updates only a prefix of a reused `#bgra`, leaving pixels from the previous frame;
- a long array is silently truncated by out-of-range typed-array assignments;
- a trailing partial pixel reads missing channels and coerces them;
- fractional, negative, non-finite, unsafe, or `LONG`/`DWORD`-out-of-range dimensions reach allocation, `DataView`, and
  FFI coercions inconsistently;
- multiplication can exceed JavaScript's safe-integer/allocation range;
- the return from
  [`SetDIBitsToDevice`](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-setdibitstodevice) is
  ignored even though it reports the number of scan lines copied (or zero on failure/no lines).

There is also a diagnostics issue:
[`GetDC`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdc) does not document setting last
error on null, but the implementation formats `GetLastError`; that value can describe an unrelated earlier call.

**Required fix:** require finite safe positive integral dimensions in native range; check multiplication/allocation
bounds and exact RGBA length; compare against authoritative current client dimensions; and require the native scan-line
result expected for the operation. Report direct failures from APIs that do not promise a fresh last-error code without
presenting stale text as causative. Post-close safety is handled separately in W32-31.

**Required test:** cover short/long/partial buffers, zero/negative/fractional/NaN/infinite/overflow dimensions, mismatch
with client size, and injected partial/zero `SetDIBitsToDevice` results. Verify that failed calls do not modify the
cached last valid frame used by `WM_PAINT`.

### W32-22 — Several pointer-width declarations have nominally wrong types

**Severity:** Low **Confidence:** Confirmed API mismatch with no current register-width consequence

Beyond W32-02's substantive `BOOL` mismatch, these declarations do not exactly match the SDK:

| Symbol/field                         | Current Deno type | Exact native type / Deno representation                                |
| ------------------------------------ | ----------------- | ---------------------------------------------------------------------- |
| `GetModuleHandleW` result            | `usize`           | `HMODULE`, use `pointer`                                               |
| `LoadCursorW.lpCursorName`           | `usize`           | `LPCWSTR`, use `pointer` (an integer-resource pointer for `IDC_ARROW`) |
| `LoadCursorW` result                 | `usize`           | `HCURSOR`, use `pointer`                                               |
| `UnregisterClassW.hInstance`         | `usize`           | `HINSTANCE`, use `pointer`                                             |
| `CreateWindowExW.X/Y/nWidth/nHeight` | four `u32`        | four signed `int`, use `i32`                                           |
| `CreateWindowExW.lpParam`            | `usize`           | `LPVOID`, use `pointer`                                                |
| `DispatchMessageW` result            | `usize`           | signed `LRESULT`, use `isize`                                          |
| `DefWindowProcW.lParam`              | `usize`           | signed `LPARAM`, use `isize`                                           |
| `DefWindowProcW` result              | `usize`           | signed `LRESULT`, use `isize`                                          |
| WNDPROC `lParam` and result          | `usize`           | signed `LPARAM`/`LRESULT`, use `isize`                                 |

The declarations are in [`ffi.ts:1`](packages/winding/win32/ffi.ts#L1),
[`ffi.ts:46`](packages/winding/win32/ffi.ts#L46), and [`ffi.ts:56`](packages/winding/win32/ffi.ts#L56); the callback
repeats the signedness issue at [`mod.ts:208`](packages/winding/win32/mod.ts#L208).

On Deno's current 64-bit Windows targets, handles and `usize` have the same width as pointers, and `usize`/`isize` use
the same argument/result register. Forwarding through `DefWindowProcW` preserves the bit pattern, so these mismatches do
not presently shift the ABI. They still expose signed native values incorrectly to TypeScript and bypass Deno's
opaque-pointer checking. The unsigned `CreateWindowExW` integers become user-visible as soon as W32-04 stops ignoring
negative coordinates. The current `CW_USEDEFAULT` call happens to be bit-correct because `0x80000000` has the required
`INT_MIN` bit pattern.

**Required fix:** use the exact types above and propagate pointer objects without round-tripping through untyped
integers. Construct the `IDC_ARROW` integer-resource pointer deliberately and document that exception.

Primary declarations:
[`CreateWindowExW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexw),
[`WNDPROC`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nc-winuser-wndproc),
[`DefWindowProcW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-defwindowprocw), and
[Windows pointer-sized types](https://learn.microsoft.com/en-us/windows/win32/winprog/windows-data-types).

### W32-23 — Composition restart and message gating do not recover from stale native state

**Severity:** Low **Confidence:** Defensive/native-validation recovery gap

`WM_IME_STARTCOMPOSITION` calls `state.composition.start()` at
[`input_controller.ts:277`](packages/winding/win32/input_controller.ts#L277). Shared `CompositionState.start()` only
sets `#active = true`; it leaves old text, cursor range, and duplicate-preedit state intact at
[`composition.ts:41`](packages/winding/input/composition.ts#L41). Under the normal complete START/END path prior state
is reset. A missed END, or a failed composition read combined with abnormal focus/context churn or an unexpected
restart, can instead make the new session splice `CS_INSERTCHAR` into stale text or suppress an initial update as a
duplicate. Microsoft's
[`WM_IME_STARTCOMPOSITION`](https://learn.microsoft.com/en-us/windows/win32/intl/wm-ime-startcomposition) marks the
start of a new composition session, not continuation of arbitrary cached state.

The START/COMPOSITION/END branches are also gated only by `activation.desired` at
[`input_controller.ts:277`](packages/winding/win32/input_controller.ts#L277). A delayed or synthetic message can
therefore start/update composition for a blurred, inactive window as long as its editor still desires IME. That can
produce preedit while no `ime/enabled` transition is in force.

**Required fix:** add an explicit restart transition that clears stale native-session state and emits one public clear
only when a previously visible preedit requires it. Gate composition on focused/actually active association, with a
narrowly documented exception only if START itself is deliberately treated as proof of activation.

### W32-24 — Only candidate-list index zero receives placement

**Severity:** Low **Confidence:** Confirmed completeness gap

`encodeCandidateForm` defaults `dwIndex` to zero at [`imm.ts:51`](packages/winding/win32/imm.ts#L51), and the only
caller accepts that default at [`input_controller.ts:767`](packages/winding/win32/input_controller.ts#L767).
[`CANDIDATEFORM`](https://learn.microsoft.com/en-us/windows/win32/api/imm/ns-imm-candidateform) supports candidate-list
indices zero through three. IMEs using secondary lists can retain default or stale placement even though the application
continually updates its cursor area.

**Required fix:** either set placement for all four indices or observe `IMN_OPENCANDIDATE`/related bitmasks and update
every active index.

### W32-25 — `CS_INSERTCHAR` has no supplementary-character assembly

**Severity:** Low **Confidence:** Native-validation risk

When `CS_INSERTCHAR` is present without `GCS_COMPSTR`, the controller immediately converts the low 16 bits of `wParam`
with `String.fromCharCode` at [`input_controller.ts:688`](packages/winding/win32/input_controller.ts#L688). Unlike
`WM_CHAR`, this path has no pending-high-surrogate decoder. If a surrogate-enabled IME reports a supplementary character
as two transient insert-character operations, the first standalone surrogate enters cached preedit; UTF-8 offset
conversion treats it as a replacement scalar, and insertion/cursor math for the second unit no longer describes the
intended character.

Microsoft documents
[surrogate-aware IMEs and supplementary characters](https://learn.microsoft.com/en-us/windows/win32/intl/surrogates-and-supplementary-characters),
but the `CS_INSERTCHAR` documentation does not clearly guarantee the delivery shape for every modern IME. This therefore
needs a real Windows test before being promoted to a confirmed defect.

**Required fix if reproduced:** feed transient insert characters through surrogate assembly equivalent to
`WmCharDecoder`, never cache a standalone surrogate, and keep all cursor offsets at scalar/UTF-16 boundaries before
converting to UTF-8.

### W32-26 — Several virtual keys produce wrong or incomplete DOM-style logical keys

**Severity:** Medium **Confidence:** Confirmed cross-contract mismatch

The public contract requires a layout-aware DOM-style `key` at [`types.ts:46`](packages/winding/types.ts#L46). The
static map at [`input.ts:266`](packages/winding/win32/input.ts#L266) has several exact discrepancies:

- virtual-key value `0x15` aliases `VK_KANA` and `VK_HANGUL`, but is always returned as `KanaMode`; Korean layouts
  require `HangulMode`;
- `0x19` aliases `VK_HANJA` and `VK_KANJI`, but is always returned as `HanjaMode`; Japanese layouts require `KanjiMode`;
- `VK_LAUNCH_MEDIA_SELECT` becomes `MediaSelect`, which is a physical `code`; the standardized logical `key` is
  `LaunchMediaPlayer`; and
- `VK_CANCEL` (`0x03`, commonly Ctrl+Break) is absent and becomes `Unidentified` instead of `Cancel`.

The aliases are documented in Microsoft's
[virtual-key table](https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes); the logical names are
defined by the W3C [`key`](https://www.w3.org/TR/uievents-key/) recommendation, distinct from physical
[`code`](https://www.w3.org/TR/uievents-code/).

**Required fix:** add the missing/correct fixed names and disambiguate language-key aliases using the active
HKL/language rather than numeric virtual key alone.

**Required test:** assert key/code/location under current Japanese and Korean layouts plus media-select and Ctrl+Break
hardware/synthetic input.

### W32-27 — `VK_PACKET` has no guaranteed text-input classification

**Severity:** Medium **Confidence:** Documented invariant gap; native translation behavior requires validation

`VK_PACKET` is defined at [`input.ts:83`](packages/winding/win32/input.ts#L83) but has no logical-key or disposition
path. Microsoft specifies that
[`KEYEVENTF_UNICODE`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput) input
synthesizes `VK_PACKET`, and `TranslateMessage` then posts the original Unicode `WM_CHAR`.

Microsoft does not specify what `ToUnicodeEx(VK_PACKET, ...)` returns. If it supplies no ordinary layout text—as must be
verified on supported Windows versions—the generic path exposes `key: "Unidentified"` and
`editDisposition: "key-default"`, while the guaranteed later `WM_CHAR` still emits a commit. The ownership is therefore
dependent on undocumented translation behavior even though the packet is definitionally text-producing. A typical editor
has no default for `Unidentified`/`VK_PACKET`, so a duplicate edit is a risk rather than a guaranteed outcome; the
shared ownership rule should not rely on that accident.

**Required fix:** classify `VK_PACKET` as native text input. If the generated scalar can be recovered safely before
dispatch, use it as the logical key; otherwise `Unidentified` is preferable to inventing a value, but disposition must
still suppress the ordinary editor default.

**Required test:** use `SendInput(KEYEVENTF_UNICODE)` for BMP and supplementary scalars. Expect one packet keydown/up
per UTF-16 code unit (therefore two pairs for a supplementary scalar), one scalar commit after surrogate assembly,
text-input ownership for every packet keydown, and no duplicate edit.

### W32-28 — Consumed mouse messages still fall through to `DefWindowProcW`

**Severity:** Low **Confidence:** Forward-integration risk

Every mouse branch enqueues a Winding event and then `break`s, reaching the common `DefWindowProcW` call at
[`mod.ts:275`](packages/winding/win32/mod.ts#L275) and [`mod.ts:336`](packages/winding/win32/mod.ts#L336). The mouse
message contracts specify zero as the application's processed return, but `DefWindowProcW` may itself return zero, so
the current call does not prove a return-value violation. Current windows are also parentless top-level windows, so no
duplicate is confirmed. The unnecessary default call becomes a concrete integration risk if the backend later hosts
child windows because default wheel processing can propagate to a parent.

**Required fix:** return `0n` after successfully consuming each mouse message. Use default processing only for messages
the backend intentionally leaves unhandled.

Sources: [`WM_MOUSEMOVE`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousemove),
[`WM_LBUTTONDOWN`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-lbuttondown), and
[`WM_MOUSEWHEEL`](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousewheel).

### W32-29 — AltGr capability probing and synthetic-Control filtering are incomplete

**Severity:** Low **Confidence:** Layout-dependent robustness defect

The layout probe at [`input_controller.ts:487`](packages/winding/win32/input_controller.ts#L487) considers only
unshifted AltGr translations with a positive `ToUnicodeEx` result.
[`ToUnicodeEx`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-tounicodeex) returns a negative
value for dead keys, so a layout whose distinct AltGr level contains only dead keys is classified as non-AltGr. A layout
exposing distinct text only at Shift+AltGr is also missed because Shift is never probed. The probe passes scan code zero
even though the API accepts the hardware scan code, so scan-sensitive custom mappings can also be missed.
`TU_NO_STATE_CHANGE` prevents mutation but does not make the result independent of a dead-key state that was already
pending. Right Alt can then be named/owned like ordinary Alt, and its `WM_SYSCHAR`/dead-character path may be left to
the platform.

Separately, `AltGraphControlFilter` stores only one boolean saying that the next unextended Control-up is synthetic at
[`input.ts:385`](packages/winding/win32/input.ts#L385). A constructed/adversarial interleaving can therefore make it
suppress a genuine release rather than the synthetic partner. The code path is demonstrable, but normal physical Windows
input still needs to be shown to produce such an interleaving.

**Required fix:** probe positive, negative/dead, and shifted AltGr levels; compare the full translation kind/text with
the plain level. Track the exact synthetic sequence using its timestamp/message identity and right-Alt lifetime rather
than a free-standing boolean.

### W32-30 — Printable logical keys are not NFC-normalized or validated

**Severity:** Low **Confidence:** Confirmed cross-contract mismatch

`translateLogicalKey` accepts any non-control string returned by `ToUnicodeEx` and forwards it as `key` at
[`input.ts:237`](packages/winding/win32/input.ts#L237). Shared `normalizeLogicalKey` only replaces empty/undefined
values at [`keyboard.ts:4`](packages/winding/input/keyboard.ts#L4).

The W3C [`KeyboardEvent.key` values](https://www.w3.org/TR/uievents-key/) recommendation requires a printable key string
to be NFC and to contain at most one non-control base character followed by combining characters. Windows/custom layouts
can return decomposed output or multi-character ligatures. Such text is valid for the later commit, but it is not
automatically a valid DOM-style logical key. The current backend can expose decomposed or multiple-base strings outside
its promised model.

**Required fix:** NFC-normalize the logical-key candidate and validate the key-string grammar. Use `Unidentified` when a
translation cannot be represented as one valid key string while preserving the complete text for the subsequent commit.

**Required test:** cover decomposed dead-key output, a base plus combining marks, a supplementary scalar, and a
custom-layout ligature containing multiple base characters.

### W32-31 — Public mutation methods use a retained HWND after close

**Severity:** Medium **Confidence:** Confirmed lifecycle defect

Successful `Win32Window.close()` destroys the native window but retains the immutable `#hwnd` value and sets only a
JavaScript `#closed` flag at [`mod.ts:179`](packages/winding/win32/mod.ts#L179). The IME setters check that flag and
return, but `setTitle()` and `blit()` do not: they call `SetWindowTextW` or `GetDC` with the retained handle at
[`mod.ts:109`](packages/winding/win32/mod.ts#L109) and [`mod.ts:129`](packages/winding/win32/mod.ts#L129).

This is worse than a predictable invalid-handle error. Microsoft warns in
[`IsWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindow) documentation that HWND
values are recycled and can later identify a different window. A concrete sequence is close window A, create window B
that reuses A's numeric HWND, then call `A.setTitle()` or `A.blit()`. The stale object can mutate or draw into B. If the
whole library was also closed, the call additionally reaches Deno dynamic-library symbols that are no longer valid.

Calling `IsWindow` before each operation is not a fix: even a true result cannot establish that the handle still belongs
to this object, and it introduces a time-of-check/time-of-use race. The JavaScript object already has the authoritative
closed state.

**Required fix:** make every public native method check `#closed` before using the HWND and choose one consistent
cross-platform policy—stable exception or no-op. A stable exception is preferable for title/blit because silently
accepting a render/title update that did not occur hides application bugs. Never ask User32 to validate ownership after
the object has closed.

**Required test:** spy/inject the native calls and prove none occur after close, both while the library remains open and
after it closes. Add a stress subprocess that churns windows to encourage HWND reuse and verifies an old object cannot
mutate a new window.

## Exact FFI declaration audit

The comparison below treats Deno `buffer` as an acceptable typed-array pointer for required input/output buffers and
`pointer` as the correct representation for nullable/opaque native pointers. It distinguishes exact native
width/signedness from declarations that merely preserve the same 64-bit register bits.

### Mismatches

| DLL / symbol                    | Native declaration detail                                | Current binding          | Verdict                                         |
| ------------------------------- | -------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| kernel32 `GetModuleHandleW`     | returns `HMODULE`                                        | `usize`                  | Nominal handle mismatch; use `pointer` (W32-22) |
| user32 `GetKeyboardState`       | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `ClientToScreen`         | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `GetClientRect`          | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `ReleaseCapture`         | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `SetWindowTextW`         | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `DestroyWindow`          | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `LoadCursorW`            | `LPCWSTR` resource pointer, returns `HCURSOR`            | `usize`, returns `usize` | Nominal pointer/handle mismatch (W32-22)        |
| user32 `TrackMouseEvent`        | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `UnregisterClassW`       | `HINSTANCE`, returns `BOOL`                              | `usize`, returns `bool`  | Handle mismatch plus wrong result width         |
| user32 `CreateWindowExW`        | X/Y/width/height are signed `int`; `lpParam` is `LPVOID` | four `u32`; `usize`      | Signedness/pointer mismatch (W32-04/W32-22)     |
| user32 `PeekMessageW`           | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `TranslateMessage`       | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| user32 `DispatchMessageW`       | returns signed `LRESULT`                                 | `usize`                  | Signed pointer-width mismatch (W32-22)          |
| user32 `DefWindowProcW`         | `LPARAM` and `LRESULT` are signed pointer-width          | `usize` and `usize`      | Signed pointer-width mismatch (W32-22)          |
| Deno WNDPROC callback           | `LPARAM` and `LRESULT` are signed pointer-width          | `usize` and `usize`      | Signed pointer-width mismatch (W32-22)          |
| imm32 `ImmReleaseContext`       | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| imm32 `ImmAssociateContextEx`   | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| imm32 `ImmSetCandidateWindow`   | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| imm32 `ImmSetCompositionWindow` | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| imm32 `ImmNotifyIME`            | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| smoke `ShowWindow`              | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |
| smoke `PostMessageW`            | returns 32-bit `BOOL`                                    | `bool`                   | Wrong width (W32-02)                            |

### Declarations verified exact

| DLL / symbol                     | Verified native shape                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| kernel32 `GetLastError`          | no parameters, `DWORD`/`u32` result                                                                             |
| kernel32 `FormatMessageW`        | `DWORD` flags/id/language/size/result and pointer parameters; declaration exact, call flags wrong per W32-20    |
| gdi32 `SetDIBitsToDevice`        | `HDC`, signed destination/source origins, unsigned extents/scan indexes, bits/BITMAPINFO pointers, `int` result |
| user32 `GetDC`                   | `HWND` pointer to `HDC` pointer                                                                                 |
| user32 `GetKeyState`             | signed `int` virtual key to signed `SHORT`/`i16`                                                                |
| user32 `GetKeyboardLayout`       | `DWORD` thread id to `HKL` pointer                                                                              |
| user32 `ToUnicodeEx`             | `UINT` key/scan, byte-state and WCHAR buffers, signed buffer count/result, flags, `HKL`                         |
| user32 `ReleaseDC`               | two handle pointers to signed `int` result                                                                      |
| user32 `SetCapture`              | `HWND` pointer to previous `HWND` pointer/null                                                                  |
| user32 `RegisterClassExW`        | structure pointer to `ATOM`/`u16`                                                                               |
| user32 `CreateWindowExW`         | all parameters not listed as mismatches above, plus `HWND` pointer result                                       |
| user32 `PeekMessageW`            | MSG/HWND pointers, `UINT` filters/removal flags; only result is mismatched                                      |
| user32 `DefWindowProcW`          | `HWND`, `UINT`, and unsigned pointer-width `WPARAM`; only `LPARAM`/result are mismatched                        |
| imm32 `ImmGetContext`            | `HWND` pointer to `HIMC` pointer/null                                                                           |
| imm32 `ImmGetCompositionStringW` | `HIMC`, `DWORD` index/byte length, nullable output pointer, signed `LONG` result                                |
| smoke `SendMessageW`             | `HWND`, `UINT`, `WPARAM=usize`, `LPARAM=isize`, `LRESULT=isize`                                                 |

No native function in the reviewed interface has a Win32 `BOOL` parameter, so the required `i32` correction is confined
to results.

## Native structure and architecture audit

### Pointer-bearing structures

The manually encoded layouts are correct for both current Deno Windows architectures:

| Structure         | Current size | Verified 64-bit offsets                                                                                                     | 32-bit x86 size |
| ----------------- | -----------: | --------------------------------------------------------------------------------------------------------------------------- | --------------: |
| `WNDCLASSEXW`     |           80 | `cbSize` 0, `style` 4, WNDPROC 8, extras 16/20, instance 24, icon 32, cursor 40, brush 48, menu 56, class 64, small icon 72 |              48 |
| `TRACKMOUSEEVENT` |           24 | size 0, flags 4, HWND 8, hover time 16, trailing alignment                                                                  |              16 |
| `MSG`             |           48 | HWND 0, message 8, WPARAM 16, LPARAM 24, time 32, POINT 36/40, private field 44                                             |              32 |

Sources: [`WNDCLASSEXW`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-wndclassexw),
[`TRACKMOUSEEVENT`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-trackmouseevent), and
[`MSG`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msg).

Deno currently publishes Windows runtimes for x64 and ARM64 and exposes only `x86_64 | aarch64` through
[`Deno.build.arch`](https://docs.deno.com/api/deno/~/Deno.build.arch). Both use the verified 64-bit layouts, and
Microsoft's x64/ARM conventions make `__stdcall`/`CALLBACK` compatible with the ordinary platform ABI. The code would be
unusable on hypothetical Deno Windows x86: sizes, pointer offsets, and callback convention assumptions would all be
wrong. That is not a reachable current bug, but the backend should assert/document the 64-bit support boundary so a
future Deno target fails clearly.

### Pointer-free structures

The constants described in `ffi.ts` as “64-bit” are actually architecture-independent because the structures contain
only fixed-width Win32 fields:

| Structure         | Size | Verified offsets                                                           |
| ----------------- | ---: | -------------------------------------------------------------------------- |
| `POINT`           |    8 | signed LONG X/Y at 0/4                                                     |
| `RECT`            |   16 | four signed LONG values at 0/4/8/12                                        |
| `CANDIDATEFORM`   |   32 | index 0, style 4, point 8, rectangle 16                                    |
| `COMPOSITIONFORM` |   28 | style 0, point 4, rectangle 12                                             |
| `IMECHARPOSITION` |   36 | size 0, character offset 4, point 8, line height 16, document rectangle 20 |

The encoders use little-endian fields, which is correct for supported Windows x64/ARM64.

### DIB layout

The rendering structures and byte conversion are correct in isolation:

- `BITMAPINFOHEADER` is exactly 40 bytes.
- `biPlanes = 1`, `biBitCount = 32`, and `BI_RGB` require no following color table.
- Negative `biHeight` requests the intended top-down DIB.
- Four bytes per pixel makes every row DWORD-aligned without added padding.
- The code writes source R/G/B into destination byte positions 2/1/0, yielding the BGRX memory order expected by 32-bpp
  `BI_RGB`. The inline arrows on the B and R assignments are mislabeled, but the operations themselves are correct.
- The copied fourth byte is not alpha blended by `SetDIBitsToDevice`; it is unused padding for this operation.

Source: [`BITMAPINFOHEADER`](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader) and
[`SetDIBitsToDevice`](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-setdibitstodevice).

## Constants and support-boundary audit

The reviewed numeric constants match current SDK values:

- the `WM_*` values currently present in `ffi.ts`, including keyboard, system-key, IMM, size, close, focus, mouse, and
  wheel messages;
- `GCS_*`, `CS_INSERTCHAR`, and `CS_NOMOVECARET` composition flags;
- `IACE_DEFAULT`/`IACE_IGNORENOCONTEXT`;
- `NI_COMPOSITIONSTR` and all `CPS_*` values;
- `CFS_*`, `ISC_SHOWUICOMPOSITIONWINDOW`, and `IMR_QUERYCHARPOSITION`;
- `PM_NOREMOVE`, `PM_REMOVE`, `PM_NOYIELD`, `WHEEL_DELTA`, and `SIZE_MINIMIZED`;
- `TME_LEAVE`, `UNICODE_NOCHAR`, and `IDC_ARROW` (`32512`); and
- the window style `WS_VISIBLE | WS_OVERLAPPEDWINDOW` and class styles `CS_HREDRAW | CS_VREDRAW | CS_OWNDC` represented
  by the implementation's hex literals.

`TU_NO_STATE_CHANGE`/`TO_UNICODE_NO_STATE_CHANGE` bit 2 is also correct.
[`ToUnicodeEx`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-tounicodeex) documents it from
Windows 10 version 1607 onward. Deno requires Windows 10 version 1709 or later according to its current
[installation requirements](https://docs.deno.com/runtime/getting_started/installation/), so using the flag
unconditionally is safe within the actual runtime support boundary. It would become a compatibility issue only if this
package were hosted by a different older-Windows runtime.

Missing constants such as `WM_CAPTURECHANGED` are functional omissions covered by findings, not wrong numeric
definitions.

## Verified-correct implementation areas

These checks are included to distinguish actual defects from hand-written native code that merely looks risky.

### Window, GDI, and resource ownership

- `wideStringBuffer` copies JavaScript UTF-16 code units exactly and appends one UTF-16 NUL. This is appropriate for the
  `W` APIs on supported little-endian Windows targets. Embedded NUL in a public title will still truncate because that
  is the native string contract.
- `GetModuleHandleW(NULL)` does not increment the module reference count, and the implementation correctly does not call
  `FreeLibrary` on the returned executable HMODULE.
- `LoadCursorW(NULL, IDC_ARROW)` returns a shared system cursor. Not calling `DestroyCursor` is correct; Microsoft
  explicitly says shared cursors must not be destroyed. See
  [`DestroyCursor`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-destroycursor).
- The happy-path ordering—destroy windows, close input, unregister the class, then close the callback and DLLs—is
  conceptually correct. W32-01 concerns continuing past a failed stage.
- Returning zero for `WM_CLOSE` after enqueueing a close request correctly prevents `DefWindowProcW` from destroying the
  window before the application decides to close it. See
  [`WM_CLOSE`](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-close).
- `SetCapture` returning null is not an error; it means there was no previous capture owner. The implementation
  appropriately does not treat it as a failed acquisition, although W32-08 requires real ownership tracking.
- `GetDC` is paired with `ReleaseDC` in `finally`. Because the class uses `CS_OWNDC`, release has no effect on that
  private DC and may return zero; calling it is harmless and should not itself be treated as an error. See
  [`GetDC`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdc) and
  [`ReleaseDC`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-releasedc).
- The callback wrapper catches JavaScript exceptions and defers them rather than unwinding through the native WNDPROC
  ABI. Its fallback attempts `DefWindowProcW` and also prevents a secondary failure from escaping. That is an important
  Win64 safety property.
- The native wheel high word is correctly sign-extended, divided by `WHEEL_DELTA`, and kept fractional for
  high-resolution input. The public type does not document wheel units or sign, so this review does not use another
  platform to declare the chosen vertical/horizontal public sign correct.

### Keyboard translation

- Keyboard `lParam` decoding correctly reads repeat count, the documented OEM-dependent scan-code byte, E0 extension,
  Alt context, previous-state, and transition bits.
- The conventional Windows/Chromium scan-code/E0 table provides the expected DOM physical codes, including left/right
  modifiers, numpad Enter/divide, navigation, media, browser, and international keys represented in the table. Win32
  documents the raw scan byte as OEM-dependent rather than normatively guaranteeing Set 1 for every device.
- Taking `GetKeyboardState` after `PeekMessageW(PM_REMOVE)` is correct: removal synchronizes the calling thread's
  keyboard state for that message. The `GetKeyState` fallback preserves the modifiers and Caps Lock toggle used by this
  implementation when snapshot acquisition fails; it does not reconstruct Num Lock or Scroll Lock toggles, which are not
  exposed here.
- `GetKeyboardLayout(0)` correctly selects the calling thread's HKL, and clearing cached layout classification on
  `WM_INPUTLANGCHANGE` is appropriate.
- For supported Windows versions, `ToUnicodeEx` is called with the non-mutating flag, a 16-unit UTF-16 buffer, the
  active HKL, and correct signed-result handling. Sixteen units are sufficient for normal known layouts, but the API
  publishes no maximum for arbitrary/custom layout output. Negative dead-key results become `key: "Dead"`; failed
  translation falls back without mutating the event loop's dead-key state.
- Clearing Ctrl/Alt only for ordinary shortcut logical-key lookup while retaining Shift/Caps is conceptually correct.
  The recognized right-Alt AltGr path also preserves native Ctrl+Alt state and excludes synthetic Control from
  `accelKey`; W32-09 and W32-29 cover the missing forms.
- Keydown-to-keyup logical-key caching prevents layout or modifier changes from changing the released key's identity.
- `WM_CHAR`/`WM_IME_CHAR` decoding correctly pairs UTF-16 surrogates, emits replacement characters when a following unit
  or explicit flush exposes malformed sequences, filters control text, and applies repeat count only after scalar
  assembly. Teardown/reset deliberately discards a terminal pending high surrogate rather than emitting an event.
- `WM_UNICHAR` returns true for the `UNICODE_NOCHAR` capability probe, validates real scalar values, expands their
  repeat count, and returns zero after handling.
- Normal `WM_SYSKEY*`/`WM_SYSCHAR` paths are left to default processing, preserving Windows menus, access keys, F10,
  Alt+Space, and similar system behavior. Only text-owned AltGr paths should be consumed.
- Generated-character ordering in the unfiltered pump is sound: `TranslateMessage` posts the character, the current
  keydown is dispatched, and the next unfiltered `PeekMessage` retrieves the posted character before a later hardware
  key-up. The code does not have a general keyup-before-character bug.
- The result-echo suppressor correctly consumes a matching optional character-message echo according to its policy,
  including surrogate and repeat expansion. Whether current IMEs produce that echo after this custom handling, and
  whether the timeout can suppress unrelated matching text, still needs native testing.

### IMM composition and geometry

- `ImmGetContext` acquisition is paired with exactly one `ImmReleaseContext` attempt in a `finally`, including callback
  exceptions. The backend does not destroy the thread-owned default HIMC.
- `ImmGetCompositionStringW` lengths are correctly treated as bytes, not UTF-16 code units. The reader excludes
  terminators, rejects odd/negative lengths, bounds copied data, retries detected nonzero buffer growth, and decodes
  explicit UTF-16LE. A zero first query returns empty immediately, and equal-length content races are inherently
  undetectable.
- `GCS_CURSORPOS` is correctly requested as a direct numeric result, not a copied buffer. Valid UTF-16 boundaries are
  converted to the public UTF-8 byte range; positions inside a surrogate pair are rejected.
- A message carrying both `GCS_RESULTSTR` and `GCS_COMPSTR` commits the old preedit first and then starts/updates the
  next preedit. That matches the shared atomic-commit contract.
- A zero-data `WM_IME_COMPOSITION` clears composition as documented.
- `CS_INSERTCHAR` and `CS_NOMOVECARET` are implemented correctly for BMP characters when the cached collapsed cursor is
  valid/current: insertion uses that caret and optionally leaves it unmoved. With no cursor, the helper falls back to
  the cached text end, which is not proof of IMM's actual insertion point.
- Consuming START/COMPOSITION/END and returning zero is correct when the application renders its own preedit.
- `WM_IME_SETCONTEXT` is forwarded to `DefWindowProcW` with only `ISC_SHOWUICOMPOSITIONWINDOW` cleared when
  `activation.desired` is true. Native candidate UI flags are preserved; desired state is not always proof that
  composition UI is actually active after the failures described in W32-11/W32-12.
- Unsupported or failed `WM_IME_REQUEST` handling falls through to default processing.
- `ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` uses the correct action/index/value tuple.
- Candidate and composition forms correctly use client-relative coordinates. For normalized representable inputs, the
  character-position response uses the correct client-to-screen conversion space. W32-16 concerns the semantic
  rectangle/character chosen and whether the published anchor is current.
- Cursor-area normalization rejects non-finite input, outward-rounds fractional logical rectangles, prevents negative
  dimensions, and clamps encoded Win32 `LONG` fields.

## Test and CI assessment

### What the pure tests cover well

`packages/winding/win32/input_test.ts` contains focused, platform-independent checks for:

- keyboard `lParam` fields and physical code/location mapping;
- virtual-key and injected `ToUnicodeEx` translation;
- ordinary Ctrl shortcuts and the right-Alt AltGr path;
- synthetic AltGr-Control filtering and press/release logical-key caching;
- `WM_CHAR` controls, repeat counts, surrogate pairs, and malformed UTF-16;
- UTF-16-to-UTF-8 cursor conversion and `CS_INSERTCHAR` behavior;
- IME rectangle normalization and exact structure encodings;
- result-echo suppression;
- IMM byte-length/race/error handling; and
- exactly-once context release under success and exceptions.

Those tests explain why the low-level parsing and layouts are generally stronger than the controller lifecycle. They do
not instantiate `Win32InputController`, drive a WNDPROC, or model native return failures/message reentrancy, so they
cannot cover most findings in this report.

### What the live smoke test actually proves

`packages/winding/win32/native_smoke.ts` verifies a useful but narrow happy path:

- DLLs load, a class registers, one HWND is created/destroyed, and the class unregisters;
- that lifecycle can be repeated **sequentially**;
- basic IME setter calls do not immediately crash;
- `WM_UNICHAR` capability probing returns one; and
- a posted Unicode `A` reaches the semantic commit queue.

It does not prove the high-risk properties:

- It calls `openWindow(0, 0, 64, 48)` but never observes the position or client size, so W32-04 passes unnoticed.
- It immediately hides a window that was already created visible and drains early events without assertions, masking
  W32-03's initial focus/size/IME publication loss.
- The two lifecycle iterations are sequential, not simultaneous, so W32-05 is not exercised.
- `setImeEnabled` is toggled without requiring focus, a real installed IME, a real HIMC association, an enabled/disabled
  event, composition, or candidate placement.
- It does not blit, invalidate, expose, resize, minimize/restore, set a title, or test post-close operations.
- It does not generate mouse enter/negative movement, capture theft, capture change, or close-during-drag.
- It does not cover AltGr layouts, key repeat counts, `VK_PACKET`, Japanese clauses, Korean behavior, supplementary
  transient composition, or `WM_IME_REQUEST` geometry.
- It does not post `WM_QUIT` or other thread messages.
- It has no failure injection for window destruction, class unregistration, callbacks, GDI, or IMM results.
- `sanitizeOps` and `sanitizeResources` are both disabled, weakening leak detection.
- Its `ShowWindow` and `PostMessageW` declarations repeat W32-02's `BOOL` mismatch.

The Windows workflow in `.github/workflows/check.yml` runs on `windows-latest`, which is an x64 hosted runner. It
type-checks the Win32 files, runs the pure input test, and runs the native smoke test. There is no Windows ARM64 job,
multi-DPI/desktop matrix, installed-IME matrix, or helper DLL with ABI/failure-injection assertions.

No test or type-check was run as part of this review because the Linux host has no `deno` executable, and no live Win32
test is possible on this host.

### Recommended Windows test matrix

| Area          | Required cases                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ABI           | Helper DLL returns `BOOL 0x100`; compile-time/native size/offset exports; signed `LPARAM`/`LRESULT`; x64 and ARM64                                              |
| Construction  | Initial visible focus/resize, hidden-then-show flow, negative monitor coordinates, exact client size, constructor failure at each stage                         |
| Multiplicity  | Two live libraries and windows concurrently; close in both orders; event routing isolation                                                                      |
| Teardown      | Inject failed `DestroyWindow`/`UnregisterClassW`; send a later message; retry; close during callback and capture                                                |
| Painting      | Pattern blit, invalidate/update, cover/uncover, resize, minimize/restore, partial native blit failure                                                           |
| Mouse         | Enter/leave, signed outside coordinates, capture theft/change/cancel, chords, close during drag, new window after loss                                          |
| Keyboard      | Native repeat count >1, German/Polish/Czech AltGr variants, dead/Shift+AltGr layout, Ctrl shortcuts, `VK_PACKET`, Japanese/Korean alias keys, media/Cancel keys |
| IME lifecycle | Enable/disable focused and blurred, two-window focus switch, both SETCONTEXT/KILLFOCUS orders, association/cancel failure, context churn                        |
| IME content   | Japanese target clauses, Korean insert-on-type, BMP/supplementary text, `CS_INSERTCHAR`, result echoes, growing composition buffers                             |
| IME geometry  | Candidate indices 0–3, multiple `dwCharPos` values, multiline/proportional/scrolled editor, editor rectangle smaller than client                                |
| Embedding     | `WM_QUIT` and custom thread messages, host-owned HWNDs on same queue, cross-thread sent-message reentrancy                                                      |
| DPI           | Unaware/system-aware/Per-Monitor-V2 hosts; 100/150/200% monitors; cross-monitor move and candidate alignment                                                    |

## Cross-platform contract decisions required

Several fixes need an explicit shared-interface decision rather than a Win32-only guess:

1. **Window dimensions:** decide that `openWindow(..., w, h)`, resize events, and `blit` use client/drawable dimensions
   (the current comments strongly imply this), then require every backend to enforce that meaning.
2. **DPI units:** define logical versus physical pixels for window position/size, mouse coordinates, resize events,
   frame pixels, and IME cursor areas. “Logical” is currently stated only for the IME setter.
3. **Thread queue ownership:** state whether `Library.event()` owns the complete Win32 UI-thread queue or must coexist
   with a host pump. The current interface has no way to surface `WM_QUIT` or arbitrary thread messages.
4. **Key repeat multiplicity:** either require one `KeyDownEvent` per represented repeat or add an explicit count. A
   boolean alone cannot preserve a coalesced Win32 message.
5. **IME geometry:** `IMR_QUERYCHARPOSITION` cannot be answered faithfully from one cursor rectangle. The application
   must be able to provide requested-character geometry and the editable document rectangle synchronously, or the
   backend must decline the request.
6. **IME replacement semantics:** if current Korean/reconversion paths require modifying already inserted text,
   determine whether the shared model gains a replacement edit or applications must provide a surrounding-text
   transaction API.
7. **Closed-object behavior:** define whether every method after `Window.close()` is a no-op or throws a stable library
   error. The current Win32 methods are inconsistent: IME setters return early, while title/blit reach native invalid
   handles.
8. **Wheel semantics:** document the unit and sign of `deltaX`/`deltaY`; the Win32 backend currently reports fractional
   notches, flips the native vertical sign, and retains the native horizontal sign.

## Prioritized remediation plan

### 1. Make the native lifetime safe

- Fix all Win32 `BOOL` declarations first so cleanup decisions are based on the correct ABI.
- Redesign window/class teardown around confirmed `WM_NCDESTROY` and confirmed class absence.
- Keep callback/DLL ownership alive on any unresolved HWND/class failure.
- Reject every public native operation on a closed window before its retained HWND can be reused.
- Make library construction transactional and class identity safe for simultaneous instances.
- Add failure injection and subprocess crash tests before changing other behavior.

### 2. Correct creation, geometry, and painting as one unit

- Create hidden, publish/attach, establish initial state, and then show.
- Implement requested signed position and client size with DPI-aware non-client adjustment.
- Add an authoritative per-window client-size/frame model.
- Implement retained `WM_PAINT` rendering and validate every blit.

These changes interact: exposing the window only after the retained frame/size state exists avoids replacing one
initial-publication race with another paint race.

### 3. Replace pointer tracking with explicit per-window state

- Add per-window inside/tracking state and signed mouse coordinate decoding.
- Add capture owner plus pressed-button state.
- Handle `WM_CAPTURECHANGED`, cancellation, and `WM_NCDESTROY`.
- Return zero for messages actually consumed.

### 4. Repair text-producing keyboard ownership

- Separate AltGr layout-level detection from right-Alt synthetic-Control filtering.
- Preserve physical Ctrl+Alt text, negative/dead/shifted AltGr levels, and `VK_PACKET` text ownership.
- Expand native repeat counts.
- Correct logical-key aliases/names and validate NFC key strings.

### 5. Make IMM state native-result-driven

- Track association separately from observed/public activation.
- Do not advance clean state on failed associate/cancel/release calls.
- Add the `TranslateMessage` reentrancy/deferred-IMM guard.
- Retrieve target attributes/clauses and correct/decline `IMR_QUERYCHARPOSITION`.
- Reset stale state on new composition, position active candidate indices, and validate Korean/supplementary paths on
  real IMEs.

### 6. Define host integration

- Choose and document DPI awareness/unit semantics.
- Choose and document Win32 thread-message/quit ownership.
- Add x64 and ARM64 Windows CI plus real-IME and multi-DPI scheduled/manual coverage.

## Bottom line

The low-level Win32 encodings are not broadly broken: most fixed-width signatures, 64-bit layouts, constants, DIB
construction, keyboard bit parsing, and IMM string mechanics are correct. The serious problems sit at the boundaries
where native lifetime, synchronous message ordering, persistent paint state, capture ownership, keyboard text ownership,
and IME association must agree with JavaScript state.

W32-01 is a release-blocking native lifetime defect. W32-02 through W32-09 are also release blockers for a
general-purpose Windows backend because they affect ordinary creation, geometry, repainting, pointer use, or localized
text. W32-10 is conditional on an affected installed IME plus cross-thread sent-message reentry, but a general-purpose
host-embeddable backend should still close that documented crash path before release. The medium findings are necessary
for reliable embedding and international input rather than optional polish. Fixing the ABI in isolation will not make
the backend safe; teardown, creation publication, paint/capture state, and IMM state must be made transactional and
native-result-driven.
