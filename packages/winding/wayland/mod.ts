import type { Library, LoadLibrary, MouseButton, PointerModifiers, UIEvent } from "../types.ts";
import { ClickCounter, DeferredNativeError, EventQueue, guardNativeCallback, NativeEventClock } from "../input/mod.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { buildXdgIfaces, libdlSymbols, waylandSymbols, WlCursorShape, WlOp, WlSeatCap, xkbSymbols } from "./ffi.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  createDefaultCursorPixels,
  DEFAULT_CURSOR_HEIGHT,
  DEFAULT_CURSOR_HOTSPOT_X,
  DEFAULT_CURSOR_HOTSPOT_Y,
  DEFAULT_CURSOR_WIDTH,
  dlsymRequired,
  hasFatalPollEvent,
  libcSymbols,
  LIBWAYLAND_CLIENT_SO,
  LIBXKBCOMMON_SO,
  makeVtable,
  pointerCapabilityAction,
  POLLIN,
  POLLOUT,
  readEventCount,
  RTLD_NOLOAD,
  RTLD_NOW,
  throwCleanupErrors,
  waylandConnectionError,
  WL_MARSHAL_FLAG_DESTROY,
} from "./protocol.ts";
import { WaylandWindow } from "./window.ts";
import { WaylandTextInputController } from "./text_input_controller.ts";
import { WaylandKeyboardController } from "./keyboard_controller.ts";
import { WaylandShmBuffer } from "./shm_buffer.ts";

