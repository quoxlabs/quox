# quox (/quarks/)

More than just Electron.

Simple.
Speedy.
Small.
Secure.

quox lets you write TSX, and render it to a native application window on any OS.
Without a build step.

Built on top of Deno, servo, WebGPU, FFI.
Free and open-source.

quox is not anywhere close to being ready, not even as a hello world example.
Until then, imagine this:

```ts
// main.tsx
import { renderToWindow } from "https://quox.dev/mod.ts";

await renderToWindow(<h1>Hello, world!</h1>);
```

Running

```sh
deno run --allow-ffi main.tsx
```

will open a native window on your machine with "Hello, world!" rendered to it.

This will enable:

- `deno run -A https://example.com/main.tsx` runs a native desktop app without installation
- `deno install -A https://example.com/main.tsx` installs a native desktop app
- `deno compile` creates standalone binaries of your app for Linux/Windows/Mac
- `deno run --unstable-hmr main.tsx` lets you develop your app with hot module replacement

It has a lot of nice benefits:

- a single JS context for your entire app
- access to the web stack (all of npm)
- fully cross-platform
- built-in security
- pure Deno tooling lets you iterate at ludicrous speeds
- automatic deduplication of quox in the Deno cache (tiny on disk)
- full system access via Deno
