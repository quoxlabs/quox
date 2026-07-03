# quox

## Prerequisites

- [Deno](https://deno.land/) (Tested with `2.7.11`)
- [Rust](https://rustup.rs/) (Tested with `1.94.1`)

## TL;DR

- `deno fmt` to format all files.
- `deno task build` to compile the library as a dev build.
- `deno task ok` to check formatting, linting, and types.

## Development

Run an example using your local binary:

```sh
deno --allow-ffi examples/shapes.ts
```

### Windows Development

```sh
winget install DenoLand.Deno
winget install Rustlang.Rustup
```

Rust's default Windows toolchain (`x86_64-pc-windows-msvc`) needs MSVC's `link.exe` from Visual Studio Build Tools.
Either install that (`Desktop development with C++` workload), or switch to the GNU/MinGW toolchain:

```sh
winget install BrechtSanders.WinLibs.POSIX.UCRT
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu
```

`stylo`'s build script also needs a real Python 3 interpreter (the `python`/`python3` stubs under `WindowsApps` just
open the Microsoft Store):

```sh
winget install Python.Python.3.13
```

Open a new terminal afterwards so the updated `PATH` takes effect. If `python` or `gcc` still don't resolve, check
_Settings > Apps > Advanced app settings > App execution aliases_ and disable the Python stub aliases.
