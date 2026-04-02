# browserbrowserbowser

This demo was done because an LLM told me it couldn't be done. And because everything that is anything must be written in Rust.

How is it done, who cares, let's see a video:

https://github.com/user-attachments/assets/633ca687-14d6-4880-bf9b-c742c7c539ce

Okay but really how does it work.

## Architecture

wasm-pack builds a wasm binary that call out to Servos APIs: [html5ever](https://github.com/servo/html5ever) and [stylo](https://github.com/servo/stylo/), sometimes directly sometimes through [Blitz](https://github.com/DioxusLabs/blitz) APIs. Servo understands CSS and HTML and renders the page to an image via [Vello](https://github.com/linebender/vello) which is a WebGPU renderer.

You can see **[WASM support #160](https://github.com/DioxusLabs/blitz/issues/160)** for the inception of this project.

## Running project

**Requirements**
- **Rust** — see [`rust-toolchain.toml`](rust-toolchain.toml) (`wasm32-unknown-unknown`).
- **[wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)**
- **CORS** — fetched pages must be allowed; the stock URL box expects wrappers like `https://corsproxy.io/?https://…`.

```bash
wasm-pack build --target web --out-dir web/pkg
cargo run --bin serve-web
```

Then open [http://127.0.0.1:8080/](http://127.0.0.1:8080/)