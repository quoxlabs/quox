/**
 * Post-build patch for wgpu-28's webgpu backend on Deno.
 *
 * wgpu-28 passes a raw `ArrayBuffer` to `GPUQueue.writeBuffer()` (extracted
 * via `.buffer()` for Gecko compatibility), but Deno's WebGPU implementation
 * only accepts `ArrayBufferView` types (e.g. `Uint8Array`), not a bare
 * `ArrayBuffer`.  This script patches the generated `lib/quox.internal.js` so
 * that the `writeBuffer` shim wraps any `ArrayBuffer` argument in a `Uint8Array`
 * view before forwarding the call.
 */

const LIB = new URL("../lib/quox.internal.js", import.meta.url);
let src = await Deno.readTextFile(LIB);

// wasm-bindgen generates two shapes for this shim depending on whether the
// externref table model (debug) or the heap-object model (release) is active.
const debugPattern =
  // deno-lint-ignore no-regex-spaces
  /export function __wbg_writeBuffer_b203cf79b98d6dd8\(\) \{\n  return handleError\(function \(arg0, arg1, arg2, arg3, arg4, arg5\) \{\n    arg0\.writeBuffer\(arg1, arg2, arg3, arg4, arg5\);\n  \}, arguments\);\n\}/;

const releasePattern =
  // deno-lint-ignore no-regex-spaces
  /export function __wbg_writeBuffer_b203cf79b98d6dd8\(\) \{\n  return handleError\(function \(arg0, arg1, arg2, arg3, arg4, arg5\) \{\n    getObject\(arg0\)\.writeBuffer\(getObject\(arg1\), arg2, getObject\(arg3\), arg4, arg5\);\n  \}, arguments\);\n\}/;

const debugReplacement = `export function __wbg_writeBuffer_b203cf79b98d6dd8() {
  return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
    // Deno only accepts ArrayBufferView, not raw ArrayBuffer (wgpu-28 compat fix).
    const _src = arg3;
    const _view = _src instanceof ArrayBuffer ? new Uint8Array(_src, arg4, arg5) : _src;
    arg0.writeBuffer(arg1, arg2, _view, _src instanceof ArrayBuffer ? 0 : arg4, _src instanceof ArrayBuffer ? _view.byteLength : arg5);
  }, arguments);
}`;

const releaseReplacement = `export function __wbg_writeBuffer_b203cf79b98d6dd8() {
  return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
    // Deno only accepts ArrayBufferView, not raw ArrayBuffer (wgpu-28 compat fix).
    const _src = getObject(arg3);
    const _view = _src instanceof ArrayBuffer ? new Uint8Array(_src, arg4, arg5) : _src;
    getObject(arg0).writeBuffer(getObject(arg1), arg2, _view, _src instanceof ArrayBuffer ? 0 : arg4, _src instanceof ArrayBuffer ? _view.byteLength : arg5);
  }, arguments);
}`;

let patched = false;

if (debugPattern.test(src)) {
  src = src.replace(debugPattern, debugReplacement);
  patched = true;
  console.log("patched writeBuffer shim (externref/debug build)");
} else if (releasePattern.test(src)) {
  src = src.replace(releasePattern, releaseReplacement);
  patched = true;
  console.log("patched writeBuffer shim (heap-object/release build)");
} else {
  console.warn(
    "WARNING: writeBuffer shim pattern not found in lib/quox.internal.js – skipping patch.\n" +
      "The build may crash on Deno until wgpu-28 is fixed upstream.",
  );
}

if (patched) {
  await Deno.writeTextFile(LIB, src);
}
