# winding

winding is a cross-platform windowing library that does not need bindings to any external binaries (except for the system itself).

Currently, it supports:

- Windows
- Linux (X11)

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

Also See [this example](./example.ts).