// WaylandLibrary coordinates globals and the extracted native controllers.
class WaylandLibrary implements Library {
  readonly libc: Deno.DynamicLibrary<typeof libcSymbols>;
  readonly libdl: Deno.DynamicLibrary<typeof libdlSymbols>;
  readonly #wlHandle: Deno.PointerObject;
  readonly wl: Deno.DynamicLibrary<typeof waylandSymbols>;
  readonly xkb: Deno.DynamicLibrary<typeof xkbSymbols>;
  readonly #keyboardController: WaylandKeyboardController;
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
    output: Deno.PointerObject;
    seat: Deno.PointerObject;
    pointer: Deno.PointerObject;
    keyboard: Deno.PointerObject;
  };
  readonly windows = new Set<WaylandWindow>();
  readonly #windowsBySurface = new Map<bigint, WaylandWindow>();
  // Globals bound from registry -- set during init roundtrip
  #registry: Deno.PointerObject | null = null;
  compositor: Deno.PointerObject | null = null;
  shm: Deno.PointerObject | null = null;
  xdgWmBase: Deno.PointerObject | null = null;
  #cursorShapeManager: Deno.PointerObject | null = null;
  #cursorShapeDevice: Deno.PointerObject | null = null;
  #coreCursorSurface: Deno.PointerObject | null = null;
  #coreCursorBuffer: Deno.PointerObject | null = null;
  #coreCursorBuffers: WaylandShmBuffer | null = null;
  #coreCursorCommitted = false;
  #coreCursorUnavailable = false;
  #seat: Deno.PointerObject | null = null;
  #pointer: Deno.PointerObject | null = null;
  #pointerFocus: WaylandWindow | null = null;
  #pointerX = 0;
  #pointerY = 0;
  #pointerButtons = 0;
  readonly #pointerClock = new NativeEventClock(2 ** 32);
  readonly #clickCounter = new ClickCounter<MouseButton>();
  #pointerListeners: AnyCallback[] = [];
  #pointerVtable: BigUint64Array<ArrayBuffer> | undefined;
  readonly #textInputController: WaylandTextInputController;
  // Event queue filled by listener callbacks, drained by event()
  readonly #events = new EventQueue<UIEvent>();
  readonly #callbackErrors = new DeferredNativeError();
  // Shared no-op callback for unused vtable slots
  readonly noop: Deno.UnsafeCallback;
  // All listeners kept alive to prevent GC
  #listeners: AnyCallback[] = [];
  #vtables: BigUint64Array<ArrayBuffer>[] = [];
  // pollfd buffer for non-blocking display read
  #pollFd = new Uint8Array(8) as Uint8Array<ArrayBuffer>; // struct pollfd {int fd; short events; short revents;}
  #closed = false;
  #terminalError: Error | null = null;
  #wantsWrite = false;

  constructor() {
    this.libc = Deno.dlopen("libc.so.6", libcSymbols); // needed to perform a few syscalls
    this.libdl = Deno.dlopen("libdl.so.2", libdlSymbols);
    this.wl = Deno.dlopen(LIBWAYLAND_CLIENT_SO, waylandSymbols);
    this.xkb = Deno.dlopen(LIBXKBCOMMON_SO, xkbSymbols);
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
      output: dlsymRequired(this.libdl, wlHandle, "wl_output_interface"),
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
    } = buildXdgIfaces(ifaces.seat, ifaces.surface, ifaces.pointer, ifaces.output);
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
    this.#keyboardController = new WaylandKeyboardController({
      wl: this.wl,
      xkb: this.xkb,
      libc: this.libc,
      keyboardIface: this.ifaces.keyboard,
      noop: this.noop,
      guardCallback: (callback) => this.guardCallback(callback),
      pushEvent: (event) => this.pushEvent(event),
      windowForSurface: (surface) => this.#windowForSurface(surface),
      syncTextInput: (window) => this.#textInputController.syncWindow(window, true),
    });
    this.#textInputController = new WaylandTextInputController({
      wl: this.wl,
      zwpTextInputIface: this.zwpTextInputIface,
      noop: this.noop,
      guardCallback: (callback) => this.guardCallback(callback),
      pushEvent: (event) => this.pushEvent(event),
      windowForSurface: (surface) => this.#windowForSurface(surface),
      keyboardFocus: () => this.#keyboardController.focus,
      windows: () => this.windows,
      resetLocalCompose: () => this.#keyboardController.resetCompose(),
      flushDisplay: (context) => this.flushDisplay(context),
    });

    // Set up pollfd for display fd
    const fd = sym.wl_display_get_fd(display);
    const pollDv = new DataView(this.#pollFd.buffer);
    pollDv.setInt32(0, fd, true); // fd
    pollDv.setInt16(4, POLLIN, true); // events = POLLIN
    // revents at offset 6 is zeroed by default

    this.#initGlobals();
    this.#initSeat();
    this.#callbackErrors.throwIfPending();
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
    this.#registry = registry;

    // Registry global callback: bind compositor, shm, seat, xdg_wm_base
    const globalCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, reg, name, ifacePtr, version) => {
        if (!ifacePtr || !reg) return;
        const iface = new Deno.UnsafePointerView(ifacePtr).getCString();
        this.#bindGlobal(reg, name, iface, version);
      }),
    );
    const globalRemoveCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.guardCallback(() => {}),
    );
    this.#listeners.push(globalCb, globalRemoveCb);

    const regVtable = makeVtable([globalCb, globalRemoveCb], 2, this.noop);
    this.#vtables.push(regVtable);
    sym.wl_proxy_add_listener(registry, Deno.UnsafePointer.of(regVtable), null);

    this.roundtripDisplay("registry initialization");
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
      this.#ensureCursorShapeDevice();
    } else if (iface === "zwp_text_input_manager_v3") {
      this.#textInputController.bindManager(proxy);
    }
  }

  #setDefaultCursor(serial: number): void {
    const sym = this.wl.symbols;
    if (this.#cursorShapeDevice) {
      sym.wl_proxy_marshal_array_flags(
        this.#cursorShapeDevice,
        WlOp.WP_CURSOR_SHAPE_DEVICE_SET_SHAPE,
        null,
        sym.wl_proxy_get_version(this.#cursorShapeDevice),
        0,
        args(BigInt(serial), BigInt(WlCursorShape.DEFAULT)),
      );
      return;
    }

    if (!this.#pointer || !this.#ensureCoreCursor()) return;
    const pointer = this.#pointer;
    const cursorSurface = this.#coreCursorSurface;
    const cursorBuffer = this.#coreCursorBuffer;
    if (!pointer || !cursorSurface || !cursorBuffer) return;
    sym.wl_proxy_marshal_array_flags(
      pointer,
      WlOp.POINTER_SET_CURSOR,
      null,
      sym.wl_proxy_get_version(pointer),
      0,
      args(
        BigInt(serial),
        Deno.UnsafePointer.value(cursorSurface),
        BigInt(DEFAULT_CURSOR_HOTSPOT_X),
        BigInt(DEFAULT_CURSOR_HOTSPOT_Y),
      ),
    );
    if (this.#coreCursorCommitted) return;
    const surfaceVersion = sym.wl_proxy_get_version(cursorSurface);
    sym.wl_proxy_marshal_array_flags(
      cursorSurface,
      WlOp.SURFACE_ATTACH,
      null,
      surfaceVersion,
      0,
      args(Deno.UnsafePointer.value(cursorBuffer), 0n, 0n),
    );
    sym.wl_proxy_marshal_array_flags(
      cursorSurface,
      WlOp.SURFACE_DAMAGE,
      null,
      surfaceVersion,
      0,
      args(0n, 0n, BigInt(DEFAULT_CURSOR_WIDTH), BigInt(DEFAULT_CURSOR_HEIGHT)),
    );
    sym.wl_proxy_marshal_array_flags(
      cursorSurface,
      WlOp.SURFACE_COMMIT,
      null,
      surfaceVersion,
      0,
      args(),
    );
    this.#coreCursorCommitted = true;
  }

  #ensureCoreCursor(): boolean {
    if (this.#coreCursorSurface && this.#coreCursorBuffer) return true;
    if (this.#coreCursorUnavailable || !this.compositor || !this.shm) return false;
    const symbols = this.wl.symbols;
    let surface: Deno.PointerObject | null = null;
    let buffers: WaylandShmBuffer | null = null;
    try {
      surface = symbols.wl_proxy_marshal_array_flags(
        this.compositor,
        WlOp.COMPOSITOR_CREATE_SURFACE,
        this.ifaces.surface,
        symbols.wl_proxy_get_version(this.compositor),
        0,
        args(0n),
      );
      if (!surface) throw new Error("winding failed to create the Wayland cursor surface");
      buffers = new WaylandShmBuffer(this);
      const buffer = buffers.write(
        createDefaultCursorPixels(),
        DEFAULT_CURSOR_WIDTH,
        DEFAULT_CURSOR_HEIGHT,
      );
      if (!buffer) throw new Error("winding failed to allocate the Wayland cursor buffer");
      this.#coreCursorSurface = surface;
      this.#coreCursorBuffer = buffer;
      this.#coreCursorBuffers = buffers;
      return true;
    } catch {
      if (surface) {
        try {
          symbols.wl_proxy_marshal_array_flags(
            surface,
            WlOp.SURFACE_DESTROY,
            null,
            symbols.wl_proxy_get_version(surface),
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        } catch {
          // Cursor fallback is best-effort.
        }
      }
      try {
        buffers?.close();
      } catch {
        // Cursor fallback is best-effort.
      }
      this.#coreCursorUnavailable = true;
      return false;
    }
  }

  #ensureCursorShapeDevice(): void {
    if (!this.#cursorShapeManager || !this.#pointer || this.#cursorShapeDevice) return;
    const symbols = this.wl.symbols;
    this.#cursorShapeDevice = symbols.wl_proxy_marshal_array_flags(
      this.#cursorShapeManager,
      WlOp.WP_CURSOR_SHAPE_MANAGER_GET_POINTER,
      this.wpCursorShapeDeviceIface,
      symbols.wl_proxy_get_version(this.#cursorShapeManager),
      0,
      args(0n, Deno.UnsafePointer.value(this.#pointer)),
    );
  }

  #setupXdgWmBaseListener(wmBase: Deno.PointerObject): void {
    const sym = this.wl.symbols;
    const pingCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, wmb, serial) => {
        // Respond to ping to avoid being killed for being unresponsive
        sym.wl_proxy_marshal_array_flags(
          wmb!,
          WlOp.XDG_WM_BASE_PONG,
          null,
          sym.wl_proxy_get_version(wmb!),
          0,
          args(BigInt(serial)),
        );
      }),
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
      this.guardCallback((_data, _seat, caps) => {
        const pointerAction = pointerCapabilityAction(
          (caps & WlSeatCap.POINTER) !== 0,
          this.#pointer !== null,
        );
        if (pointerAction === "acquire") this.#initPointer();
        else if (pointerAction === "release") this.#releasePointer(true);
        if ((caps & WlSeatCap.KEYBOARD) && !this.#keyboardController.active) {
          this.#keyboardController.acquire(this.#seat!);
        }
        if (!(caps & WlSeatCap.KEYBOARD) && this.#keyboardController.active) {
          this.#keyboardController.release();
        }
      }),
    );
    const nameCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.guardCallback(() => {}),
    );
    this.#listeners.push(capCb, nameCb);
    const seatVtable = makeVtable(
      [capCb, nameCb],
      readEventCount(Deno.UnsafePointer.value(this.ifaces.seat)),
      this.noop,
    );
    this.#vtables.push(seatVtable);
    sym.wl_proxy_add_listener(this.#seat, Deno.UnsafePointer.of(seatVtable), null);
    this.#textInputController.setSeat(this.#seat);
    this.roundtripDisplay("seat initialization");
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

    this.#ensureCursorShapeDevice();

    // wl_pointer events (indices):
    // 0=enter, 1=leave, 2=motion, 3=button, 4=axis, 5=frame, 6=axis_source, 7=axis_stop, 8=axis_discrete ...
    const enterCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "pointer", "i32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, serial, surface, xFixed, yFixed) => {
        const window = this.#windowForSurface(surface);
        if (!window) return;
        this.#pointerFocus = window;
        this.#pointerX = xFixed / 256;
        this.#pointerY = yFixed / 256;
        this.#setDefaultCursor(serial);
        this.#events.push({ type: "mouseenter", ...this.#pointerSnapshot(), window });
      }),
    );
    const leaveCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface)
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      this.guardCallback((_data, _ptr, _serial, surface) => {
        const window = this.#windowForSurface(surface);
        if (!window || window !== this.#pointerFocus) return;
        this.#pointerFocus = null;
        this.#events.push({ type: "mouseleave", ...this.#pointerSnapshot(), window });
      }),
    );
    const motionCb = new Deno.UnsafeCallback(
      // (data, pointer, time, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "i32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, time, xFixed, yFixed) => {
        const window = this.#pointerFocus;
        if (!window) return;
        this.#pointerX = xFixed / 256;
        this.#pointerY = yFixed / 256;
        this.#events.push({ type: "mousemove", ...this.#pointerSnapshot(time), window });
      }),
    );
    const buttonCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, time, button, state)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      this.guardCallback((_data, _ptr, _serial, time, button, state) => {
        const window = this.#pointerFocus;
        if (!window) return;
        const btnMap: Record<number, MouseButton> = {
          0x110: "left",
          0x111: "right",
          0x112: "middle",
          0x113: "back",
          0x114: "forward",
          0x115: "forward",
          0x116: "back",
        };
        const b = btnMap[button];
        if (b === undefined) return;
        const mask = mouseButtonMask(b);
        this.#pointerButtons = state ? this.#pointerButtons | mask : this.#pointerButtons & ~mask;
        const pointer = this.#pointerSnapshot(time);
        this.#events.push({
          type: state ? "mousedown" : "mouseup",
          button: b,
          detail: this.#clickCounter.detail(b, state !== 0, pointer.timeStamp, pointer.x, pointer.y),
          ...pointer,
          window,
        });
      }),
    );
    const axisCb = new Deno.UnsafeCallback(
      // (data, pointer, time, axis, value_fixed)
      { parameters: ["pointer", "pointer", "u32", "u32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, time, axis, value) => {
        const window = this.#pointerFocus;
        if (!window) return;
        const delta = value >> 8;
        if (axis === 0) {
          this.#events.push({
            type: "wheel",
            deltaX: 0,
            deltaY: delta,
            deltaMode: 0,
            ...this.#pointerSnapshot(time),
            window,
          });
        } else if (axis === 1) {
          this.#events.push({
            type: "wheel",
            deltaX: delta,
            deltaY: 0,
            deltaMode: 0,
            ...this.#pointerSnapshot(time),
            window,
          });
        }
      }),
    );
    this.#pointerListeners = [enterCb, leaveCb, motionCb, buttonCb, axisCb];
    const ptrEventCount = readEventCount(Deno.UnsafePointer.value(this.ifaces.pointer));
    const pointerVtable = makeVtable(
      this.#pointerListeners,
      ptrEventCount,
      this.noop,
    );
    this.#pointerVtable = pointerVtable;
    sym.wl_proxy_add_listener(pointer, Deno.UnsafePointer.of(pointerVtable), null);
  }

  #releasePointer(emitLeave: boolean): void {
    const focusedWindow = this.#pointerFocus;
    const cursorShapeDevice = this.#cursorShapeDevice;
    const pointer = this.#pointer;
    const listeners = this.#pointerListeners;
    this.#pointerFocus = null;
    this.#cursorShapeDevice = null;
    this.#pointer = null;
    this.#pointerButtons = 0;
    this.#pointerListeners = [];
    this.#pointerVtable = undefined;

    if (emitLeave && focusedWindow) {
      this.#events.push({ type: "mouseleave", ...this.#pointerSnapshot(), window: focusedWindow });
    }

    const errors: unknown[] = [];
    if (cursorShapeDevice) {
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          cursorShapeDevice,
          WlOp.WP_CURSOR_SHAPE_DEVICE_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    if (pointer) {
      collectCleanupError(errors, () => {
        const version = this.wl.symbols.wl_proxy_get_version(pointer);
        if (version >= 3) {
          this.wl.symbols.wl_proxy_marshal_array_flags(
            pointer,
            WlOp.POINTER_RELEASE,
            null,
            version,
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        } else {
          this.wl.symbols.wl_proxy_destroy(pointer);
        }
      });
    }
    for (const listener of listeners) {
      collectCleanupError(errors, () => listener.close());
    }
    throwCleanupErrors("winding failed to release Wayland pointer", errors);
  }

  #pointerSnapshot(time?: number): {
    x: number;
    y: number;
    buttons: number;
    timeStamp: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  } {
    return {
      x: this.#pointerX,
      y: this.#pointerY,
      buttons: this.#pointerButtons,
      timeStamp: time === undefined ? performance.now() : this.#pointerClock.timeStamp(time),
      ...pointerModifiers(this.#keyboardController.modifiers),
    };
  }

  #windowForSurface(surface: Deno.PointerValue): WaylandWindow | null {
    return surface ? this.#windowsBySurface.get(Deno.UnsafePointer.value(surface)) ?? null : null;
  }

  registerWindow(surface: Deno.PointerObject, window: WaylandWindow): void {
    this.#windowsBySurface.set(Deno.UnsafePointer.value(surface), window);
    this.windows.add(window);
    this.#textInputController.registerWindow(window);
  }

  unregisterWindow(surface: Deno.PointerObject, window: WaylandWindow): void {
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.#textInputController.removeWindow(window));
    collectCleanupError(errors, () => this.#keyboardController.removeWindow(window));
    if (this.#pointerFocus === window) this.#pointerFocus = null;
    const key = Deno.UnsafePointer.value(surface);
    if (this.#windowsBySurface.get(key) === window) this.#windowsBySurface.delete(key);
    this.windows.delete(window);
    this.#events.purgeWindow(window);
    throwCleanupErrors("winding failed to unregister Wayland window", errors);
  }

  updateWindowImeState(window: WaylandWindow): void {
    this.#textInputController.syncWindow(window, true);
  }

  updateWindowImeCursorArea(window: WaylandWindow): void {
    this.#textInputController.updateCursorArea(window);
  }

  updateWindowImeSurroundingText(window: WaylandWindow): void {
    this.#textInputController.updateSurroundingText(window);
  }

  /** Called by WaylandWindow to push UI events into the shared queue. */
  pushEvent(event: UIEvent): void {
    this.#events.push(event);
  }

  guardCallback<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
  ): (...args: Arguments) => void {
    return guardNativeCallback(this.#callbackErrors, callback, () => {});
  }

  throwCallbackError(): void {
    this.#callbackErrors.throwIfPending();
  }

  throwIfConnectionFailed(): void {
    if (this.#terminalError) throw this.#terminalError;
  }

  roundtripDisplay(context: string): void {
    this.throwIfConnectionFailed();
    if (this.wl.symbols.wl_display_roundtrip(this.display) < 0) {
      this.#failConnection(context);
    }
    this.#callbackErrors.throwIfPending();
  }

  flushDisplay(context: string): void {
    this.throwIfConnectionFailed();
    const result = this.wl.symbols.wl_display_flush(this.display);
    if (result >= 0) {
      this.#wantsWrite = false;
      return;
    }
    // libwayland reports EAGAIN from flush without making the display fatal.
    // A zero display error therefore means the pending bytes need POLLOUT.
    if (this.wl.symbols.wl_display_get_error(this.display) === 0) {
      this.#wantsWrite = true;
      return;
    }
    this.#failConnection(context);
  }

  openWindow(_x = 0, _y = 0, w = 800, h = 600): WaylandWindow {
    this.throwIfConnectionFailed();
    if (this.#closed) throw new Error("winding Wayland library is closed");
    if (!this.compositor || !this.shm || !this.xdgWmBase) {
      throw new Error("winding wayland globals not ready (compositor/shm/xdg_wm_base missing)");
    }
    return new WaylandWindow(this, w, h);
  }

  event(): UIEvent | undefined {
    this.throwIfConnectionFailed();
    if (this.#closed) return undefined;
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;
    this.#callbackErrors.throwIfPending();
    const sym = this.wl.symbols;
    this.flushDisplay("event flush");

    // Non-blocking read: prepare_read -> poll fd -> read_events or cancel_read
    if (sym.wl_display_prepare_read(this.display) === 0) {
      const pollView = new DataView(this.#pollFd.buffer);
      pollView.setInt16(4, POLLIN | (this.#wantsWrite ? POLLOUT : 0), true);
      pollView.setInt16(6, 0, true); // clear revents
      const ready = this.libc.symbols.poll(this.#pollFd, 1, 0);
      const revents = pollView.getInt16(6, true);
      if (ready < 0) {
        sym.wl_display_cancel_read(this.display);
        this.#failConnection("polling the display socket");
      }
      if (hasFatalPollEvent(revents)) {
        sym.wl_display_cancel_read(this.display);
        this.#failConnection("display socket readiness");
      }
      if (ready > 0 && (revents & POLLIN)) {
        if (sym.wl_display_read_events(this.display) < 0) {
          this.#failConnection("reading display events");
        }
      } else {
        sym.wl_display_cancel_read(this.display);
      }
      if (ready > 0 && (revents & POLLOUT)) this.flushDisplay("draining display requests");
    }

    if (sym.wl_display_dispatch_pending(this.display) < 0) {
      this.#failConnection("dispatching display events");
    }
    this.#keyboardController.enqueueDueRepeat();
    const dispatched = this.#events.shift();
    if (dispatched !== undefined) return dispatched;
    this.#callbackErrors.throwIfPending();
    return undefined;
  }

  #failConnection(context: string): never {
    if (this.#terminalError) throw this.#terminalError;
    const symbols = this.wl.symbols;
    const displayError = symbols.wl_display_get_error(this.display);
    const interfacePointer = new BigUint64Array(1);
    const objectId = new Uint32Array(1);
    const protocolCode = symbols.wl_display_get_protocol_error(
      this.display,
      interfacePointer,
      objectId,
    );
    let interfaceName: string | undefined;
    if (interfacePointer[0] !== 0n) {
      const iface = Deno.UnsafePointer.create(interfacePointer[0]);
      if (iface) {
        const nameAddress = new Deno.UnsafePointerView(iface).getBigUint64(0);
        const name = Deno.UnsafePointer.create(nameAddress);
        if (name) interfaceName = new Deno.UnsafePointerView(name).getCString();
      }
    }
    const error = waylandConnectionError(
      context,
      displayError,
      interfaceName,
      objectId[0],
      protocolCode,
    );
    this.#terminalError = error;
    try {
      this.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "winding closed after a fatal Wayland connection error");
    }
    throw error;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
    const errors: unknown[] = [];

    for (const window of [...this.windows]) {
      collectCleanupError(errors, () => window.close());
    }
    this.windows.clear();
    this.#windowsBySurface.clear();
    collectCleanupError(errors, () => this.#textInputController.close());

    collectCleanupError(errors, () => this.#releasePointer(false));

    const coreCursorSurface = this.#coreCursorSurface;
    this.#coreCursorSurface = null;
    this.#coreCursorBuffer = null;
    this.#coreCursorCommitted = false;
    if (coreCursorSurface) {
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          coreCursorSurface,
          WlOp.SURFACE_DESTROY,
          null,
          this.wl.symbols.wl_proxy_get_version(coreCursorSurface),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    const coreCursorBuffers = this.#coreCursorBuffers;
    this.#coreCursorBuffers = null;
    if (coreCursorBuffers) collectCleanupError(errors, () => coreCursorBuffers.close());

    const cursorShapeManager = this.#cursorShapeManager;
    this.#cursorShapeManager = null;
    if (cursorShapeManager) {
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          cursorShapeManager,
          WlOp.WP_CURSOR_SHAPE_MANAGER_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }

    collectCleanupError(errors, () => this.#keyboardController.close());

    const seat = this.#seat;
    this.#seat = null;
    if (seat) {
      collectCleanupError(errors, () => {
        const version = this.wl.symbols.wl_proxy_get_version(seat);
        if (version >= 5) {
          this.wl.symbols.wl_proxy_marshal_array_flags(
            seat,
            WlOp.SEAT_RELEASE,
            null,
            version,
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        } else {
          this.wl.symbols.wl_proxy_destroy(seat);
        }
      });
    }

    const xdgWmBase = this.xdgWmBase;
    this.xdgWmBase = null;
    if (xdgWmBase) {
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          xdgWmBase,
          WlOp.XDG_WM_BASE_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }

    for (const proxy of [this.compositor, this.shm, this.#registry]) {
      if (proxy) collectCleanupError(errors, () => this.wl.symbols.wl_proxy_destroy(proxy));
    }
    this.compositor = null;
    this.shm = null;
    this.#registry = null;

    for (const callback of this.#listeners) {
      collectCleanupError(errors, () => callback.close());
    }
    this.#listeners = [];
    this.#vtables = [];
    collectCleanupError(errors, () => this.noop.close());
    collectCleanupError(errors, () => this.xkb.close());
    collectCleanupError(errors, () => this.wl.symbols.wl_display_disconnect(this.display));
    collectCleanupError(errors, () => this.wl.close());
    collectCleanupError(errors, () => {
      if (this.libdl.symbols.dlclose(this.#wlHandle) !== 0) {
        throw new Error("winding failed to close Wayland loader handle");
      }
    });
    collectCleanupError(errors, () => this.libdl.close());
    collectCleanupError(errors, () => this.libc.close());
    collectCleanupError(errors, () => this.#callbackErrors.throwIfPending());
    throwCleanupErrors("winding failed to close Wayland library", errors);
  }
}

function pointerModifiers(modifiers: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): PointerModifiers {
  return {
    shiftKey: modifiers.shiftKey,
    ctrlKey: modifiers.ctrlKey,
    altKey: modifiers.altKey,
    metaKey: modifiers.metaKey,
  };
}

function mouseButtonMask(button: MouseButton): number {
  return button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : button === "back" ? 8 : 16;
}

export const load: LoadLibrary = () => new WaylandLibrary();
