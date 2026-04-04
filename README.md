# quox (/quarks/)

Brings the web stack to the desktop.

- **Simple.** A full desktop app in 2 lines of code.
- **Speedy.** Hardware-accelerated layouting and rendering.
- **Small.** Tiny on disk, tiny at runtime.
- **Secure.** Fully contained in Deno's secure sandbox.

quox (pronounced like _quarks_) lets you write TSX, and render it to a native application window on any OS. Without a
build step.

Built on top of Deno, blitz, Wasm, WebGPU, and FFI. Free and open-source.

This project is very young. Try it if you like bleeding edges, but don't make your business depend on it just yet.

quox already works as a hello world example. Paste the following code to `main.tsx`:

```tsx
/** @jsxImportSource npm:preact */

import { renderToWindow } from "jsr:@quoxlabs/quox";

await renderToWindow(<h1>Hello, world!</h1>);
```

Running

```sh
deno --allow-ffi main.tsx
```

will open a native window on your machine with "Hello, world!" rendered to it.

This has the following interesting properties:

- `deno --allow-ffi https://quox.dev/main.tsx` runs a full native desktop app without installation
- `deno install` installs a native desktop app
- `deno compile` creates standalone binaries of your app for Linux/Windows/Mac (even cross-platform)
- `deno run --unstable-hmr main.tsx` lets you develop your app with hot module replacement

It has a lot of nice benefits:

- a single JS context for your entire app
- access to the web stack (all of npm and jsr)
- fully cross-platform
- built-in security
- pure Deno tooling lets you iterate at ludicrous speeds
- automatic deduplication of quox in the Deno cache (tiny on disk)
- full system access via Deno
