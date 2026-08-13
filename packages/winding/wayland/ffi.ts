// FFI bindings for libwayland-client.so

// ---------------------------------------------------------------------------
// Non-core Wayland protocol interface structs built in JS memory.
// These interfaces are not exported from libwayland-client.so, so we
// construct the wl_interface/wl_message C structs manually in a pinned
// Uint8Array that is never GC'd.
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
//   +16 wl_interface **types  (8)
// ---------------------------------------------------------------------------

type MessageDef = [
  name: string,
  signature: string,
  types?: (Deno.PointerObject | null)[],
];

export interface XdgIfaces {
  /** Pinned buffer — must be kept alive for the lifetime of the library. */
  mem: Uint8Array<ArrayBuffer>;
  xdgWmBaseIface: Deno.PointerObject;
  xdgSurfaceIface: Deno.PointerObject;
  xdgToplevelIface: Deno.PointerObject;
  wpCursorShapeManagerIface: Deno.PointerObject;
  wpCursorShapeDeviceIface: Deno.PointerObject;
}

// Request/event signatures come from the corresponding generated protocol
// code (xdg-shell and cursor-shape-v1).
// Called once inside WaylandLibrary's constructor so no FFI work happens at
// module-load time.
export function buildXdgIfaces(): XdgIfaces {
  const mem = new Uint8Array(16384);
  let off = 0;
  const base = Deno.UnsafePointer.value(Deno.UnsafePointer.of(mem));
  const dv = new DataView(mem.buffer);

  function alloc(n: number): number {
    const o = off;
    off += n;
    if (off > mem.byteLength) throw new Error("winding Wayland interface memory overflow");
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

  function buildTypes(types: (Deno.PointerObject | null)[] | undefined): number {
    if (!types) return 0;
    align8();
    const o = alloc(8 * types.length);
    for (let i = 0; i < types.length; i++) {
      dv.setBigUint64(o + i * 8, types[i] ? Deno.UnsafePointer.value(types[i]) : 0n, true);
    }
    return o;
  }

  function buildMsgs(msgs: MessageDef[]): number {
    if (msgs.length === 0) return 0;
    const namePtrs = msgs.map(([n]) => base + BigInt(cstr(n)));
    const sigPtrs = msgs.map(([, s]) => base + BigInt(cstr(s)));
    const typesPtrs = msgs.map(([, , types]) => {
      const typesOff = buildTypes(types);
      return typesOff > 0 ? base + BigInt(typesOff) : 0n;
    });
    align8();
    const arr = alloc(24 * msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      const o = arr + i * 24;
      dv.setBigUint64(o, namePtrs[i], true);
      dv.setBigUint64(o + 8, sigPtrs[i], true);
      dv.setBigUint64(o + 16, typesPtrs[i], true);
    }
    return arr;
  }

  function buildIface(
    name: string,
    version: number,
    methods: MessageDef[],
    events: MessageDef[],
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
  // wl_surface requests
  SURFACE_DESTROY: 0,
  SURFACE_COMMIT: 6,
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

// wl_seat::capabilities bitmask
export const WlSeatCap = {
  POINTER: 1 << 0,
  KEYBOARD: 1 << 1,
  TOUCH: 1 << 2,
} as const;

export const WlCursorShape = {
  DEFAULT: 1,
} as const;

// `xdg_toplevel_state` enum value from xdg-shell (available since xdg_toplevel v6): reported
// in `xdg_toplevel::configure`'s `states` array when the surface isn't currently visible
// (e.g. minimized, or scrolled to another workspace). The closest Wayland analog to X11's
// UnmapNotify/Win32's SW_MINIMIZE — there's no separate "unmapped" surface event to listen
// for instead. Compositors that don't support it simply never set the bit, which degrades
// safely to "always visible" (today's behavior).
export const XdgToplevelState = {
  SUSPENDED: 9,
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

export const xkbSymbols = {
  xkb_keysym_to_utf8: { parameters: ["u32", "pointer", "usize"], result: "i32" },
  xkb_context_new: { parameters: ["i32"], result: "pointer" },
  xkb_context_unref: { parameters: ["pointer"], result: "void" },
  xkb_keymap_new_from_buffer: { parameters: ["pointer", "pointer", "usize", "i32", "i32"], result: "pointer" },
  xkb_keymap_unref: { parameters: ["pointer"], result: "void" },
  xkb_keymap_key_repeats: { parameters: ["pointer", "u32"], result: "i32" },
  xkb_state_new: { parameters: ["pointer"], result: "pointer" },
  xkb_state_unref: { parameters: ["pointer"], result: "void" },
  xkb_state_update_mask: {
    parameters: ["pointer", "u32", "u32", "u32", "u32", "u32", "u32"],
    result: "u32",
  },
  xkb_state_key_get_utf8: { parameters: ["pointer", "u32", "pointer", "usize"], result: "i32" },
  xkb_state_key_get_one_sym: { parameters: ["pointer", "u32"], result: "u32" },
  xkb_state_mod_name_is_active: { parameters: ["pointer", "buffer", "i32"], result: "i32" },
  xkb_compose_table_new_from_locale: {
    parameters: ["pointer", "buffer", "i32"],
    result: "pointer",
  },
  xkb_compose_table_unref: { parameters: ["pointer"], result: "void" },
  xkb_compose_state_new: { parameters: ["pointer", "i32"], result: "pointer" },
  xkb_compose_state_unref: { parameters: ["pointer"], result: "void" },
  xkb_compose_state_feed: { parameters: ["pointer", "u32"], result: "i32" },
  xkb_compose_state_reset: { parameters: ["pointer"], result: "void" },
  xkb_compose_state_get_status: { parameters: ["pointer"], result: "i32" },
  xkb_compose_state_get_utf8: { parameters: ["pointer", "pointer", "usize"], result: "i32" },
} as const;
