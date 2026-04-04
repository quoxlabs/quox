// FFI bindings for libwayland-client.so

// ---------------------------------------------------------------------------
// XDG-shell interface structs built in JS memory.
// The xdg_wm_base, xdg_surface, and xdg_toplevel interfaces are not exported
// from libwayland-client.so, so we construct the wl_interface/wl_message C
// structs manually in a pinned Uint8Array that is never GC'd.
//
// wl_interface layout (40 bytes, 64-bit):
//   +0  const char *name   (8)
//   +8  int version        (4)
//   +12 int method_count   (4)
//   +16 wl_message *methods(8)
//   +24 int event_count    (4)
//   +28 (padding)          (4)
//   +32 wl_message *events (8)
//
// wl_message layout (24 bytes, 64-bit):
//   +0  const char *name      (8)
//   +8  const char *signature (8)
//   +16 wl_interface **types  (8)  ← NULL; signature is sufficient
// ---------------------------------------------------------------------------

const _MEM = new Uint8Array(8192); // all xdg struct data lives here
let _off = 0;
const _base = BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(_MEM)));
const _dv = new DataView(_MEM.buffer);

function _alloc(n: number): number {
  const o = _off;
  _off += n;
  if (_off > _MEM.byteLength) throw new Error("xdg interface memory overflow");
  return o;
}

function _cstr(s: string): number {
  const o = _alloc(s.length + 1);
  for (let i = 0; i < s.length; i++) _MEM[o + i] = s.charCodeAt(i);
  return o; // _MEM[o + s.length] is already 0 (Uint8Array zero-init)
}

function _align8(): void {
  _off = (_off + 7) & ~7;
}

// Build a contiguous array of wl_message structs. All name/sig strings are
// allocated first, then the message structs are laid out contiguously so the
// wl_interface can point to them as an array.
function _buildMsgs(msgs: [string, string][]): number {
  if (msgs.length === 0) return 0;
  const namePtrs = msgs.map(([n]) => _base + BigInt(_cstr(n)));
  const sigPtrs = msgs.map(([, s]) => _base + BigInt(_cstr(s)));
  _align8();
  const arr = _alloc(24 * msgs.length);
  for (let i = 0; i < msgs.length; i++) {
    const o = arr + i * 24;
    _dv.setBigUint64(o, namePtrs[i], true);
    _dv.setBigUint64(o + 8, sigPtrs[i], true);
    _dv.setBigUint64(o + 16, 0n, true); // types = NULL
  }
  return arr;
}

function _buildIface(
  name: string,
  version: number,
  methods: [string, string][],
  events: [string, string][],
): bigint {
  const methodsOff = _buildMsgs(methods);
  const eventsOff = _buildMsgs(events);
  const nameOff = _cstr(name);
  _align8();
  const o = _alloc(40);
  _dv.setBigUint64(o, _base + BigInt(nameOff), true);
  _dv.setInt32(o + 8, version, true);
  _dv.setInt32(o + 12, methods.length, true);
  _dv.setBigUint64(o + 16, methodsOff > 0 ? _base + BigInt(methodsOff) : 0n, true);
  _dv.setInt32(o + 24, events.length, true);
  _dv.setBigUint64(o + 32, eventsOff > 0 ? _base + BigInt(eventsOff) : 0n, true);
  return _base + BigInt(o);
}

// All request/event signatures come from xdg-shell-client-protocol-code.h.
export const xdgWmBaseIface = Deno.UnsafePointer.create(
  _buildIface("xdg_wm_base", 7, [
    ["destroy", ""],
    ["create_positioner", "n"],
    ["get_xdg_surface", "no"],
    ["pong", "u"],
  ], [
    ["ping", "u"],
  ]),
)!;

export const xdgSurfaceIface = Deno.UnsafePointer.create(
  _buildIface("xdg_surface", 7, [
    ["destroy", ""],
    ["get_toplevel", "n"],
    ["get_popup", "n?oo"],
    ["set_window_geometry", "iiii"],
    ["ack_configure", "u"],
  ], [
    ["configure", "u"],
  ]),
)!;

export const xdgToplevelIface = Deno.UnsafePointer.create(
  _buildIface("xdg_toplevel", 7, [
    ["destroy", ""],
    ["set_parent", "?o"],
    ["set_title", "s"],
    ["set_app_id", "s"],
    ["show_window_menu", "ouii"],
    ["move", "ou"],
    ["resize", "ouu"],
    ["set_max_size", "ii"],
    ["set_min_size", "ii"],
    ["set_maximized", ""],
    ["unset_maximized", ""],
    ["set_fullscreen", "?o"],
    ["unset_fullscreen", ""],
    ["set_minimized", ""],
  ], [
    ["configure", "iia"],
    ["close", ""],
    ["configure_bounds", "4ii"],
    ["wm_capabilities", "5a"],
  ]),
)!;

