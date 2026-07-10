import type { ImeEvent, KeyEvent, KeyModifiers, Library, LoadLibrary, UIEvent, Window } from "../types.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { getDomCode } from "./dom_code.ts";
import {
  type ComposeAdapter,
  type CursorRectangle,
  keyLocationForCode,
  KeyRepeatController,
  normalizeCursorRectangle,
  resolveComposeLocale,
  type TextInputEdit,
  TextInputV3Batch,
  translateKey,
  type XkbKeyTranslator,
} from "./input.ts";
import {
  buildXdgIfaces,
  libdlSymbols,
  waylandSymbols,
  WlCursorShape,
  WlOp,
  WlSeatCap,
  WlShmFormat,
  XdgToplevelState,
  xkbSymbols,
} from "./ffi.ts";

// ---------------------------------------------------------------------------
// libc helpers (memfd, mmap, poll) — needed for shared-memory pixel buffers
// and non-blocking event polling.
// ---------------------------------------------------------------------------

const libcSymbols = {
  memfd_create: { parameters: ["buffer", "u32"], result: "i32" },
  ftruncate: { parameters: ["i32", "i64"], result: "i32" },
  // mmap(addr, length, prot, flags, fd, offset)
  mmap: { parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"], result: "pointer" },
  munmap: { parameters: ["pointer", "usize"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
  // poll(fds, nfds, timeout_ms)
  poll: { parameters: ["buffer", "u32", "i32"], result: "i32" },
} as const satisfies Deno.ForeignLibraryInterface;

const PROT_READ = 0x1;
const PROT_WRITE = 0x2;
const MAP_SHARED = 0x01;
const MAP_PRIVATE = 0x02;
const MAP_FAILED = 0xFFFFFFFFFFFFFFFFn;
const MFD_CLOEXEC = 1;
const POLLIN = 1;
const RTLD_NOW = 0x2;
const RTLD_NOLOAD = 0x4;
const LIBWAYLAND_CLIENT_SO = "libwayland-client.so.0";
const LIBXKBCOMMON_SO = "libxkbcommon.so.0";
const WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 = 1;
const XKB_CONTEXT_NO_FLAGS = 0;
const XKB_KEYMAP_FORMAT_TEXT_V1 = 1;
const XKB_KEYMAP_COMPILE_NO_FLAGS = 0;
const XKB_STATE_MODS_EFFECTIVE = 1 << 3;
const XKB_COMPOSE_COMPILE_NO_FLAGS = 0;
const XKB_COMPOSE_STATE_NO_FLAGS = 0;
const XKB_SHIFT_MASK = 1 << 0;
const XKB_LOCK_MASK = 1 << 1;
const XKB_CONTROL_MASK = 1 << 2;
const XKB_ALT_MASK = 1 << 3;
const XKB_META_MASK = 1 << 6;
const XKB_MOD_SHIFT = cStr("Shift");
const XKB_MOD_CONTROL = cStr("Control");
const XKB_MOD_ALT = cStr("Mod1");
const XKB_MOD_META = cStr("Mod4");
const XKB_MOD_LEVEL_THREE = cStr("LevelThree");
const XKB_MOD5 = cStr("Mod5");
// "Lock" is XKB's real-modifier name for Caps Lock (the same convention X11 uses).
const XKB_MOD_LOCK = cStr("Lock");
const WL_MARSHAL_FLAG_DESTROY = 1;

function getModifiers(mask: number): KeyModifiers {
  const ctrlKey = (mask & XKB_CONTROL_MASK) !== 0;
  return {
    shiftKey: (mask & XKB_SHIFT_MASK) !== 0,
    ctrlKey,
    altKey: (mask & XKB_ALT_MASK) !== 0,
    metaKey: (mask & XKB_META_MASK) !== 0,
    accelKey: ctrlKey,
    capsLock: (mask & XKB_LOCK_MASK) !== 0,
  };
}

function dlsymRequired(
  libdl: Deno.DynamicLibrary<typeof libdlSymbols>,
  handle: Deno.PointerObject,
  name: string,
): Deno.PointerObject {
  const pointer = libdl.symbols.dlsym(handle, cStr(name));
  if (!pointer) throw new Error(`winding failed to resolve symbol ${name}`);
  return pointer;
}

// Encode args for wl_proxy_marshal_array_flags. Each slot is one union wl_argument
// (8 bytes). Pass as "buffer" param so Deno hands libwayland a raw pointer.
function args(...vals: bigint[]): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array(vals.length === 0 ? [0n] : vals);
}

function nullableCString(pointer: Deno.PointerValue): string | null {
  return pointer ? new Deno.UnsafePointerView(pointer).getCString() : null;
}

// ---------------------------------------------------------------------------
// Helper to read event_count from a wl_interface struct at a known address.
// wl_interface layout: name(8) + version(4) + method_count(4) + methods(8)
//                    + event_count(4) = offset 24
// ---------------------------------------------------------------------------
function readEventCount(ifaceAddr: bigint): number {
  return new Deno.UnsafePointerView(Deno.UnsafePointer.create(ifaceAddr)!).getUint32(24);
}

// ---------------------------------------------------------------------------
// Check whether a `states: array` argument (a `struct wl_array *`, as delivered to e.g.
// xdg_toplevel::configure) contains a given uint32 value.
// wl_array layout (24 bytes, 64-bit): size_t size(8) + size_t alloc(8) + void *data(8).
// ---------------------------------------------------------------------------
function hasXdgToplevelState(statesPtr: Deno.PointerValue, state: number): boolean {
  if (!statesPtr) return false;
  const arrayView = new Deno.UnsafePointerView(statesPtr);
  const size = Number(arrayView.getBigUint64(0));
  if (size <= 0) return false;
  const dataPtr = Deno.UnsafePointer.create(arrayView.getBigUint64(16));
  if (!dataPtr) return false;

  const dataView = new Deno.UnsafePointerView(dataPtr);
  for (let offset = 0; offset < size; offset += 4) {
    if (dataView.getUint32(offset) === state) return true;
  }
  return false;
}

// Structural subset of Deno.UnsafeCallback used for heterogeneous collections.
// All UnsafeCallback instances satisfy this shape regardless of their parameter
// type arguments, letting us store callbacks of different signatures together.
type AnyCallback = { pointer: Deno.PointerObject; close(): void };

interface WaylandKeyEvent extends KeyEvent {
  window: WaylandWindow;
  key: string;
  repeat: boolean;
  isComposing: boolean;
  altGraphKey: boolean;
}

// ---------------------------------------------------------------------------
// Build a vtable (array of function pointers) for wl_proxy_add_listener.
// handlers[i] is the callback for event i; unhandled slots get noop.
// ---------------------------------------------------------------------------
function makeVtable(
  handlers: Array<AnyCallback | null>,
  totalSlots: number,
  noop: AnyCallback,
): BigUint64Array<ArrayBuffer> {
  const vtable = new BigUint64Array(Math.max(handlers.length, totalSlots));
  const noopPtr = Deno.UnsafePointer.value(noop.pointer);
  for (let i = 0; i < vtable.length; i++) {
    const cb = i < handlers.length ? handlers[i] : null;
    vtable[i] = cb ? Deno.UnsafePointer.value(cb.pointer) : noopPtr;
  }
  return vtable;
}

// ---------------------------------------------------------------------------
// WaylandWindow
// ---------------------------------------------------------------------------

class WaylandWindow implements Window {
  #surface: Deno.PointerObject;
  #xdgSurface: Deno.PointerObject;
  #xdgToplevel: Deno.PointerObject;
  // Listeners kept alive
  #surfaceVtable!: BigUint64Array<ArrayBuffer>;
  #toplevelVtable!: BigUint64Array<ArrayBuffer>;
  #xdgSurfaceConfigure!: AnyCallback;
  #toplevelConfigure!: AnyCallback;
  #toplevelClose!: AnyCallback;
  // SHM buffer
  #shmFd = -1;
  #shmPtr: Deno.PointerObject | null = null;
  #shmSize = 0;
  #buffer: Deno.PointerObject | null = null;
  #width: number;
  #height: number;
  // Pending configure serial from xdg_surface
  #pendingSerial = 0;
  #configured = false;
  // Last-seen `suspended` bit from xdg_toplevel::configure's states array, used to only
  // push a `visibilitychange` event when it actually flips.
  #suspended = false;
  #closed = false;
  #imeEnabled = false;
  #imeCursorRectangle: CursorRectangle | undefined;

  constructor(readonly lib: WaylandLibrary, w: number, h: number) {
    const sym = lib.wl.symbols;

    // Create wl_surface
    const surface = sym.wl_proxy_marshal_array_flags(
      lib.compositor!,
      WlOp.COMPOSITOR_CREATE_SURFACE,
      lib.ifaces.surface,
      sym.wl_proxy_get_version(lib.compositor!),
      0,
      args(0n),
    );
    if (!surface) throw new Error("winding failed to create wl_surface");
    this.#surface = surface;

    // Create xdg_surface wrapping the wl_surface
    const xdgSurface = sym.wl_proxy_marshal_array_flags(
      lib.xdgWmBase!,
      WlOp.XDG_WM_BASE_GET_XDG_SURFACE,
      lib.xdgSurfaceIface,
      sym.wl_proxy_get_version(lib.xdgWmBase!),
      0,
      args(0n, BigInt(Deno.UnsafePointer.value(surface))),
    );
    if (!xdgSurface) throw new Error("winding failed to create xdg_surface");
    this.#xdgSurface = xdgSurface;

    // Create xdg_toplevel
    const xdgToplevel = sym.wl_proxy_marshal_array_flags(
      xdgSurface,
      WlOp.XDG_SURFACE_GET_TOPLEVEL,
      lib.xdgToplevelIface,
      sym.wl_proxy_get_version(xdgSurface),
      0,
      args(0n),
    );
    if (!xdgToplevel) throw new Error("winding failed to create xdg_toplevel");
    this.#xdgToplevel = xdgToplevel;

    this.#width = w;
    this.#height = h;

    this.#setupListeners();
    this.setTitle("winding");

    // Register before the first commit/roundtrip: keyboard and text-input
    // enter callbacks identify their target by wl_surface pointer.
    lib.registerWindow(this.#surface, this);

    try {
      // Initial empty commit -- compositor will reply with configure
      sym.wl_proxy_marshal_array_flags(
        this.#surface,
        WlOp.SURFACE_COMMIT,
        null,
        sym.wl_proxy_get_version(this.#surface),
        0,
        args(),
      );
      sym.wl_display_roundtrip(lib.display);

      // Ack the configure we just received
      this.#ackPendingConfigure();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get imeEnabled(): boolean {
    return this.#imeEnabled;
  }

  get imeCursorRectangle(): CursorRectangle | undefined {
    return this.#imeCursorRectangle;
  }

  #setupListeners(): void {
    const sym = this.lib.wl.symbols;
    const noop = this.lib.noop;

    // xdg_surface listener: event 0 = configure(serial:u)
    this.#xdgSurfaceConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      (_data, _surface, serial) => {
        this.#pendingSerial = serial;
      },
    );
    // xdg_surface has exactly 1 event (configure) -- use our built interface's count.
    this.#surfaceVtable = makeVtable([this.#xdgSurfaceConfigure], 1, noop);
    sym.wl_proxy_add_listener(this.#xdgSurface, Deno.UnsafePointer.of(this.#surfaceVtable), null);

    // xdg_toplevel listener: event 0 = configure(w:i,h:i,states:a), event 1 = close
    this.#toplevelConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32", "pointer"], result: "void" },
      (_data, _toplevel, width, height, states) => {
        if (width > 0 && height > 0) {
          this.lib.pushEvent({ type: "resize", width, height, window: this });
        }

        const suspended = hasXdgToplevelState(states, XdgToplevelState.SUSPENDED);
        if (suspended !== this.#suspended) {
          this.#suspended = suspended;
          this.lib.pushEvent({ type: "visibilitychange", visible: !suspended, window: this });
        }
      },
    );
    this.#toplevelClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      () => {
        this.lib.pushEvent({ type: "close", window: this });
      },
    );
    // xdg_toplevel has 4 events but we only handle the first 2; rest get noop.
    this.#toplevelVtable = makeVtable([this.#toplevelConfigure, this.#toplevelClose], 4, noop);
    sym.wl_proxy_add_listener(this.#xdgToplevel, Deno.UnsafePointer.of(this.#toplevelVtable), null);
  }

  #ackPendingConfigure(): void {
    if (this.#pendingSerial === 0) return;
    const sym = this.lib.wl.symbols;
    sym.wl_proxy_marshal_array_flags(
      this.#xdgSurface,
      WlOp.XDG_SURFACE_ACK_CONFIGURE,
      null,
      sym.wl_proxy_get_version(this.#xdgSurface),
      0,
      args(BigInt(this.#pendingSerial)),
    );
    this.#pendingSerial = 0;
    this.#configured = true;
  }

  setTitle(title: string): void {
    const sym = this.lib.wl.symbols;
    const titleBuf = cStr(title);
    sym.wl_proxy_marshal_array_flags(
      this.#xdgToplevel,
      WlOp.XDG_TOPLEVEL_SET_TITLE,
      null,
      sym.wl_proxy_get_version(this.#xdgToplevel),
      0,
      args(Deno.UnsafePointer.value(Deno.UnsafePointer.of(titleBuf))),
    );
    sym.wl_display_flush(this.lib.display);
  }

  setImeEnabled(enabled: boolean): void {
    if (this.#closed || this.#imeEnabled === enabled) return;
    this.#imeEnabled = enabled;
    this.lib.updateWindowImeState(this);
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    if (this.#closed) return;
    this.#imeCursorRectangle = normalizeCursorRectangle(x, y, width, height);
    this.lib.updateWindowImeCursorRectangle(this);
  }

  /**
   * Copy an RGBA pixel buffer to the Wayland surface. Converts to ARGB8888
   * (the most widely supported wl_shm format) before blitting.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    const sym = this.lib.wl.symbols;
    // Ack each configure serial before committing the next frame.
    this.#ackPendingConfigure();
    if (!this.#configured) return; // wait for first configure roundtrip
    const size = width * height * 4;

    // Recreate SHM storage when dimensions change
    if (width !== this.#width || height !== this.#height || this.#shmFd < 0) {
      this.#destroyShmBuffer();
      this.#width = width;
      this.#height = height;
      this.#shmFd = this.lib.libc.symbols.memfd_create(cStr("winding-shm"), MFD_CLOEXEC);
      if (this.#shmFd < 0) throw new Error("winding memfd_create failed");
      if (this.lib.libc.symbols.ftruncate(this.#shmFd, BigInt(size)) !== 0) throw new Error("winding ftruncate failed");
      const mapped = this.lib.libc.symbols.mmap(
        null,
        BigInt(size),
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        this.#shmFd,
        0n,
      );
      if (!mapped || BigInt(Deno.UnsafePointer.value(mapped)) === MAP_FAILED) throw new Error("winding mmap failed");
      this.#shmPtr = mapped;
      this.#shmSize = size;

      // Create wl_shm_pool from fd, then a wl_buffer from the pool
      const pool = sym.wl_proxy_marshal_array_flags(
        this.lib.shm!,
        WlOp.SHM_CREATE_POOL,
        this.lib.ifaces.shmPool,
        sym.wl_proxy_get_version(this.lib.shm!),
        0,
        args(0n, BigInt(this.#shmFd), BigInt(size)),
      );
      if (!pool) throw new Error("winding wl_shm_create_pool failed");

      this.#buffer = sym.wl_proxy_marshal_array_flags(
        pool,
        WlOp.SHM_POOL_CREATE_BUFFER,
        this.lib.ifaces.buffer,
        sym.wl_proxy_get_version(pool),
        0,
        args(0n, 0n, BigInt(width), BigInt(height), BigInt(width * 4), BigInt(WlShmFormat.ARGB8888)),
      );
      sym.wl_proxy_marshal_array_flags(pool, WlOp.SHM_POOL_DESTROY, null, sym.wl_proxy_get_version(pool), 1, args());
      if (!this.#buffer) throw new Error("winding wl_shm_pool_create_buffer failed");
    }

    // Write pixels: RGBA -> ARGB8888 (stored as BGRA in little-endian memory)
    const dest = new Uint8Array(
      new Deno.UnsafePointerView(this.#shmPtr!).getArrayBuffer(size),
    );
    for (let i = 0; i < rgba.length; i += 4) {
      dest[i] = rgba[i + 2]; // B <- src R
      dest[i + 1] = rgba[i + 1]; // G
      dest[i + 2] = rgba[i]; // R <- src B
      dest[i + 3] = rgba[i + 3]; // A
    }

    const v = sym.wl_proxy_get_version(this.#surface);
    sym.wl_proxy_marshal_array_flags(
      this.#surface,
      WlOp.SURFACE_ATTACH,
      null,
      v,
      0,
      args(
        Deno.UnsafePointer.value(this.#buffer!),
        0n,
        0n,
      ),
    );
    // Use damage_buffer (opcode 9, since wl_surface version >= 4) to avoid scaling
    sym.wl_proxy_marshal_array_flags(
      this.#surface,
      WlOp.SURFACE_DAMAGE_BUFFER,
      null,
      v,
      0,
      args(
        0n,
        0n,
        BigInt(width),
        BigInt(height),
      ),
    );
    sym.wl_proxy_marshal_array_flags(this.#surface, WlOp.SURFACE_COMMIT, null, v, 0, args());
    sym.wl_display_flush(this.lib.display);
  }

  #destroyShmBuffer(): void {
    const sym = this.lib.wl.symbols;
    if (this.#buffer) {
      sym.wl_proxy_marshal_array_flags(this.#buffer, WlOp.BUFFER_DESTROY, null, 1, 1, args());
      this.#buffer = null;
    }
    if (this.#shmPtr && this.#shmSize > 0) {
      this.lib.libc.symbols.munmap(this.#shmPtr, BigInt(this.#shmSize));
      this.#shmPtr = null;
      this.#shmSize = 0;
    }
    if (this.#shmFd >= 0) {
      this.lib.libc.symbols.close(this.#shmFd);
      this.#shmFd = -1;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.lib.unregisterWindow(this.#surface, this);
    this.#destroyShmBuffer();
    const sym = this.lib.wl.symbols;
    const f = WL_MARSHAL_FLAG_DESTROY;
    sym.wl_proxy_marshal_array_flags(this.#xdgToplevel, WlOp.XDG_TOPLEVEL_DESTROY, null, 1, f, args());
    sym.wl_proxy_marshal_array_flags(this.#xdgSurface, WlOp.XDG_SURFACE_DESTROY, null, 1, f, args());
    sym.wl_proxy_marshal_array_flags(this.#surface, WlOp.SURFACE_DESTROY, null, 1, f, args());
    this.#xdgSurfaceConfigure.close();
    this.#toplevelConfigure.close();
    this.#toplevelClose.close();
  }
}

// ---------------------------------------------------------------------------
// WaylandLibrary
// ---------------------------------------------------------------------------

class WaylandLibrary implements Library {
  readonly libc: Deno.DynamicLibrary<typeof libcSymbols>;
  readonly libdl: Deno.DynamicLibrary<typeof libdlSymbols>;
  readonly #wlHandle: Deno.PointerObject;
  readonly wl: Deno.DynamicLibrary<typeof waylandSymbols>;
  readonly xkb: Deno.DynamicLibrary<typeof xkbSymbols>;
  readonly #xkbContext: Deno.PointerObject;
  #xkbComposeTable: Deno.PointerObject | null = null;
  #xkbComposeState: Deno.PointerObject | null = null;
  readonly display: Deno.PointerObject;
  // XDG interface structs -- built lazily in the constructor, mem kept alive to
  // prevent the pinned buffer from being GC'd.
  readonly #xdgMem: Uint8Array<ArrayBuffer>;
  readonly xdgWmBaseIface: Deno.PointerObject;
  readonly xdgSurfaceIface: Deno.PointerObject;
  readonly xdgToplevelIface: Deno.PointerObject;
  readonly wpCursorShapeManagerIface: Deno.PointerObject;
  readonly wpCursorShapeDeviceIface: Deno.PointerObject;
  readonly zwpTextInputManagerIface: Deno.PointerObject;
  readonly zwpTextInputIface: Deno.PointerObject;
  readonly ifaces: {
    registry: Deno.PointerObject;
    compositor: Deno.PointerObject;
    shm: Deno.PointerObject;
    shmPool: Deno.PointerObject;
    buffer: Deno.PointerObject;
    surface: Deno.PointerObject;
    seat: Deno.PointerObject;
    pointer: Deno.PointerObject;
    keyboard: Deno.PointerObject;
  };
  readonly windows = new Set<WaylandWindow>();
  readonly #windowsBySurface = new Map<bigint, WaylandWindow>();
  // Globals bound from registry -- set during init roundtrip
  compositor: Deno.PointerObject | null = null;
  shm: Deno.PointerObject | null = null;
  xdgWmBase: Deno.PointerObject | null = null;
  #cursorShapeManager: Deno.PointerObject | null = null;
  #cursorShapeDevice: Deno.PointerObject | null = null;
  #seat: Deno.PointerObject | null = null;
  #pointer: Deno.PointerObject | null = null;
  #keyboard: Deno.PointerObject | null = null;
  #keyboardFocus: WaylandWindow | null = null;
  #xkbKeymap: Deno.PointerObject | null = null;
  #xkbState: Deno.PointerObject | null = null;
  #modifiers: KeyModifiers = getModifiers(0);
  #altGraphKey = false;
  #textInputManager: Deno.PointerObject | null = null;
  #textInput: Deno.PointerObject | null = null;
  #textInputFocus: WaylandWindow | null = null;
  #textInputEnabledWindow: WaylandWindow | null = null;
  readonly #textInputBatch = new TextInputV3Batch();
  readonly #repeat = new KeyRepeatController();
  // Event queue filled by listener callbacks, drained by event()
  #events: UIEvent[] = [];
  // Shared no-op callback for unused vtable slots
  readonly noop: Deno.UnsafeCallback;
  // All listeners kept alive to prevent GC
  #listeners: AnyCallback[] = [];
  #vtables: BigUint64Array<ArrayBuffer>[] = [];
  // pollfd buffer for non-blocking display read
  #pollFd = new Uint8Array(8) as Uint8Array<ArrayBuffer>; // struct pollfd {int fd; short events; short revents;}
  #closed = false;

  constructor() {
    this.libc = Deno.dlopen("libc.so.6", libcSymbols); // needed to perform a few syscalls
    this.libdl = Deno.dlopen("libdl.so.2", libdlSymbols);
    this.wl = Deno.dlopen(LIBWAYLAND_CLIENT_SO, waylandSymbols);
    this.xkb = Deno.dlopen(LIBXKBCOMMON_SO, xkbSymbols);
    const xkbContext = this.xkb.symbols.xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!xkbContext) throw new Error("winding failed to create xkb context");
    this.#xkbContext = xkbContext;
    this.#initCompose();
    // Retrieve an existing loader handle for dlsym without loading a second time.
    const wlHandle = this.libdl.symbols.dlopen(cStr(LIBWAYLAND_CLIENT_SO), RTLD_NOW | RTLD_NOLOAD);
    if (!wlHandle) throw new Error(`winding failed to get existing ${LIBWAYLAND_CLIENT_SO} handle via libdl`);
    this.#wlHandle = wlHandle;
    const ifaces = {
      registry: dlsymRequired(this.libdl, wlHandle, "wl_registry_interface"),
      compositor: dlsymRequired(this.libdl, wlHandle, "wl_compositor_interface"),
      shm: dlsymRequired(this.libdl, wlHandle, "wl_shm_interface"),
      shmPool: dlsymRequired(this.libdl, wlHandle, "wl_shm_pool_interface"),
      buffer: dlsymRequired(this.libdl, wlHandle, "wl_buffer_interface"),
      surface: dlsymRequired(this.libdl, wlHandle, "wl_surface_interface"),
      seat: dlsymRequired(this.libdl, wlHandle, "wl_seat_interface"),
      pointer: dlsymRequired(this.libdl, wlHandle, "wl_pointer_interface"),
      keyboard: dlsymRequired(this.libdl, wlHandle, "wl_keyboard_interface"),
    };
    const {
      mem,
      xdgWmBaseIface,
      xdgSurfaceIface,
      xdgToplevelIface,
      wpCursorShapeManagerIface,
      wpCursorShapeDeviceIface,
      zwpTextInputManagerIface,
      zwpTextInputIface,
    } = buildXdgIfaces(ifaces.seat, ifaces.surface);
    this.#xdgMem = mem;
    this.xdgWmBaseIface = xdgWmBaseIface;
    this.xdgSurfaceIface = xdgSurfaceIface;
    this.xdgToplevelIface = xdgToplevelIface;
    this.wpCursorShapeManagerIface = wpCursorShapeManagerIface;
    this.wpCursorShapeDeviceIface = wpCursorShapeDeviceIface;
    this.zwpTextInputManagerIface = zwpTextInputManagerIface;
    this.zwpTextInputIface = zwpTextInputIface;
    this.ifaces = ifaces;
    const sym = this.wl.symbols;

    // NULL asks libwayland to use the default display from the environment.
    const display = sym.wl_display_connect(null);
    if (!display) throw new Error("winding failed to connect to Wayland display");
    this.display = display;

    this.noop = new Deno.UnsafeCallback({ parameters: [], result: "void" }, () => {});

    // Set up pollfd for display fd
    const fd = sym.wl_display_get_fd(display);
    const pollDv = new DataView(this.#pollFd.buffer);
    pollDv.setInt32(0, fd, true); // fd
    pollDv.setInt16(4, POLLIN, true); // events = POLLIN
    // revents at offset 6 is zeroed by default

    this.#initGlobals();
    this.#initSeat();
  }

  #initCompose(): void {
    const create = (locale: string): boolean => {
      const table = this.xkb.symbols.xkb_compose_table_new_from_locale(
        this.#xkbContext,
        cStr(locale),
        XKB_COMPOSE_COMPILE_NO_FLAGS,
      );
      if (!table) return false;
      const state = this.xkb.symbols.xkb_compose_state_new(table, XKB_COMPOSE_STATE_NO_FLAGS);
      if (!state) {
        this.xkb.symbols.xkb_compose_table_unref(table);
        return false;
      }
      this.#xkbComposeTable = table;
      this.#xkbComposeState = state;
      return true;
    };

    const locale = resolveComposeLocale();
    if (!create(locale) && locale !== "C") create("C");
  }

  #initGlobals(): void {
    const sym = this.wl.symbols;

    // Get registry
    const registry = sym.wl_proxy_marshal_array_flags(
      this.display,
      WlOp.DISPLAY_GET_REGISTRY,
      this.ifaces.registry,
      sym.wl_proxy_get_version(this.display),
      0,
      args(0n),
    );
    if (!registry) throw new Error("winding failed to get Wayland registry");

    // Registry global callback: bind compositor, shm, seat, xdg_wm_base
    const globalCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer", "u32"], result: "void" },
      (_data, reg, name, ifacePtr, version) => {
        if (!ifacePtr || !reg) return;
        const iface = new Deno.UnsafePointerView(ifacePtr).getCString();
        this.#bindGlobal(reg, name, iface, version);
      },
    );
    const globalRemoveCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      () => {},
    );
    this.#listeners.push(globalCb, globalRemoveCb);

    const regVtable = makeVtable([globalCb, globalRemoveCb], 2, this.noop);
    this.#vtables.push(regVtable);
    sym.wl_proxy_add_listener(registry, Deno.UnsafePointer.of(regVtable), null);

    sym.wl_display_roundtrip(this.display);
  }

  #bindGlobal(registry: Deno.PointerObject, name: number, iface: string, offered: number): void {
    const sym = this.wl.symbols;

    let ifacePtr: Deno.PointerObject | null = null;
    let version = 1;

    if (iface === "wl_compositor") {
      ifacePtr = this.ifaces.compositor;
      version = Math.min(offered, 4);
    } else if (iface === "wl_shm") {
      ifacePtr = this.ifaces.shm;
      version = Math.min(offered, 1);
    } else if (iface === "wl_seat") {
      ifacePtr = this.ifaces.seat;
      version = Math.min(offered, 5);
    } else if (iface === "xdg_wm_base") {
      ifacePtr = this.xdgWmBaseIface;
      version = Math.min(offered, 7);
    } else if (iface === "wp_cursor_shape_manager_v1") {
      ifacePtr = this.wpCursorShapeManagerIface;
      version = Math.min(offered, 1);
    } else if (iface === "zwp_text_input_manager_v3") {
      ifacePtr = this.zwpTextInputManagerIface;
      version = Math.min(offered, 1);
    } else {
      return;
    }

    const ifaceName = cStr(iface);
    const proxy = sym.wl_proxy_marshal_array_flags(
      registry,
      WlOp.REGISTRY_BIND,
      ifacePtr,
      version,
      0,
      args(
        BigInt(name),
        Deno.UnsafePointer.value(Deno.UnsafePointer.of(ifaceName)),
        BigInt(version),
        0n,
      ),
    );
    if (!proxy) return;

    if (iface === "wl_compositor") this.compositor = proxy;
    else if (iface === "wl_shm") this.shm = proxy;
    else if (iface === "wl_seat") this.#seat = proxy;
    else if (iface === "xdg_wm_base") {
      this.xdgWmBase = proxy;
      this.#setupXdgWmBaseListener(proxy);
    } else if (iface === "wp_cursor_shape_manager_v1") {
      this.#cursorShapeManager = proxy;
    } else if (iface === "zwp_text_input_manager_v3") {
      this.#textInputManager = proxy;
      this.#maybeInitTextInput();
    }
  }

  #setDefaultCursorShape(serial: number): void {
    if (!this.#cursorShapeDevice) return;
    const sym = this.wl.symbols;
    sym.wl_proxy_marshal_array_flags(
      this.#cursorShapeDevice,
      WlOp.WP_CURSOR_SHAPE_DEVICE_SET_SHAPE,
      null,
      sym.wl_proxy_get_version(this.#cursorShapeDevice),
      0,
      args(BigInt(serial), BigInt(WlCursorShape.DEFAULT)),
    );
  }

  #setupXdgWmBaseListener(wmBase: Deno.PointerObject): void {
    const sym = this.wl.symbols;
    const pingCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      (_data, wmb, serial) => {
        // Respond to ping to avoid being killed for being unresponsive
        sym.wl_proxy_marshal_array_flags(
          wmb!,
          WlOp.XDG_WM_BASE_PONG,
          null,
          sym.wl_proxy_get_version(wmb!),
          0,
          args(BigInt(serial)),
        );
      },
    );
    this.#listeners.push(pingCb);
    const vtable = makeVtable([pingCb], 1, this.noop);
    this.#vtables.push(vtable);
    sym.wl_proxy_add_listener(wmBase, Deno.UnsafePointer.of(vtable), null);
  }

  #initSeat(): void {
    if (!this.#seat) return;
    const sym = this.wl.symbols;

    const capCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      (_data, _seat, caps) => {
        if ((caps & WlSeatCap.POINTER) && !this.#pointer) this.#initPointer();
        if ((caps & WlSeatCap.KEYBOARD) && !this.#keyboard) this.#initKeyboard();
        if (!(caps & WlSeatCap.KEYBOARD) && this.#keyboard) this.#releaseKeyboard();
      },
    );
    const nameCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      () => {},
    );
    this.#listeners.push(capCb, nameCb);
    const seatVtable = makeVtable(
      [capCb, nameCb],
      readEventCount(Deno.UnsafePointer.value(this.ifaces.seat)),
      this.noop,
    );
    this.#vtables.push(seatVtable);
    sym.wl_proxy_add_listener(this.#seat, Deno.UnsafePointer.of(seatVtable), null);
    this.#maybeInitTextInput();
    sym.wl_display_roundtrip(this.display);
  }

  #maybeInitTextInput(): void {
    if (this.#textInput || !this.#textInputManager || !this.#seat) return;
    const sym = this.wl.symbols;
    const textInput = sym.wl_proxy_marshal_array_flags(
      this.#textInputManager,
      WlOp.ZWP_TEXT_INPUT_MANAGER_GET_TEXT_INPUT,
      this.zwpTextInputIface,
      sym.wl_proxy_get_version(this.#textInputManager),
      0,
      args(0n, Deno.UnsafePointer.value(this.#seat)),
    );
    if (!textInput) return;
    this.#textInput = textInput;

    const enterCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      (_data, _textInput, surface) => {
        const window = this.#windowForSurface(surface);
        const previousWindow = this.#textInputEnabledWindow ?? this.#textInputFocus;
        if (previousWindow) this.#deactivateTextInput(previousWindow, false);
        else this.#textInputBatch.resetEdits();

        this.#textInputFocus = window;
        if (window?.imeEnabled) this.#activateTextInput(window);
      },
    );
    const leaveCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      (_data, _textInput, surface) => {
        const window = this.#windowForSurface(surface);
        if (!window || window !== this.#textInputFocus) return;
        this.#deactivateTextInput(window, false);
        this.#textInputFocus = null;
      },
    );
    const preeditCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer", "i32", "i32"], result: "void" },
      (_data, _textInput, text, cursorBegin, cursorEnd) => {
        if (!this.#textInputFocus || this.#textInputEnabledWindow !== this.#textInputFocus) return;
        this.#textInputBatch.setPreedit(nullableCString(text), cursorBegin, cursorEnd);
      },
    );
    const commitCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      (_data, _textInput, text) => {
        if (!this.#textInputFocus || this.#textInputEnabledWindow !== this.#textInputFocus) return;
        this.#textInputBatch.setCommit(nullableCString(text));
      },
    );
    const deleteCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32"], result: "void" },
      (_data, _textInput, beforeLength, afterLength) => {
        if (!this.#textInputFocus || this.#textInputEnabledWindow !== this.#textInputFocus) return;
        this.#textInputBatch.setDeleteSurrounding(beforeLength, afterLength);
      },
    );
    const doneCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      (_data, _textInput, serial) => {
        const window = this.#textInputEnabledWindow;
        if (!window || window !== this.#textInputFocus) {
          this.#textInputBatch.resetEdits();
          return;
        }
        const result = this.#textInputBatch.done(serial);
        // Edits are authoritative even when this serial describes an older
        // client-state commit. With no surrounding-text output yet, a lagging
        // serial requires no replay; a later done will acknowledge newer state.
        this.#emitTextInputEdits(window, result.edits);
      },
    );
    this.#listeners.push(enterCb, leaveCb, preeditCb, commitCb, deleteCb, doneCb);
    const vtable = makeVtable(
      [enterCb, leaveCb, preeditCb, commitCb, deleteCb, doneCb],
      readEventCount(Deno.UnsafePointer.value(this.zwpTextInputIface)),
      this.noop,
    );
    this.#vtables.push(vtable);
    sym.wl_proxy_add_listener(textInput, Deno.UnsafePointer.of(vtable), null);
  }

  #activateTextInput(window: WaylandWindow): void {
    if (!this.#textInput || this.#textInputFocus !== window || this.#textInputEnabledWindow === window) return;
    const sym = this.wl.symbols;
    sym.wl_proxy_marshal_array_flags(
      this.#textInput,
      WlOp.ZWP_TEXT_INPUT_ENABLE,
      null,
      1,
      0,
      args(),
    );
    const rectangle = window.imeCursorRectangle;
    if (rectangle) this.#sendTextInputCursorRectangle(rectangle);
    this.#commitTextInputState();
    this.#textInputEnabledWindow = window;
    this.#events.push({ type: "ime", kind: "enabled", window });
    sym.wl_display_flush(this.display);
  }

  #deactivateTextInput(window: WaylandWindow, sendProtocol: boolean): void {
    const wasEnabled = this.#textInputEnabledWindow === window;
    this.#emitTextInputEdits(window, this.#textInputBatch.resetEdits());

    if (sendProtocol && this.#textInput && this.#textInputFocus === window) {
      const sym = this.wl.symbols;
      sym.wl_proxy_marshal_array_flags(
        this.#textInput,
        WlOp.ZWP_TEXT_INPUT_DISABLE,
        null,
        1,
        0,
        args(),
      );
      this.#commitTextInputState();
      sym.wl_display_flush(this.display);
    }

    if (wasEnabled) {
      this.#textInputEnabledWindow = null;
      this.#events.push({ type: "ime", kind: "disabled", window });
    }
  }

  #sendTextInputCursorRectangle(rectangle: CursorRectangle): void {
    if (!this.#textInput) return;
    this.wl.symbols.wl_proxy_marshal_array_flags(
      this.#textInput,
      WlOp.ZWP_TEXT_INPUT_SET_CURSOR_RECTANGLE,
      null,
      1,
      0,
      args(
        BigInt(rectangle.x),
        BigInt(rectangle.y),
        BigInt(rectangle.width),
        BigInt(rectangle.height),
      ),
    );
  }

  #commitTextInputState(): void {
    if (!this.#textInput) return;
    this.wl.symbols.wl_proxy_marshal_array_flags(
      this.#textInput,
      WlOp.ZWP_TEXT_INPUT_COMMIT,
      null,
      1,
      0,
      args(),
    );
    this.#textInputBatch.recordClientCommit();
  }

  #emitTextInputEdits(window: WaylandWindow, edits: TextInputEdit[]): void {
    for (const edit of edits) {
      switch (edit.type) {
        case "preedit": {
          const event: ImeEvent = {
            type: "ime",
            kind: "preedit",
            window,
            text: edit.text,
            selection: edit.cursorRange ? { start: edit.cursorRange[0], end: edit.cursorRange[1] } : null,
          };
          if (edit.cursorRange !== undefined) event.cursorRange = edit.cursorRange;
          this.#events.push(event);
          break;
        }
        case "deleteSurrounding":
          this.#events.push({
            type: "ime",
            kind: "deleteSurrounding",
            window,
            beforeLength: edit.beforeLength,
            afterLength: edit.afterLength,
          });
          break;
        case "commit":
          this.#events.push({ type: "ime", kind: "commit", window, text: edit.text });
          break;
      }
    }
  }

  #initPointer(): void {
    const sym = this.wl.symbols;
    const pointer = sym.wl_proxy_marshal_array_flags(
      this.#seat!,
      WlOp.SEAT_GET_POINTER,
      this.ifaces.pointer,
      sym.wl_proxy_get_version(this.#seat!),
      0,
      args(0n),
    );
    if (!pointer) return;
    this.#pointer = pointer;

    if (this.#cursorShapeManager && !this.#cursorShapeDevice) {
      this.#cursorShapeDevice = sym.wl_proxy_marshal_array_flags(
        this.#cursorShapeManager,
        WlOp.WP_CURSOR_SHAPE_MANAGER_GET_POINTER,
        this.wpCursorShapeDeviceIface,
        sym.wl_proxy_get_version(this.#cursorShapeManager),
        0,
        args(0n, Deno.UnsafePointer.value(pointer)),
      );
    }

    // wl_pointer events (indices):
    // 0=enter, 1=leave, 2=motion, 3=button, 4=axis, 5=frame, 6=axis_source, 7=axis_stop, 8=axis_discrete ...
    const enterCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "pointer", "i32", "i32"], result: "void" },
      (_data, _ptr, serial) => {
        this.#setDefaultCursorShape(serial);
        this.#events.push({ type: "mouseenter" });
      },
    );
    const leaveCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface)
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      () => {
        this.#events.push({ type: "mouseleave" });
      },
    );
    const motionCb = new Deno.UnsafeCallback(
      // (data, pointer, time, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "i32", "i32"], result: "void" },
      (_data, _ptr, _time, xFixed, yFixed) => {
        this.#events.push({ type: "mousemove", x: xFixed >> 8, y: yFixed >> 8 });
      },
    );
    const buttonCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, time, button, state)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      (_data, _ptr, _serial, _time, button, state) => {
        // Linux input codes: BTN_LEFT=0x110, BTN_RIGHT=0x111, BTN_MIDDLE=0x112
        const btnMap: Record<number, "left" | "right" | "middle"> = { 0x110: "left", 0x111: "right", 0x112: "middle" };
        const b = btnMap[button];
        if (b === undefined) return;
        this.#events.push({ type: state ? "mousedown" : "mouseup", button: b });
      },
    );
    const axisCb = new Deno.UnsafeCallback(
      // (data, pointer, time, axis, value_fixed)
      { parameters: ["pointer", "pointer", "u32", "u32", "i32"], result: "void" },
      (_data, _ptr, _time, axis, value) => {
        const delta = value >> 8;
        if (axis === 0) this.#events.push({ type: "wheel", deltaX: 0, deltaY: delta });
        else if (axis === 1) this.#events.push({ type: "wheel", deltaX: delta, deltaY: 0 });
      },
    );
    this.#listeners.push(enterCb, leaveCb, motionCb, buttonCb, axisCb);
    const ptrEventCount = readEventCount(Deno.UnsafePointer.value(this.ifaces.pointer));
    const ptrVtable = makeVtable(
      [enterCb, leaveCb, motionCb, buttonCb, axisCb],
      ptrEventCount,
      this.noop,
    );
    this.#vtables.push(ptrVtable);
    sym.wl_proxy_add_listener(pointer, Deno.UnsafePointer.of(ptrVtable), null);
  }

  #readSizedUtf8(read: (buffer: Deno.PointerValue, size: bigint) => number): string {
    const required = read(null, 0n);
    if (required <= 0) return "";
    const buffer = new Uint8Array(required + 1) as Uint8Array<ArrayBuffer>;
    const written = read(Deno.UnsafePointer.of(buffer), BigInt(buffer.byteLength));
    if (written <= 0) return "";
    return new TextDecoder().decode(buffer.subarray(0, Math.min(written, required)));
  }

  #utf8ForKeysym(keysym: number): string {
    // xkb_keysym_to_utf8 differs from the state/Compose helpers: it requires
    // a buffer of at least seven bytes and includes the NUL in its return.
    const buffer = new Uint8Array(8) as Uint8Array<ArrayBuffer>;
    const written = this.xkb.symbols.xkb_keysym_to_utf8(
      keysym,
      Deno.UnsafePointer.of(buffer),
      BigInt(buffer.byteLength),
    );
    if (written <= 1) return "";
    return new TextDecoder().decode(buffer.subarray(0, written - 1));
  }

  #xkbTranslator(): XkbKeyTranslator | undefined {
    const state = this.#xkbState;
    if (!state) return undefined;
    return {
      keysymForKeycode: (keycode) => this.xkb.symbols.xkb_state_key_get_one_sym(state, keycode),
      utf8ForKeycode: (keycode) =>
        this.#readSizedUtf8((buffer, size) => this.xkb.symbols.xkb_state_key_get_utf8(state, keycode, buffer, size)),
      utf8ForKeysym: (keysym) => this.#utf8ForKeysym(keysym),
    };
  }

  #composeAdapter(): ComposeAdapter | undefined {
    const state = this.#xkbComposeState;
    if (!state) return undefined;
    return {
      feed: (keysym) => this.xkb.symbols.xkb_compose_state_feed(state, keysym),
      status: () => this.xkb.symbols.xkb_compose_state_get_status(state),
      utf8: () =>
        this.#readSizedUtf8((buffer, size) => this.xkb.symbols.xkb_compose_state_get_utf8(state, buffer, size)),
      reset: () => this.xkb.symbols.xkb_compose_state_reset(state),
    };
  }

  #resetCompose(): void {
    if (this.#xkbComposeState) this.xkb.symbols.xkb_compose_state_reset(this.#xkbComposeState);
  }

  #emitKey(rawKeycode: number, phase: "press" | "release" | "repeat"): void {
    const window = this.#keyboardFocus;
    if (!window) return;

    const translator = this.#xkbTranslator();
    const translated = translator ? translateKey(rawKeycode, phase, translator, this.#composeAdapter()) : {
      rawKeycode,
      xkbKeycode: rawKeycode + 8,
      keysym: 0,
      key: "Unidentified",
      isComposing: false,
    };
    const code = getDomCode(rawKeycode);
    const event: WaylandKeyEvent = {
      type: phase === "release" ? "keyup" : "keydown",
      window,
      keycode: rawKeycode,
      code,
      key: translated.key,
      location: keyLocationForCode(code),
      repeat: phase === "repeat",
      isComposing: translated.isComposing,
      altGraphKey: this.#altGraphKey,
      ...this.#modifiers,
    };
    if (translated.text !== undefined) event.text = translated.text;
    this.#events.push(event);
  }

  #enqueueDueKeyRepeat(): void {
    const rawKeycode = this.#repeat.poll();
    if (rawKeycode === undefined) return;
    if (!this.#keyboardFocus) {
      this.#repeat.cancel();
      return;
    }
    this.#emitKey(rawKeycode, "repeat");
  }

  #loadKeymap(format: number, fd: number, size: number): void {
    try {
      if (format !== WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 || size === 0) return;

      const byteLength = BigInt(size);
      const mapped = this.libc.symbols.mmap(null, byteLength, PROT_READ, MAP_PRIVATE, fd, 0n);
      if (mapped === null || Deno.UnsafePointer.value(mapped) === MAP_FAILED) return;

      try {
        const keymap = this.xkb.symbols.xkb_keymap_new_from_buffer(
          this.#xkbContext,
          mapped,
          byteLength,
          XKB_KEYMAP_FORMAT_TEXT_V1,
          XKB_KEYMAP_COMPILE_NO_FLAGS,
        );
        if (!keymap) return;

        const state = this.xkb.symbols.xkb_state_new(keymap);
        if (!state) {
          this.xkb.symbols.xkb_keymap_unref(keymap);
          return;
        }

        this.#replaceXkbState(keymap, state);
      } finally {
        this.libc.symbols.munmap(mapped, byteLength);
      }
    } finally {
      this.libc.symbols.close(fd);
    }
  }

  #replaceXkbState(keymap: Deno.PointerObject, state: Deno.PointerObject): void {
    this.#repeat.cancel();
    this.#resetCompose();
    if (this.#xkbState) this.xkb.symbols.xkb_state_unref(this.#xkbState);
    if (this.#xkbKeymap) this.xkb.symbols.xkb_keymap_unref(this.#xkbKeymap);
    this.#xkbKeymap = keymap;
    this.#xkbState = state;
    this.#modifiers = getModifiers(0);
    this.#altGraphKey = false;
  }

  #modifiersFromXkbState(): KeyModifiers {
    const state = this.#xkbState;
    if (!state) {
      this.#altGraphKey = false;
      return this.#modifiers;
    }

    const active = (name: Uint8Array): boolean =>
      this.xkb.symbols.xkb_state_mod_name_is_active(state, name, XKB_STATE_MODS_EFFECTIVE) > 0;
    const ctrlKey = active(XKB_MOD_CONTROL);
    this.#altGraphKey = active(XKB_MOD_LEVEL_THREE) || active(XKB_MOD5);
    return {
      shiftKey: active(XKB_MOD_SHIFT),
      ctrlKey,
      altKey: active(XKB_MOD_ALT),
      metaKey: active(XKB_MOD_META),
      accelKey: ctrlKey,
      capsLock: active(XKB_MOD_LOCK),
    };
  }

  #initKeyboard(): void {
    const sym = this.wl.symbols;
    const keyboard = sym.wl_proxy_marshal_array_flags(
      this.#seat!,
      WlOp.SEAT_GET_KEYBOARD,
      this.ifaces.keyboard,
      sym.wl_proxy_get_version(this.#seat!),
      0,
      args(0n),
    );
    if (!keyboard) return;
    this.#keyboard = keyboard;

    // wl_keyboard events: 0=keymap, 1=enter, 2=leave, 3=key, 4=modifiers, 5=repeat_info
    const keymapCb = new Deno.UnsafeCallback(
      // (data, keyboard, format, fd, size)
      { parameters: ["pointer", "pointer", "u32", "i32", "u32"], result: "void" },
      (_data, _kb, format, fd, size) => {
        this.#loadKeymap(format, fd, size);
      },
    );
    const kbEnterCb = new Deno.UnsafeCallback(
      // (data, keyboard, serial, surface, keys)
      { parameters: ["pointer", "pointer", "u32", "pointer", "pointer"], result: "void" },
      (_data, _keyboard, _serial, surface) => {
        const window = this.#windowForSurface(surface);
        if (!window) return;
        if (this.#keyboardFocus === window) return;
        if (this.#keyboardFocus) this.#events.push({ type: "blur", window: this.#keyboardFocus });
        this.#repeat.cancel();
        this.#resetCompose();
        this.#keyboardFocus = window;
        this.#events.push({ type: "focus", window });
      },
    );
    const kbLeaveCb = new Deno.UnsafeCallback(
      // (data, keyboard, serial, surface)
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      (_data, _keyboard, _serial, surface) => {
        const window = this.#windowForSurface(surface);
        if (!window || this.#keyboardFocus !== window) return;
        this.#repeat.cancel();
        this.#resetCompose();
        this.#keyboardFocus = null;
        this.#events.push({ type: "blur", window });
      },
    );
    const keyCb = new Deno.UnsafeCallback(
      // (data, keyboard, serial, time, key, state)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      (_data, _kb, _serial, _time, key, state) => {
        if (state) {
          if (!this.#keyboardFocus) return;
          this.#emitKey(key, "press");
          const repeatable = this.#xkbKeymap
            ? this.xkb.symbols.xkb_keymap_key_repeats(this.#xkbKeymap, key + 8) > 0
            : false;
          this.#repeat.press(key, repeatable);
        } else {
          this.#repeat.release(key);
          this.#emitKey(key, "release");
        }
      },
    );
    const modifiersCb = new Deno.UnsafeCallback(
      // (data, keyboard, serial, mods_depressed, mods_latched, mods_locked, group)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32", "u32"], result: "void" },
      (_data, _kb, _serial, depressed, latched, locked, _group) => {
        if (this.#xkbState) {
          this.xkb.symbols.xkb_state_update_mask(this.#xkbState, depressed, latched, locked, 0, 0, _group);
          this.#modifiers = this.#modifiersFromXkbState();
        } else {
          this.#modifiers = getModifiers(depressed | latched | locked);
          this.#altGraphKey = false;
        }
      },
    );
    const repeatInfoCb = new Deno.UnsafeCallback(
      // (data, keyboard, rate, delay)
      { parameters: ["pointer", "pointer", "i32", "i32"], result: "void" },
      (_data, _keyboard, rate, delay) => {
        this.#repeat.setRepeatInfo(rate, delay);
      },
    );
    this.#listeners.push(keymapCb, kbEnterCb, kbLeaveCb, keyCb, modifiersCb, repeatInfoCb);
    const kbEventCount = readEventCount(Deno.UnsafePointer.value(this.ifaces.keyboard));
    const kbVtable = makeVtable(
      [keymapCb, kbEnterCb, kbLeaveCb, keyCb, modifiersCb, repeatInfoCb],
      kbEventCount,
      this.noop,
    );
    this.#vtables.push(kbVtable);
    sym.wl_proxy_add_listener(keyboard, Deno.UnsafePointer.of(kbVtable), null);
  }

  #releaseKeyboard(): void {
    const keyboard = this.#keyboard;
    if (!keyboard) return;
    const focusedWindow = this.#keyboardFocus;
    this.#repeat.setRepeatInfo(0, 0);
    this.#resetCompose();
    this.#keyboardFocus = null;
    const version = this.wl.symbols.wl_proxy_get_version(keyboard);
    if (version >= 3) {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        keyboard,
        WlOp.KEYBOARD_RELEASE,
        null,
        version,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
    } else {
      this.wl.symbols.wl_proxy_destroy(keyboard);
    }
    this.#keyboard = null;
    if (this.#xkbState) {
      this.xkb.symbols.xkb_state_unref(this.#xkbState);
      this.#xkbState = null;
    }
    if (this.#xkbKeymap) {
      this.xkb.symbols.xkb_keymap_unref(this.#xkbKeymap);
      this.#xkbKeymap = null;
    }
    this.#modifiers = getModifiers(0);
    this.#altGraphKey = false;
    if (focusedWindow) this.#events.push({ type: "blur", window: focusedWindow });
  }

  #windowForSurface(surface: Deno.PointerValue): WaylandWindow | null {
    return surface ? this.#windowsBySurface.get(Deno.UnsafePointer.value(surface)) ?? null : null;
  }

  registerWindow(surface: Deno.PointerObject, window: WaylandWindow): void {
    this.#windowsBySurface.set(Deno.UnsafePointer.value(surface), window);
    this.windows.add(window);
  }

  unregisterWindow(surface: Deno.PointerObject, window: WaylandWindow): void {
    if (this.#textInputFocus === window) {
      this.#deactivateTextInput(window, true);
      this.#textInputFocus = null;
    }
    if (this.#keyboardFocus === window) {
      this.#repeat.cancel();
      this.#resetCompose();
      this.#keyboardFocus = null;
    }
    const key = Deno.UnsafePointer.value(surface);
    if (this.#windowsBySurface.get(key) === window) this.#windowsBySurface.delete(key);
    this.windows.delete(window);
  }

  updateWindowImeState(window: WaylandWindow): void {
    if (this.#textInputFocus !== window) return;
    if (window.imeEnabled) this.#activateTextInput(window);
    else this.#deactivateTextInput(window, true);
  }

  updateWindowImeCursorRectangle(window: WaylandWindow): void {
    const rectangle = window.imeCursorRectangle;
    if (!rectangle || this.#textInputEnabledWindow !== window || this.#textInputFocus !== window) return;
    this.#sendTextInputCursorRectangle(rectangle);
    this.#commitTextInputState();
    this.wl.symbols.wl_display_flush(this.display);
  }

  /** Called by WaylandWindow to push UI events into the shared queue. */
  pushEvent(event: UIEvent): void {
    this.#events.push(event);
  }

  openWindow(_x = 0, _y = 0, w = 800, h = 600): WaylandWindow {
    if (this.#closed) throw new Error("winding Wayland library is closed");
    if (!this.compositor || !this.shm || !this.xdgWmBase) {
      throw new Error("winding wayland globals not ready (compositor/shm/xdg_wm_base missing)");
    }
    return new WaylandWindow(this, w, h);
  }

  event(): UIEvent | undefined {
    if (this.#closed) return undefined;
    const sym = this.wl.symbols;
    sym.wl_display_flush(this.display);

    // Non-blocking read: prepare_read -> poll fd -> read_events or cancel_read
    if (sym.wl_display_prepare_read(this.display) === 0) {
      new DataView(this.#pollFd.buffer).setInt16(6, 0, true); // clear revents
      const ready = this.libc.symbols.poll(this.#pollFd, 1, 0);
      const revents = new DataView(this.#pollFd.buffer).getInt16(6, true);
      if (ready > 0 && (revents & POLLIN)) {
        sym.wl_display_read_events(this.display);
      } else {
        sym.wl_display_cancel_read(this.display);
      }
    }

    sym.wl_display_dispatch_pending(this.display);
    this.#enqueueDueKeyRepeat();
    return this.#events.shift();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const win of [...this.windows]) win.close();
    this.#repeat.cancel();
    this.#textInputBatch.resetEdits();
    if (this.#textInput) {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        this.#textInput,
        WlOp.ZWP_TEXT_INPUT_DESTROY,
        null,
        1,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
      this.#textInput = null;
    }
    if (this.#textInputManager) {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        this.#textInputManager,
        WlOp.ZWP_TEXT_INPUT_MANAGER_DESTROY,
        null,
        1,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
      this.#textInputManager = null;
    }
    if (this.#cursorShapeDevice) {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        this.#cursorShapeDevice,
        WlOp.WP_CURSOR_SHAPE_DEVICE_DESTROY,
        null,
        1,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
    }
    if (this.#cursorShapeManager) {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        this.#cursorShapeManager,
        WlOp.WP_CURSOR_SHAPE_MANAGER_DESTROY,
        null,
        1,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
    }
    if (this.#pointer) {
      const version = this.wl.symbols.wl_proxy_get_version(this.#pointer);
      if (version >= 3) {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          this.#pointer,
          WlOp.POINTER_RELEASE,
          null,
          version,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      } else {
        this.wl.symbols.wl_proxy_destroy(this.#pointer);
      }
    }
    this.#releaseKeyboard();
    if (this.#seat) {
      const version = this.wl.symbols.wl_proxy_get_version(this.#seat);
      if (version >= 5) {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          this.#seat,
          WlOp.SEAT_RELEASE,
          null,
          version,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      } else {
        this.wl.symbols.wl_proxy_destroy(this.#seat);
      }
    }
    for (const cb of this.#listeners) cb.close();
    this.noop.close();
    if (this.#xkbComposeState) this.xkb.symbols.xkb_compose_state_unref(this.#xkbComposeState);
    if (this.#xkbComposeTable) this.xkb.symbols.xkb_compose_table_unref(this.#xkbComposeTable);
    if (this.#xkbState) this.xkb.symbols.xkb_state_unref(this.#xkbState);
    if (this.#xkbKeymap) this.xkb.symbols.xkb_keymap_unref(this.#xkbKeymap);
    this.xkb.symbols.xkb_context_unref(this.#xkbContext);
    this.xkb.close();
    this.wl.symbols.wl_display_disconnect(this.display);
    this.wl.close();
    this.libdl.symbols.dlclose(this.#wlHandle);
    this.libdl.close();
    this.libc.close();
  }
}

export const load: LoadLibrary = () => new WaylandLibrary();
