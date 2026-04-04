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

export interface XdgIfaces {
  /** Pinned buffer — must be kept alive for the lifetime of the library. */
  mem: Uint8Array<ArrayBuffer>;
  xdgWmBaseIface: Deno.PointerObject;
  xdgSurfaceIface: Deno.PointerObject;
  xdgToplevelIface: Deno.PointerObject;
  wpCursorShapeManagerIface: Deno.PointerObject;
  wpCursorShapeDeviceIface: Deno.PointerObject;
}

// All request/event signatures come from xdg-shell-client-protocol-code.h.
// Called once inside WaylandLibrary's constructor so no FFI work happens at
// module-load time.
export function buildXdgIfaces(): XdgIfaces {
  const mem = new Uint8Array(8192);
  let off = 0;
  const base = Deno.UnsafePointer.value(Deno.UnsafePointer.of(mem));
  const dv = new DataView(mem.buffer);

  function alloc(n: number): number {
    const o = off;
    off += n;
    if (off > mem.byteLength) throw new Error("winding xdg interface memory overflow");
    return o;
  }

  function cstr(s: string): number {
    const o = alloc(s.length + 1);
    for (let i = 0; i < s.length; i++) mem[o + i] = s.charCodeAt(i);
    return o;
  }

  function align8(): void {
    off = (off + 7) & ~7;
  }

  function buildMsgs(msgs: [string, string][]): number {
    if (msgs.length === 0) return 0;
    const namePtrs = msgs.map(([n]) => base + BigInt(cstr(n)));
    const sigPtrs = msgs.map(([, s]) => base + BigInt(cstr(s)));
    align8();
    const arr = alloc(24 * msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      const o = arr + i * 24;
      dv.setBigUint64(o, namePtrs[i], true);
      dv.setBigUint64(o + 8, sigPtrs[i], true);
      dv.setBigUint64(o + 16, 0n, true); // types = NULL
    }
    return arr;
  }

  function buildIface(
    name: string,
    version: number,
    methods: [string, string][],
    events: [string, string][],
  ): bigint {
    const methodsOff = buildMsgs(methods);
    const eventsOff = buildMsgs(events);
    const nameOff = cstr(name);
    align8();
    const o = alloc(40);
    dv.setBigUint64(o, base + BigInt(nameOff), true);
    dv.setInt32(o + 8, version, true);
    dv.setInt32(o + 12, methods.length, true);
    dv.setBigUint64(o + 16, methodsOff > 0 ? base + BigInt(methodsOff) : 0n, true);
    dv.setInt32(o + 24, events.length, true);
    dv.setBigUint64(o + 32, eventsOff > 0 ? base + BigInt(eventsOff) : 0n, true);
    return base + BigInt(o);
  }

  const xdgWmBaseIface = Deno.UnsafePointer.create(
    buildIface("xdg_wm_base", 7, [
      ["destroy", ""],
      ["create_positioner", "n"],
      ["get_xdg_surface", "no"],
      ["pong", "u"],
    ], [
      ["ping", "u"],
    ]),
  )!;

  const xdgSurfaceIface = Deno.UnsafePointer.create(
    buildIface("xdg_surface", 7, [
      ["destroy", ""],
      ["get_toplevel", "n"],
      ["get_popup", "n?oo"],
      ["set_window_geometry", "iiii"],
      ["ack_configure", "u"],
    ], [
      ["configure", "u"],
    ]),
  )!;

  const xdgToplevelIface = Deno.UnsafePointer.create(
    buildIface("xdg_toplevel", 7, [
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

  const wpCursorShapeManagerIface = Deno.UnsafePointer.create(
    buildIface("wp_cursor_shape_manager_v1", 1, [
      ["destroy", ""],
      ["get_pointer", "no"],
    ], []),
  )!;

  const wpCursorShapeDeviceIface = Deno.UnsafePointer.create(
    buildIface("wp_cursor_shape_device_v1", 1, [
      ["destroy", ""],
      ["set_shape", "uu"],
    ], []),
  )!;

  return {
    mem,
    xdgWmBaseIface,
    xdgSurfaceIface,
    xdgToplevelIface,
    wpCursorShapeManagerIface,
    wpCursorShapeDeviceIface,
  };
}

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
  // wp_cursor_shape_manager_v1 requests
  WP_CURSOR_SHAPE_MANAGER_DESTROY: 0,
  WP_CURSOR_SHAPE_MANAGER_GET_POINTER: 1,
  // wp_cursor_shape_device_v1 requests
  WP_CURSOR_SHAPE_DEVICE_DESTROY: 0,
  WP_CURSOR_SHAPE_DEVICE_SET_SHAPE: 1,
} as const;

export const WlShmFormat = {
  ARGB8888: 0,
  XRGB8888: 1,
} as const;

// wl_seat::capabilities bitmask
export const WlSeatCap = {
  POINTER: 1 << 0,
  KEYBOARD: 1 << 1,
  TOUCH: 1 << 2,
} as const;

export const WlCursorShape = {
  DEFAULT: 1,
} as const;

// ---------------------------------------------------------------------------
// libwayland-client FFI symbols
// Functions are declared with parameters/result; interface data symbols use
// { type: "usize" } which returns the address of the exported C global.
// ---------------------------------------------------------------------------

export const waylandSymbols = {
  // Display lifecycle
  wl_display_connect: { parameters: ["pointer"], result: "pointer" },
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
  // args ("buffer") is union wl_argument* -- pass BigUint64Array, one 8-byte
  // slot per argument in message signature order.
  wl_proxy_marshal_array_flags: {
    parameters: ["pointer", "u32", "pointer", "u32", "u32", "buffer"],
    result: "pointer",
  },
  wl_proxy_add_listener: { parameters: ["pointer", "pointer", "pointer"], result: "i32" },
  wl_proxy_destroy: { parameters: ["pointer"], result: "void" },
  wl_proxy_get_version: { parameters: ["pointer"], result: "u32" },
} as const;

// ---------------------------------------------------------------------------
// libdl FFI symbols
// Functions are declared with parameters/result.
// dlsym is used to resolve exported wl_interface global addresses.
// ---------------------------------------------------------------------------

export const libdlSymbols = {
  dlopen: { parameters: ["buffer", "i32"], result: "pointer" },
  dlsym: { parameters: ["pointer", "buffer"], result: "pointer" },
  dlclose: { parameters: ["pointer"], result: "i32" },
} as const;
