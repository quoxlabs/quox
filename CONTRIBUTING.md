# Quox

## Prerequisites

- [Deno](https://deno.land/) (Tested with `2.7.11`)
- [Rust](https://rustup.rs/) (Tested with `1.94.1`)

## TL;DR

Inside `packages/quox/` use

- `deno task dev` to compile the library.
- `deno task build && deno publish` to upload to JSR. For a local dev build, see below.

## Development

### 1. Build the native library

To build the `libquox.so` binary for linux locally:

```sh
deno task dev
```

To build the `libquox.dylib` binary for mac apple silicon locally:

```sh
deno task dev:mac
```

This will create the binary at `packages/quox/target/x86_64-unknown-linux-gnu/debug/libquox.so` or `packages/quox/target/aarch64-apple-darwin/debug/libquox.dylib`. Checkout the script for the build target, we support linux and macos.

### 2. Set the environment variable

To use your locally built library instead of the one from JSR, set the `LIBQUOX_PATH` environment variable to the absolute path of your `library:

```sh
# linux
export LIBQUOX_PATH=$(pwd)/packages/quox/target/x86_64-unknown-linux-gnu/debug/libquox.so
# macos
export LIBQUOX_PATH=$(pwd)/packages/quox/target/aarch64-apple-darwin/debug/libquox.dylib
```

### 3. Run the local developer example

Now you can run an example using your local binary:

```sh
deno run --allow-ffi --allow-env examples/local.ts
```

## Supported platforms

| package name                  | build target              |
| ----------------------------- | ------------------------- |
| @quoxlabs/lib-darwin-arm64    | aarch64-apple-darwin      |
| @quoxlabs/lib-darwin-x64      | x86_64-apple-darwin       |
| @quoxlabs/lib-linux-arm64-gnu | aarch64-unknown-linux-gnu |
| @quoxlabs/lib-linux-x64-gnu   | x86_64-unknown-linux-gnu  |
