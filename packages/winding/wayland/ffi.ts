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
  types?: (Deno.PointerObject | InterfaceKey | null)[],
];

type InterfaceKey =
  | "xdgPositioner"
  | "xdgWmBase"
  | "xdgSurface"
  | "xdgToplevel"
  | "xdgPopup"
  | "cursorShapeManager"
  | "cursorShapeDevice"
  | "textInputManager"
  | "textInput";

interface InterfaceDef {
  readonly key: InterfaceKey;
  readonly name: string;
  readonly version: number;
  readonly methods: MessageDef[];
  readonly events: MessageDef[];
}

function validateTypes(
  messageName: string,
  signature: string,
  types: MessageDef[2],
): void {
  const argumentsInSignature = [...signature].filter((character) => "iufsonah".includes(character));
  const hasObject = argumentsInSignature.some((character) => character === "o" || character === "n");
  if (!hasObject) return;
  if (!types || types.length !== argumentsInSignature.length) {
    throw new Error(`winding Wayland metadata for ${messageName} has an incomplete type table`);
  }
  for (let index = 0; index < argumentsInSignature.length; index++) {
    const argument = argumentsInSignature[index];
    if ((argument === "o" || argument === "n") && !types[index]) {
      throw new Error(`winding Wayland metadata for ${messageName} omits an object interface`);
    }
  }
}

export interface XdgIfaces {
  /** Pinned buffer — must be kept alive for the lifetime of the library. */
  mem: Uint8Array<ArrayBuffer>;
  xdgWmBaseIface: Deno.PointerObject;
  xdgSurfaceIface: Deno.PointerObject;
  xdgToplevelIface: Deno.PointerObject;
  wpCursorShapeManagerIface: Deno.PointerObject;
  wpCursorShapeDeviceIface: Deno.PointerObject;
  zwpTextInputManagerIface: Deno.PointerObject;
  zwpTextInputIface: Deno.PointerObject;
}