// ---------------------------------------------------------------------------
// Protocol opcodes
// ---------------------------------------------------------------------------

/** Request opcodes from wayland-client-protocol.h and xdg-shell-client-protocol.h */
export const WlOp = {
  // wl_display requests
  DISPLAY_GET_REGISTRY: 1,
  // wl_registry requests
  REGISTRY_BIND: 0,
  // wl_compositor requests
  COMPOSITOR_CREATE_SURFACE: 0,
  // wl_shm requests
  SHM_CREATE_POOL: 0,
  // wl_shm_pool requests
  SHM_POOL_CREATE_BUFFER: 0,
  SHM_POOL_DESTROY: 1,
  // wl_buffer requests
  BUFFER_DESTROY: 0,
  // wl_surface requests
  SURFACE_DESTROY: 0,
  SURFACE_ATTACH: 1,
  SURFACE_DAMAGE: 2,
  SURFACE_COMMIT: 6,
  SURFACE_DAMAGE_BUFFER: 9,
  // wl_seat requests
  SEAT_GET_POINTER: 0,
  SEAT_GET_KEYBOARD: 1,
  SEAT_RELEASE: 3,
  // wl_pointer requests
  POINTER_RELEASE: 1,
  // wl_keyboard requests
  KEYBOARD_RELEASE: 0,
  // xdg_wm_base requests
  XDG_WM_BASE_DESTROY: 0,
  XDG_WM_BASE_GET_XDG_SURFACE: 2,
  XDG_WM_BASE_PONG: 3,
  // xdg_surface requests
  XDG_SURFACE_DESTROY: 0,
  XDG_SURFACE_GET_TOPLEVEL: 1,
  XDG_SURFACE_ACK_CONFIGURE: 4,
  // xdg_toplevel requests
  XDG_TOPLEVEL_DESTROY: 0,
  XDG_TOPLEVEL_SET_TITLE: 2,
  XDG_TOPLEVEL_SET_APP_ID: 3,
} as const;

export const WlShmFormat = {
  ARGB8888: 0,
  XRGB8888: 1,
} as const;

// wl_seat::capabilities bitmask
export const WlSeatCap = {
  POINTER: 1,
  KEYBOARD: 2,
  TOUCH: 4,
} as const;

// ---------------------------------------------------------------------------
// libwayland-client FFI symbols
// Functions are declared with parameters/result; interface data symbols use
// { type: "usize" } which returns the address of the exported C global.
// ---------------------------------------------------------------------------

export const waylandSymbols = {
  // Display lifecycle
  wl_display_connect: { parameters: ["buffer"], result: "pointer" },
  wl_display_disconnect: { parameters: ["pointer"], result: "void" },
  wl_display_get_fd: { parameters: ["pointer"], result: "i32" },
  // Event dispatch
  wl_display_dispatch: { parameters: ["pointer"], result: "i32" },
  wl_display_dispatch_pending: { parameters: ["pointer"], result: "i32" },
  wl_display_flush: { parameters: ["pointer"], result: "i32" },
  wl_display_roundtrip: { parameters: ["pointer"], result: "i32" },
  wl_display_prepare_read: { parameters: ["pointer"], result: "i32" },
  wl_display_cancel_read: { parameters: ["pointer"], result: "void" },
  wl_display_read_events: { parameters: ["pointer"], result: "i32" },
  // Proxy operations
  // args ("buffer") is union wl_argument* — pass BigUint64Array, one 8-byte
  // slot per argument in message signature order.
  wl_proxy_marshal_array_flags: {
    parameters: ["pointer", "u32", "pointer", "u32", "u32", "buffer"],
    result: "pointer",
  },
  wl_proxy_add_listener: { parameters: ["pointer", "pointer", "pointer"], result: "i32" },
  wl_proxy_destroy: { parameters: ["pointer"], result: "void" },
  wl_proxy_get_version: { parameters: ["pointer"], result: "u32" },
  // Interface data symbols — values are bigint addresses of the C globals
  wl_registry_interface: { type: "usize" },
  wl_compositor_interface: { type: "usize" },
  wl_shm_interface: { type: "usize" },
  wl_shm_pool_interface: { type: "usize" },
  wl_buffer_interface: { type: "usize" },
  wl_surface_interface: { type: "usize" },
  wl_seat_interface: { type: "usize" },
  wl_pointer_interface: { type: "usize" },
  wl_keyboard_interface: { type: "usize" },
} as const;
