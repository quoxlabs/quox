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
rustup set default-host x86_64-pc-windows-gnu
```

The last line is required, not optional. `packages/quox/rust-toolchain.toml` pins a bare `channel = "stable"`, and
rustup resolves that against the _default host_ rather than the default toolchain. Without it, `cargo` still selects
MSVC inside `packages/quox` and fails with ``linker `link.exe` not found`` even though `rustup default` reports GNU.
Verify with `rustup show`: the `Default host:` line must read `x86_64-pc-windows-gnu`.

`stylo`'s build script also needs a real Python 3 interpreter (the `python`/`python3` stubs under `WindowsApps` just
open the Microsoft Store):

```sh
winget install Python.Python.3.13
```

Open a new terminal afterwards so the updated `PATH` takes effect. If `python` or `gcc` still don't resolve, check
_Settings > Apps > Advanced app settings > App execution aliases_ and disable the Python stub aliases.

#### Corporate-managed machines

Endpoint protection may block cargo from executing the helper binaries it compiles for `build.rs` scripts and procedural
macros. Under Microsoft Defender this surfaces as a build failure like:

```
error: failed to run custom build command for `serde_core v1.0.228`
Caused by: could not execute process .../build-script-build (never executed)
Caused by: Access denied (os error 5)
```

The usual cause is the Attack Surface Reduction rule _"Block executable files from running unless they meet a
prevalence, age, or trusted list criterion"_ (`01443614-cd74-433a-b99e-2ecdc07bfc25`). Every build script is freshly
compiled, unsigned, and unique per build, so it fails the prevalence check by definition and the rule blocks all local
compilation. Confirm it under _Event Viewer > Applications and Services Logs > Microsoft > Windows > Windows Defender >
Operational_, event ID 1121.

This is an administrator-enforced control. Ask IT for a rule-specific exclusion covering your checkout directory instead
of disabling the rule or working around it.
