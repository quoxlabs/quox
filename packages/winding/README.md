# winding

winding is a cross-platform windowing library that does not need bindings to any external binaries (except for the
system itself).

Currently, it supports:

- Windows
- macOS
- Linux (X11)
- Linux (Wayland)

Contributions are welcome!

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

Committed text is never duplicated on a keyboard event. A normal character press is delivered as a `text-input` keydown
followed by one nonempty `ime` commit. Composition updates use UTF-8 byte cursor ranges; cancellation is an empty
preedit with a `null` cursor. A commit ends preedit atomically, so it is not preceded by a synthetic empty preedit.
AppKit editing selectors remain observable as `apple-standard-keybinding` events.

Call `window.setImeEnabled(true)` when a text editor wants native composition and
`window.setImeCursorArea(x, y, width, height)` to position its candidate window in top-left-origin logical client
coordinates. The setter records desired permission; `ime/enabled` and `ime/disabled` events report actual activation on
the focused native window. Non-finite cursor geometry is ignored, while negative dimensions become zero.

### Wayland environment permission

The package selects Wayland only when it may read `WAYLAND_DISPLAY` and that variable is set. Applications that want
automatic Wayland selection should therefore grant it explicitly:

```sh
deno run --allow-ffi --allow-env=WAYLAND_DISPLAY app.ts
```

Without that environment permission, the top-level loader falls back to X11. Code importing the Wayland backend directly
may additionally need locale-variable access for XKB/compose initialization.
