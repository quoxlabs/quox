# Quox

## Prerequisites

- [Deno](https://deno.land/) (Tested with `2.7.11`)
- [Rust](https://rustup.rs/) (Tested with `1.94.1`)

## TL;DR

- `deno task build` to compile the library.
- `deno publish` to upload to JSR. For a local dev build, see below.

## Development

### 1. Build the native library

To build the `libquox.so` binary locally:

```sh
deno task build
```

This will create the binary at `packages/quox/target/x86_64-unknown-linux-gnu/release/libquox.so`. Checkout the script for the build target, i.e. we support x86_64 linux.

### 2. Set the environment variable

To use your locally built library instead of the one from JSR, set the `LIBQUOX_PATH` environment variable to the absolute path of your `libquox.so`:

```sh
export LIBQUOX_PATH=$(pwd)/packages/quox/target/x86_64-unknown-linux-gnu/release/libquox.so
```

### 3. Run the local developer example

Now you can run an example using your local binary:

```sh
deno run -A examples/local/main.ts
```
