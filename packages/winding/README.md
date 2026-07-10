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

Keyboard events keep the native numeric `keycode` and the layout-independent physical `code`. Backends that support
layout-aware input also populate `key`, `location`, `repeat`, `isComposing`, and `text`. Darwin populates every extended
field on every key event; `text` is an empty string when that event produces no text.

On macOS, applications can opt into AppKit text input by calling `window.setImeEnabled?.(true)`. Winding then emits
`ime` events for composition state, preedit updates, and committed text. The shared event type also represents
surrounding-text deletion for backends that support it. Preedit selections and deletion lengths are UTF-8 byte offsets.
Position the native candidate window with `setImeCursorArea`; its arguments use logical client coordinates with a
top-left origin.

An interpreted key is emitted before the text-input events it caused. Its `textInputHandled` field is `true`, telling
consumers not to apply the key's default edit a second time. AppKit editing commands are emitted as
`apple-standard-keybinding` events whose `command` is the original selector, such as `deleteBackward:`. Consumers should
map that selector at their editor boundary rather than reproducing macOS keybinding rules in Winding.
