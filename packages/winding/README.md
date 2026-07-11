# winding

winding is a cross-platform windowing library that does not need bindings to any external binaries (except for the
system itself).

Currently, it supports:

- Windows
- macOS
- Linux (X11)
- Linux (Wayland)

Contributions are welcome!

## Darwin exception boundary

The Darwin backend validates public inputs and treats an AppKit `NSException` as a binding bug, not a recoverable
application error. Objective-C exceptions cannot safely unwind through Deno FFI frames, so they remain process-fatal;
JavaScript `try`/`catch` must not be used to recover from one. Native AppKit smoke and fault probes therefore run in
dedicated child processes in CI.

Winding intentionally does not ship a compiled Objective-C catch shim. The package otherwise talks directly to system
frameworks, and a complete shim would need architecture-specific wrappers for every Objective-C message shape while
still being unable to catch memory faults. Known AppKit preconditions should instead be enforced before crossing FFI.

## Win32 DPI hosting

The Win32 backend inherits the calling thread's effective DPI-awareness context and never changes process-global or
thread-global awareness. Public window, client, pointer, and IME geometry uses 96-DPI logical units. Resize events keep
the exact native client-pixel dimensions separately as `framebufferWidth`/`framebufferHeight`, with `devicePixelRatio`
describing the conversion required by `blit()`.

For per-monitor-aware host contexts, Winding applies the suggested outer rectangle from `WM_DPICHANGED`, refreshes the
logical/framebuffer resize state, and repositions native IME UI. DPI-unaware and system-aware hosts retain Windows'
bitmap-virtualization behavior. Outer window positions are scaled from the primary display's logical origin using the
context-appropriate system DPI; outer dimensions use the target window's DPI once its monitor is known.

## Usage

Create `app.ts` with the following content.

```ts
// app.ts
import { load } from "jsr:@quoxlabs/winding";

using library = load();
using _window = library.openWindow();

// Get the event at least once to start.
// In your app you would introduce an event loop around this.
const _event = library.event();

setTimeout(() => {}, 5000);
```

Run the file with FFI bindings allowed.

```sh
deno run --allow-ffi app.ts
```

Also See [this example](../../examples/winding.ts).

## Keyboard and text input

Every keyboard event carries the native numeric `keycode`, a layout-independent DOM-style `code`, a layout-aware
DOM-style `key`, location, composition state, and the complete modifier snapshot. Unknown physical or logical values are
reported as `"Unidentified"`. Key releases reuse the logical key resolved by their matching press.

Keydown events also describe who owns their editing behavior:

- `key-default` leaves navigation, deletion, Enter, Tab, and shortcuts to the application.
- `text-input` suppresses that default because native text input or an AppKit command owns the edit.
- `platform` suppresses it because the operating system owns the action.

Committed text is never duplicated on a keyboard event. An ordinary delivered character press is a `text-input` keydown
followed by one nonempty `ime` commit. On Wayland, a key consumed by the compositor's text service can instead produce
preedit or commit events without a matching Winding keydown because text-input-v3 does not expose that physical key.
Ordinary `wl_keyboard` events remain the local XKB/Compose fallback for keys the text service did not consume.
Composition updates use UTF-8 byte cursor ranges; cancellation is an empty preedit with a `null` cursor. A commit ends
preedit atomically, so it is not preceded by a synthetic empty preedit. AppKit editing selectors remain observable as
`apple-standard-keybinding` events.

Call `window.setImeEnabled(true)` when a text editor wants native composition and
`window.setImeCursorArea(x, y, width, height)` to position its candidate window in top-left-origin logical client
coordinates. The setter records desired permission; `ime/enabled` and `ime/disabled` events report the state applied by
the backend on the focused native window. On Wayland, `enabled` means the enable request was locally committed, not that
an input-method daemon acknowledged or consumed it. Non-finite cursor geometry is ignored, while negative dimensions
become zero.

### Wayland environment permission

The package selects Wayland only on Linux when it may read a nonempty `WAYLAND_DISPLAY` or `WAYLAND_SOCKET`.
Applications that want automatic Wayland selection, including inherited-socket launches, should therefore grant both
explicitly:

```sh
deno run --allow-ffi --allow-env=WAYLAND_DISPLAY,WAYLAND_SOCKET app.ts
```

When neither signal is readable and nonempty, the top-level loader falls back to X11. Code importing the Wayland backend
directly may additionally need locale-variable access for XKB/compose initialization.