// Request/event signatures come from the corresponding generated protocol
// code (xdg-shell, cursor-shape-v1, and text-input-unstable-v3).
// Called once inside WaylandLibrary's constructor so no FFI work happens at
// module-load time.
export function buildXdgIfaces(
  wlSeatIface: Deno.PointerObject,
  wlSurfaceIface: Deno.PointerObject,
  wlPointerIface: Deno.PointerObject,
  wlOutputIface: Deno.PointerObject,
): XdgIfaces {
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

  const interfaceOffsets = new Map<InterfaceKey, number>();

  function buildTypes(types: (Deno.PointerObject | InterfaceKey | null)[] | undefined): number {
    if (!types) return 0;
    align8();
    const o = alloc(8 * types.length);
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const value = typeof type === "string"
        ? base + BigInt(interfaceOffsets.get(type)!)
        : type
        ? Deno.UnsafePointer.value(type)
        : 0n;
      dv.setBigUint64(o + i * 8, value, true);
    }
    return o;
  }

  function buildMsgs(msgs: MessageDef[]): number {
    if (msgs.length === 0) return 0;
    for (const [name, signature, types] of msgs) validateTypes(name, signature, types);
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

  function allocateIface(definition: InterfaceDef): number {
    const nameOff = cstr(definition.name);
    align8();
    const o = alloc(40);
    dv.setBigUint64(o, base + BigInt(nameOff), true);
    dv.setInt32(o + 8, definition.version, true);
    return o;
  }

  const definitions: InterfaceDef[] = [
    {
      key: "xdgWmBase",
      name: "xdg_wm_base",
      version: 7,
      methods: [
        ["destroy", ""],
        ["create_positioner", "n", ["xdgPositioner"]],
        ["get_xdg_surface", "no", ["xdgSurface", wlSurfaceIface]],
        ["pong", "u"],
      ],
      events: [["ping", "u"]],
    },
    {
      key: "xdgPositioner",
      name: "xdg_positioner",
      version: 7,
      methods: [
        ["destroy", ""],
        ["set_size", "ii"],
        ["set_anchor_rect", "iiii"],
        ["set_anchor", "u"],
        ["set_gravity", "u"],
        ["set_constraint_adjustment", "u"],
        ["set_offset", "ii"],
        ["set_reactive", "3"],
        ["set_parent_size", "3ii"],
        ["set_parent_configure", "3u"],
      ],
      events: [],
    },
    {
      key: "xdgSurface",
      name: "xdg_surface",
      version: 7,
      methods: [
        ["destroy", ""],
        ["get_toplevel", "n", ["xdgToplevel"]],
        ["get_popup", "n?oo", ["xdgPopup", "xdgSurface", "xdgPositioner"]],
        ["set_window_geometry", "iiii"],
        ["ack_configure", "u"],
      ],
      events: [["configure", "u"]],
    },
    {
      key: "xdgToplevel",
      name: "xdg_toplevel",
      version: 7,
      methods: [
        ["destroy", ""],
        ["set_parent", "?o", ["xdgToplevel"]],
        ["set_title", "s"],
        ["set_app_id", "s"],
        ["show_window_menu", "ouii", [wlSeatIface, null, null, null]],
        ["move", "ou", [wlSeatIface, null]],
        ["resize", "ouu", [wlSeatIface, null, null]],
        ["set_max_size", "ii"],
        ["set_min_size", "ii"],
        ["set_maximized", ""],
        ["unset_maximized", ""],
        ["set_fullscreen", "?o", [wlOutputIface]],
        ["unset_fullscreen", ""],
        ["set_minimized", ""],
      ],
      events: [
        ["configure", "iia"],
        ["close", ""],
        ["configure_bounds", "4ii"],
        ["wm_capabilities", "5a"],
      ],
    },
    {
      key: "xdgPopup",
      name: "xdg_popup",
      version: 7,
      methods: [
        ["destroy", ""],
        ["grab", "ou", [wlSeatIface, null]],
        ["reposition", "3ou", ["xdgPositioner", null]],
      ],
      events: [
        ["configure", "iiii"],
        ["popup_done", ""],
        ["repositioned", "3u"],
      ],
    },
    {
      key: "cursorShapeManager",
      name: "wp_cursor_shape_manager_v1",
      version: 1,
      methods: [
        ["destroy", ""],
        ["get_pointer", "no", ["cursorShapeDevice", wlPointerIface]],
      ],
      events: [],
    },
    {
      key: "cursorShapeDevice",
      name: "wp_cursor_shape_device_v1",
      version: 1,
      methods: [
        ["destroy", ""],
        ["set_shape", "uu"],
      ],
      events: [],
    },
    {
      key: "textInput",
      name: "zwp_text_input_v3",
      version: 1,
      methods: [
        ["destroy", ""],
        ["enable", ""],
        ["disable", ""],
        ["set_surrounding_text", "sii"],
        ["set_text_change_cause", "u"],
        ["set_content_type", "uu"],
        ["set_cursor_rectangle", "iiii"],
        ["commit", ""],
      ],
      events: [
        ["enter", "o", [wlSurfaceIface]],
        ["leave", "o", [wlSurfaceIface]],
        ["preedit_string", "?sii"],
        ["commit_string", "?s"],
        ["delete_surrounding_text", "uu"],
        ["done", "u"],
      ],
    },
    {
      key: "textInputManager",
      name: "zwp_text_input_manager_v3",
      version: 1,
      methods: [
        ["destroy", ""],
        ["get_text_input", "no", ["textInput", wlSeatIface]],
      ],
      events: [],
    },
  ];

  for (const definition of definitions) {
    interfaceOffsets.set(definition.key, allocateIface(definition));
  }
  for (const definition of definitions) {
    const interfaceOffset = interfaceOffsets.get(definition.key)!;
    const methodsOffset = buildMsgs(definition.methods);
    const eventsOffset = buildMsgs(definition.events);
    dv.setInt32(interfaceOffset + 12, definition.methods.length, true);
    dv.setBigUint64(interfaceOffset + 16, methodsOffset ? base + BigInt(methodsOffset) : 0n, true);
    dv.setInt32(interfaceOffset + 24, definition.events.length, true);
    dv.setBigUint64(interfaceOffset + 32, eventsOffset ? base + BigInt(eventsOffset) : 0n, true);
  }

  function interfacePointer(key: InterfaceKey): Deno.PointerObject {
    return Deno.UnsafePointer.create(base + BigInt(interfaceOffsets.get(key)!))!;
  }

  const xdgWmBaseIface = interfacePointer("xdgWmBase");
  const xdgSurfaceIface = interfacePointer("xdgSurface");
  const xdgToplevelIface = interfacePointer("xdgToplevel");
  const wpCursorShapeManagerIface = interfacePointer("cursorShapeManager");
  const wpCursorShapeDeviceIface = interfacePointer("cursorShapeDevice");
  const zwpTextInputManagerIface = interfacePointer("textInputManager");
  const zwpTextInputIface = interfacePointer("textInput");

  return {
    mem,
    xdgWmBaseIface,
    xdgSurfaceIface,
    xdgToplevelIface,
    wpCursorShapeManagerIface,
    wpCursorShapeDeviceIface,
    zwpTextInputManagerIface,
    zwpTextInputIface,
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
  // zwp_text_input_manager_v3 requests
  ZWP_TEXT_INPUT_MANAGER_DESTROY: 0,
  ZWP_TEXT_INPUT_MANAGER_GET_TEXT_INPUT: 1,
  // zwp_text_input_v3 requests
  ZWP_TEXT_INPUT_DESTROY: 0,
  ZWP_TEXT_INPUT_ENABLE: 1,
  ZWP_TEXT_INPUT_DISABLE: 2,
  ZWP_TEXT_INPUT_SET_SURROUNDING_TEXT: 3,
  ZWP_TEXT_INPUT_SET_TEXT_CHANGE_CAUSE: 4,
  ZWP_TEXT_INPUT_SET_CONTENT_TYPE: 5,
  ZWP_TEXT_INPUT_SET_CURSOR_RECTANGLE: 6,
  ZWP_TEXT_INPUT_COMMIT: 7,
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
  wl_display_get_error: { parameters: ["pointer"], result: "i32" },
  wl_display_get_protocol_error: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "u32",
  },
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
