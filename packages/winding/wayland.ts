import type { Library, LoadLibrary, UIEvent, Window } from "./types.ts";
import {
  waylandSymbols,
  WlOp,
  WlSeatCap,
  WlShmFormat,
  xdgSurfaceIface,
  xdgToplevelIface,
  xdgWmBaseIface,
} from "./wayland_ffi.ts";

// ---------------------------------------------------------------------------
// libc helpers (memfd, mmap, poll) — needed for shared-memory pixel buffers
// and non-blocking event polling.
// ---------------------------------------------------------------------------

const libc = Deno.dlopen("libc.so.6", {
  memfd_create: { parameters: ["buffer", "u32"], result: "i32" },
  ftruncate: { parameters: ["i32", "i64"], result: "i32" },
  // mmap(addr, length, prot, flags, fd, offset)
  mmap: { parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"], result: "pointer" },
  munmap: { parameters: ["pointer", "usize"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
  // poll(fds, nfds, timeout_ms)
  poll: { parameters: ["buffer", "u32", "i32"], result: "i32" },
});

const PROT_READ = 0x1;
const PROT_WRITE = 0x2;
const MAP_SHARED = 0x01;
const MAP_FAILED = 0xFFFFFFFFFFFFFFFFn;
const MFD_CLOEXEC = 1;
const POLLIN = 1;

function cStr(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(s.length + 1) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// Encode args for wl_proxy_marshal_array_flags. Each slot is one union wl_argument
// (8 bytes). Pass as "buffer" param so Deno hands libwayland a raw pointer.
function args(...vals: bigint[]): BigUint64Array<ArrayBuffer> {
  return new BigUint64Array(vals.length === 0 ? [0n] : vals) as BigUint64Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Helper to read event_count from a wl_interface struct at a known address.
// wl_interface layout: name(8) + version(4) + method_count(4) + methods(8)
//                    + event_count(4) = offset 24
// ---------------------------------------------------------------------------
function readEventCount(ifaceAddr: bigint): number {
  return new Deno.UnsafePointerView(Deno.UnsafePointer.create(ifaceAddr)!).getUint32(24);
}

// Structural subset of Deno.UnsafeCallback used for heterogeneous collections.
// All UnsafeCallback instances satisfy this shape regardless of their parameter
// type arguments, letting us store callbacks of different signatures together.
type AnyCallback = { pointer: Deno.PointerObject; close(): void };

// ---------------------------------------------------------------------------
// Build a vtable (array of function pointers) for wl_proxy_add_listener.
// handlers[i] is the callback for event i; unhandled slots get noop.
// ---------------------------------------------------------------------------
function makeVtable(
  handlers: (AnyCallback | null)[],
  totalSlots: number,
  noop: AnyCallback,
): BigUint64Array<ArrayBuffer> {
  const vtable = new BigUint64Array(Math.max(handlers.length, totalSlots)) as BigUint64Array<ArrayBuffer>;
  const noopPtr = BigInt(Deno.UnsafePointer.value(noop.pointer));
  for (let i = 0; i < vtable.length; i++) {
    const cb = i < handlers.length ? handlers[i] : null;
    vtable[i] = cb ? BigInt(Deno.UnsafePointer.value(cb.pointer)) : noopPtr;
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
  #width = 0;
  #height = 0;
  // Pending configure serial from xdg_surface
  #pendingSerial = 0;
  #configured = false;

  constructor(readonly lib: WaylandLibrary, w = 800, h = 600) {
    const sym = lib.wl.symbols;
    const surfaceIfacePtr = Deno.UnsafePointer.create(lib.wl.symbols.wl_surface_interface);

    // Create wl_surface
    const surface = sym.wl_proxy_marshal_array_flags(
      lib.compositor!,
      WlOp.COMPOSITOR_CREATE_SURFACE,
      surfaceIfacePtr,
      sym.wl_proxy_get_version(lib.compositor!),
      0,
      args(0n),
    );
    if (!surface) throw new Error("Failed to create wl_surface");
    this.#surface = surface;

    // Create xdg_surface wrapping the wl_surface
    const xdgSurface = sym.wl_proxy_marshal_array_flags(
      lib.xdgWmBase!,
      WlOp.XDG_WM_BASE_GET_XDG_SURFACE,
      xdgSurfaceIface,
      sym.wl_proxy_get_version(lib.xdgWmBase!),
      0,
      args(0n, BigInt(Deno.UnsafePointer.value(surface))),
    );
    if (!xdgSurface) throw new Error("Failed to create xdg_surface");
    this.#xdgSurface = xdgSurface;

    // Create xdg_toplevel
    const xdgToplevel = sym.wl_proxy_marshal_array_flags(
      xdgSurface,
      WlOp.XDG_SURFACE_GET_TOPLEVEL,
      xdgToplevelIface,
      sym.wl_proxy_get_version(xdgSurface),
      0,
      args(0n),
    );
    if (!xdgToplevel) throw new Error("Failed to create xdg_toplevel");
    this.#xdgToplevel = xdgToplevel;

    this.#width = w;
    this.#height = h;

    this.#setupListeners();
    this.#setTitle("Winding");

    // Initial empty commit — compositor will reply with configure
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
    if (this.#pendingSerial !== 0) {
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

    lib.windows.add(this);
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
    // xdg_surface has exactly 1 event (configure) — use our built interface's count.
    this.#surfaceVtable = makeVtable([this.#xdgSurfaceConfigure], 1, noop);
    sym.wl_proxy_add_listener(this.#xdgSurface, Deno.UnsafePointer.of(this.#surfaceVtable), null);

    // xdg_toplevel listener: event 0 = configure(w:i,h:i,states:a), event 1 = close
    this.#toplevelConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32", "pointer"], result: "void" },
      (_data, _toplevel, width, height, _states) => {
        if (width > 0 && height > 0) {
          this.#width = width;
          this.#height = height;
          this.lib.pushEvent({ type: "resize", width, height });
        }
      },
    );
    this.#toplevelClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      () => {
        this.lib.pushEvent({ type: "close" });
      },
    );
    // xdg_toplevel has 4 events but we only handle the first 2; rest get noop.
    this.#toplevelVtable = makeVtable([this.#toplevelConfigure, this.#toplevelClose], 4, noop);
    sym.wl_proxy_add_listener(this.#xdgToplevel, Deno.UnsafePointer.of(this.#toplevelVtable), null);
  }

  #setTitle(title: string): void {
    const sym = this.lib.wl.symbols;
    const titleBuf = cStr(title);
    sym.wl_proxy_marshal_array_flags(
      this.#xdgToplevel,
      WlOp.XDG_TOPLEVEL_SET_TITLE,
      null,
      sym.wl_proxy_get_version(this.#xdgToplevel),
      0,
      args(BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(titleBuf)))),
    );
  }

  /**
   * Copy an RGBA pixel buffer to the Wayland surface. Converts to ARGB8888
   * (the most widely supported wl_shm format) before blitting.
   */
  blit(rgba: Uint8Array, width: number, height: number): void {
    if (!this.#configured) return; // wait for first configure roundtrip
    const sym = this.lib.wl.symbols;
    const size = width * height * 4;

    // Recreate SHM storage when dimensions change
    if (width !== this.#width || height !== this.#height || this.#shmFd < 0) {
      this.#destroyShmBuffer();
      this.#width = width;
      this.#height = height;
      this.#shmFd = libc.symbols.memfd_create(cStr("winding-shm"), MFD_CLOEXEC);
      if (this.#shmFd < 0) throw new Error("memfd_create failed");
      if (libc.symbols.ftruncate(this.#shmFd, BigInt(size)) !== 0) throw new Error("ftruncate failed");
      const mapped = libc.symbols.mmap(null, BigInt(size), PROT_READ | PROT_WRITE, MAP_SHARED, this.#shmFd, 0n);
      if (!mapped || BigInt(Deno.UnsafePointer.value(mapped)) === MAP_FAILED) throw new Error("mmap failed");
      this.#shmPtr = mapped;
      this.#shmSize = size;

      // Create wl_shm_pool from fd, then a wl_buffer from the pool
      const pool = sym.wl_proxy_marshal_array_flags(
        this.lib.shm!,
        WlOp.SHM_CREATE_POOL,
        Deno.UnsafePointer.create(sym.wl_shm_pool_interface),
        sym.wl_proxy_get_version(this.lib.shm!),
        0,
        args(0n, BigInt(this.#shmFd), BigInt(size)),
      );
      if (!pool) throw new Error("wl_shm_create_pool failed");

      this.#buffer = sym.wl_proxy_marshal_array_flags(
        pool,
        WlOp.SHM_POOL_CREATE_BUFFER,
        Deno.UnsafePointer.create(sym.wl_buffer_interface),
        sym.wl_proxy_get_version(pool),
        0,
        args(0n, 0n, BigInt(width), BigInt(height), BigInt(width * 4), BigInt(WlShmFormat.ARGB8888)),
      );
      sym.wl_proxy_marshal_array_flags(pool, WlOp.SHM_POOL_DESTROY, null, sym.wl_proxy_get_version(pool), 1, args());
      if (!this.#buffer) throw new Error("wl_shm_pool_create_buffer failed");
    }

    // Write pixels: RGBA → ARGB8888 (stored as BGRA in little-endian memory)
    const dest = new Uint8Array(
      new Deno.UnsafePointerView(this.#shmPtr!).getArrayBuffer(size),
    );
    for (let i = 0; i < rgba.length; i += 4) {
      dest[i] = rgba[i + 2]; // B ← src R
      dest[i + 1] = rgba[i + 1]; // G
      dest[i + 2] = rgba[i]; // R ← src B
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
        BigInt(Deno.UnsafePointer.value(this.#buffer!)),
        0n,
        0n,
      ),
    );
    // Use damage_buffer (opcode 9, since wl_surface version ≥ 4) to avoid scaling
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
      libc.symbols.munmap(this.#shmPtr, BigInt(this.#shmSize));
      this.#shmPtr = null;
      this.#shmSize = 0;
    }
    if (this.#shmFd >= 0) {
      libc.symbols.close(this.#shmFd);
      this.#shmFd = -1;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    this.lib.windows.delete(this);
    this.#destroyShmBuffer();
    const sym = this.lib.wl.symbols;
    const f = 1; // WL_MARSHAL_FLAG_DESTROY
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
  readonly wl: Deno.DynamicLibrary<typeof waylandSymbols>;
  readonly display: Deno.PointerObject;
  readonly windows = new Set<WaylandWindow>();
  // Globals bound from registry — set during init roundtrip
  compositor: Deno.PointerObject | null = null;
  shm: Deno.PointerObject | null = null;
  xdgWmBase: Deno.PointerObject | null = null;
  #seat: Deno.PointerObject | null = null;
  #pointer: Deno.PointerObject | null = null;
  #keyboard: Deno.PointerObject | null = null;
  // Event queue filled by listener callbacks, drained by event()
  #events: UIEvent[] = [];
  // Shared no-op callback for unused vtable slots
  readonly noop: Deno.UnsafeCallback;
  // All listeners kept alive to prevent GC
  #listeners: AnyCallback[] = [];
  #vtables: BigUint64Array<ArrayBuffer>[] = [];
  // pollfd buffer for non-blocking display read
  #pollFd = new Uint8Array(8) as Uint8Array<ArrayBuffer>; // struct pollfd {int fd; short events; short revents;}

  constructor() {
    this.wl = Deno.dlopen("libwayland-client.so.0", waylandSymbols);
    const sym = this.wl.symbols;

    const display = sym.wl_display_connect(cStr(""));
    if (!display) throw new Error("Failed to connect to Wayland display");
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

  #initGlobals(): void {
    const sym = this.wl.symbols;

    // Get registry
    const registry = sym.wl_proxy_marshal_array_flags(
      this.display,
      WlOp.DISPLAY_GET_REGISTRY,
      Deno.UnsafePointer.create(sym.wl_registry_interface),
      sym.wl_proxy_get_version(this.display),
      0,
      args(0n),
    );
    if (!registry) throw new Error("Failed to get Wayland registry");

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
      ifacePtr = Deno.UnsafePointer.create(sym.wl_compositor_interface);
      version = Math.min(offered, 4);
    } else if (iface === "wl_shm") {
      ifacePtr = Deno.UnsafePointer.create(sym.wl_shm_interface);
      version = Math.min(offered, 1);
    } else if (iface === "wl_seat") {
      ifacePtr = Deno.UnsafePointer.create(sym.wl_seat_interface);
      version = Math.min(offered, 5);
    } else if (iface === "xdg_wm_base") {
      ifacePtr = xdgWmBaseIface;
      version = Math.min(offered, 7);
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
        BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(ifaceName))),
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
    }
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
      },
    );
    const nameCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      () => {},
    );
    this.#listeners.push(capCb, nameCb);
    const seatVtable = makeVtable([capCb, nameCb], readEventCount(sym.wl_seat_interface), this.noop);
    this.#vtables.push(seatVtable);
    sym.wl_proxy_add_listener(this.#seat, Deno.UnsafePointer.of(seatVtable), null);
    sym.wl_display_roundtrip(this.display);
  }

  #initPointer(): void {
    const sym = this.wl.symbols;
    const pointer = sym.wl_proxy_marshal_array_flags(
      this.#seat!,
      WlOp.SEAT_GET_POINTER,
      Deno.UnsafePointer.create(sym.wl_pointer_interface),
      sym.wl_proxy_get_version(this.#seat!),
      0,
      args(0n),
    );
    if (!pointer) return;
    this.#pointer = pointer;

    // wl_pointer events (indices):
    // 0=enter, 1=leave, 2=motion, 3=button, 4=axis, 5=frame, 6=axis_source, 7=axis_stop, 8=axis_discrete ...
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
    this.#listeners.push(motionCb, buttonCb, axisCb);
    const ptrEventCount = readEventCount(sym.wl_pointer_interface);
    const ptrVtable = makeVtable(
      [null, null, motionCb, buttonCb, axisCb],
      ptrEventCount,
      this.noop,
    );
    this.#vtables.push(ptrVtable);
    sym.wl_proxy_add_listener(pointer, Deno.UnsafePointer.of(ptrVtable), null);
  }

  #initKeyboard(): void {
    const sym = this.wl.symbols;
    const keyboard = sym.wl_proxy_marshal_array_flags(
      this.#seat!,
      WlOp.SEAT_GET_KEYBOARD,
      Deno.UnsafePointer.create(sym.wl_keyboard_interface),
      sym.wl_proxy_get_version(this.#seat!),
      0,
      args(0n),
    );
    if (!keyboard) return;
    this.#keyboard = keyboard;

    // wl_keyboard events: 0=keymap, 1=enter, 2=leave, 3=key, 4=modifiers, 5=repeat_info
    const keyCb = new Deno.UnsafeCallback(
      // (data, keyboard, serial, time, key, state)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      (_data, _kb, _serial, _time, key, state) => {
        this.#events.push({ type: state ? "keydown" : "keyup", keycode: key });
      },
    );
    this.#listeners.push(keyCb);
    const kbEventCount = readEventCount(sym.wl_keyboard_interface);
    const kbVtable = makeVtable([null, null, null, keyCb], kbEventCount, this.noop);
    this.#vtables.push(kbVtable);
    sym.wl_proxy_add_listener(keyboard, Deno.UnsafePointer.of(kbVtable), null);
  }

  /** Called by WaylandWindow to push UI events into the shared queue. */
  pushEvent(event: UIEvent): void {
    this.#events.push(event);
  }

  openWindow(x = 0, y = 0, w = 800, h = 600): WaylandWindow {
    void x;
    void y;
    if (!this.compositor || !this.shm || !this.xdgWmBase) {
      throw new Error("Wayland globals not ready (compositor/shm/xdg_wm_base missing)");
    }
    return new WaylandWindow(this, w, h);
  }

  event(): UIEvent | undefined {
    const sym = this.wl.symbols;
    sym.wl_display_flush(this.display);

    // Non-blocking read: prepare_read → poll fd → read_events or cancel_read
    if (sym.wl_display_prepare_read(this.display) === 0) {
      new DataView(this.#pollFd.buffer).setInt16(6, 0, true); // clear revents
      const ready = libc.symbols.poll(this.#pollFd, 1, 0);
      const revents = new DataView(this.#pollFd.buffer).getInt16(6, true);
      if (ready > 0 && (revents & POLLIN)) {
        sym.wl_display_read_events(this.display);
      } else {
        sym.wl_display_cancel_read(this.display);
      }
    }

    sym.wl_display_dispatch_pending(this.display);
    return this.#events.shift();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    for (const win of this.windows) win.close();
    if (this.#pointer) {
      this.wl.symbols.wl_proxy_marshal_array_flags(this.#pointer, WlOp.POINTER_RELEASE, null, 1, 1, args());
    }
    if (this.#keyboard) {
      this.wl.symbols.wl_proxy_marshal_array_flags(this.#keyboard, WlOp.KEYBOARD_RELEASE, null, 1, 1, args());
    }
    if (this.#seat) {
      this.wl.symbols.wl_proxy_marshal_array_flags(this.#seat, WlOp.SEAT_RELEASE, null, 1, 1, args());
    }
    for (const cb of this.#listeners) cb.close();
    this.noop.close();
    this.wl.symbols.wl_display_disconnect(this.display);
    this.wl.close();
    libc.close();
  }
}

export const load: LoadLibrary = () => new WaylandLibrary();
