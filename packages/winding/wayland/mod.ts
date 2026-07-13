import type { Library, LoadLibrary, MouseButton, PointerModifiers, UIEvent } from "../types.ts";
import { ClickCounter, DeferredNativeError, EventQueue, guardNativeCallback, NativeEventClock } from "../input/mod.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { buildXdgIfaces, libdlSymbols, waylandSymbols, WlCursorShape, WlOp, WlSeatCap, xkbSymbols } from "./ffi.ts";
import {
  type AnyCallback,
  args,
  clampWaylandBindVersion,
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
  NativeInitializationCleanup,
  OUTPUT_EVENT_SIGNATURES,
  POINTER_EVENT_SIGNATURES,
  pointerCapabilityAction,
  POLLIN,
  POLLOUT,
  readWaylandInterfaceVersion,
  REGISTRY_EVENT_SIGNATURES,
  RTLD_NOLOAD,
  RTLD_NOW,
  SEAT_EVENT_SIGNATURES,
  SHM_EVENT_SIGNATURES,
  throwCleanupErrors,
  waylandConnectionError,
  WaylandNoopCallbacks,
  WL_MARSHAL_FLAG_DESTROY,
  XDG_WM_BASE_EVENT_SIGNATURES,
} from "./protocol.ts";
import { WaylandWindow } from "./window.ts";
import { WaylandTextInputController } from "./text_input_controller.ts";
import { WaylandKeyboardController } from "./keyboard_controller.ts";
import {
  releaseWaylandShmRootsAfterDisconnect,
  type WaylandShmAttachment,
  WaylandShmAttachmentTransaction,
  WaylandShmBuffer,
} from "./shm_buffer.ts";
import { type WaylandShmFormatGeneration, WaylandShmFormatState } from "./shm_format.ts";
import {
  type BoundWaylandGlobal,
  isWaylandGlobalInterface,
  type WaylandGlobalOffer,
  WaylandGlobalRegistry,
} from "./global_registry.ts";
import { WaylandPointerFrameAccumulator, WaylandPointerPosition, waylandPointerScreenPosition } from "./pointer.ts";
import { type WaylandDecorationManagerBinding, WaylandDecorationManagerState } from "./decoration.ts";
import { type WaylandFractionalScaleManagerPair, WaylandFractionalScaleManagerState } from "./fractional_scale.ts";
import { WaylandPostDispatchQueue } from "./frame_pacing.ts";
import {
  outputReleaseStrategy,
  type WaylandOutputBinding,
  type WaylandOutputGeneration,
  WaylandOutputRegistry,
  type WaylandOutputScaleSnapshot,
  WaylandOutputScaleState,
} from "./output.ts";

const LIBC_SO = "libc.so.6";
const LIBDL_SO = "libdl.so.2";

export type RequiredWaylandDependency = "libc" | "libdl" | "wayland-client" | "xkbcommon";

const WAYLAND_DEPENDENCY_ERRORS: Readonly<Record<RequiredWaylandDependency, string>> = {
  libc: `winding Wayland requires glibc ${LIBC_SO} with memfd_create because ` +
    "Deno.dlopen resolves the whole libc FFI symbol descriptor",
  libdl: `winding Wayland requires glibc ${LIBDL_SO}`,
  "wayland-client": `winding Wayland requires ${LIBWAYLAND_CLIENT_SO}`,
  xkbcommon: `winding Wayland requires ${LIBXKBCOMMON_SO}`,
};

export function openRequiredWaylandDependency<Value>(
  dependency: RequiredWaylandDependency,
  open: () => Value,
): Value {
  try {
    return open();
  } catch (cause) {
    throw new Error(WAYLAND_DEPENDENCY_ERRORS[dependency], { cause });
  }
}

interface NativeWaylandOutput {
  readonly proxy: Deno.PointerObject;
  readonly version: number;
  readonly generation: WaylandOutputGeneration;
  readonly scale: WaylandOutputScaleState;
  readonly callbacks: readonly AnyCallback[];
  readonly vtable: BigUint64Array<ArrayBuffer>;
}

// WaylandLibrary coordinates globals and the extracted native controllers.
class WaylandLibrary implements Library {
  // Construction either initializes every asserted field or unwinds and throws.
  readonly libc!: Deno.DynamicLibrary<typeof libcSymbols>;
  readonly libdl!: Deno.DynamicLibrary<typeof libdlSymbols>;
  readonly #wlHandle!: Deno.PointerObject;
  readonly wl!: Deno.DynamicLibrary<typeof waylandSymbols>;
  readonly xkb!: Deno.DynamicLibrary<typeof xkbSymbols>;
  readonly #keyboardController!: WaylandKeyboardController;
  readonly display!: Deno.PointerObject;
  // XDG interface structs -- built lazily in the constructor, mem kept alive to
  // prevent the pinned buffer from being GC'd.
  readonly #xdgMem!: Uint8Array<ArrayBuffer>;
  readonly xdgWmBaseIface!: Deno.PointerObject;
  readonly xdgSurfaceIface!: Deno.PointerObject;
  readonly xdgToplevelIface!: Deno.PointerObject;
  readonly wpCursorShapeManagerIface!: Deno.PointerObject;
  readonly wpCursorShapeDeviceIface!: Deno.PointerObject;
  readonly zxdgDecorationManagerIface!: Deno.PointerObject;
  readonly zxdgToplevelDecorationIface!: Deno.PointerObject;
  readonly wpFractionalScaleManagerIface!: Deno.PointerObject;
  readonly wpFractionalScaleIface!: Deno.PointerObject;
  readonly wpViewporterIface!: Deno.PointerObject;
  readonly wpViewportIface!: Deno.PointerObject;
  readonly zwpTextInputManagerIface!: Deno.PointerObject;
  readonly zwpTextInputIface!: Deno.PointerObject;
  readonly ifaces!: {
    registry: Deno.PointerObject;
    compositor: Deno.PointerObject;
    shm: Deno.PointerObject;
    shmPool: Deno.PointerObject;
    buffer: Deno.PointerObject;
    callback: Deno.PointerObject;
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
  readonly #shmFormats = new WaylandShmFormatState();
  #shmFormatGeneration: WaylandShmFormatGeneration | undefined;
  #shmFormatListener: AnyCallback | null = null;
  #shmFormatVtable: BigUint64Array<ArrayBuffer> | undefined;
  xdgWmBase: Deno.PointerObject | null = null;
  readonly #decorationManagers = new WaylandDecorationManagerState<Deno.PointerObject>();
  readonly #fractionalScaleManagers = new WaylandFractionalScaleManagerState<Deno.PointerObject>();
  #cursorShapeManager: Deno.PointerObject | null = null;
  #cursorShapeDevice: Deno.PointerObject | null = null;
  #coreCursorSurface: Deno.PointerObject | null = null;
  #coreCursorAttachment: WaylandShmAttachment | null = null;
  #coreCursorBuffers: WaylandShmBuffer | null = null;
  #coreCursorCommitted = false;
  #coreCursorUnavailable = false;
  #seat: Deno.PointerObject | null = null;
  #seatListeners: AnyCallback[] = [];
  #seatVtable: BigUint64Array<ArrayBuffer> | undefined;
  #pointer: Deno.PointerObject | null = null;
  #pointerFocus: WaylandWindow | null = null;
  readonly #pointerPosition = new WaylandPointerPosition();
  readonly #pointerFrame = new WaylandPointerFrameAccumulator();
  #pointerButtons = 0;
  readonly #pointerClock = new NativeEventClock(2 ** 32);
  readonly #clickCounter = new ClickCounter<MouseButton>();
  #pointerListeners: AnyCallback[] = [];
  #pointerVtable: BigUint64Array<ArrayBuffer> | undefined;
  readonly #textInputController!: WaylandTextInputController;
  readonly #globals!: WaylandGlobalRegistry<Deno.PointerObject>;
  readonly #outputs!: WaylandOutputRegistry<NativeWaylandOutput>;
  readonly #outputsByProxy = new Map<bigint, NativeWaylandOutput>();
  #xdgWmBaseListener: AnyCallback | null = null;
  #xdgWmBaseVtable: BigUint64Array<ArrayBuffer> | undefined;
  // Event queue filled by listener callbacks, drained by event()
  readonly #events = new EventQueue<UIEvent>();
  readonly #callbackErrors = new DeferredNativeError();
  readonly noops!: WaylandNoopCallbacks;
  // All listeners kept alive to prevent GC
  #listeners: AnyCallback[] = [];
  #vtables: BigUint64Array<ArrayBuffer>[] = [];
  readonly #retainedCallbackRoots = new Set<AnyCallback>();
  readonly #retainedNativeResourceRoots = new Set<object>();
  readonly #retainedNativeDisconnectCleanups = new Set<() => void>();
  readonly #afterNativeCallbacks = new WaylandPostDispatchQueue();
  // pollfd buffer for non-blocking display read
  #pollFd = new Uint8Array(8) as Uint8Array<ArrayBuffer>; // struct pollfd {int fd; short events; short revents;}
  #initialized = false;
  #closed = false;
  #terminalError: Error | null = null;
  #wantsWrite = false;

  constructor() {
    const cleanup = new NativeInitializationCleanup();
    try {
      this.libc = openRequiredWaylandDependency("libc", () => Deno.dlopen(LIBC_SO, libcSymbols));
      cleanup.defer(() => this.libc.close());
      this.libdl = openRequiredWaylandDependency("libdl", () => Deno.dlopen(LIBDL_SO, libdlSymbols));
      cleanup.defer(() => this.libdl.close());
      this.wl = openRequiredWaylandDependency(
        "wayland-client",
        () => Deno.dlopen(LIBWAYLAND_CLIENT_SO, waylandSymbols),
      );
      cleanup.defer(() => this.wl.close());
      this.xkb = openRequiredWaylandDependency(
        "xkbcommon",
        () => Deno.dlopen(LIBXKBCOMMON_SO, xkbSymbols),
      );
      cleanup.defer(() => this.xkb.close());
      // Retrieve an existing loader handle for dlsym without loading a second time.
      const wlHandle = this.libdl.symbols.dlopen(cStr(LIBWAYLAND_CLIENT_SO), RTLD_NOW | RTLD_NOLOAD);
      if (!wlHandle) throw new Error(`winding failed to get existing ${LIBWAYLAND_CLIENT_SO} handle via libdl`);
      this.#wlHandle = wlHandle;
      cleanup.defer(() => {
        if (this.libdl.symbols.dlclose(wlHandle) !== 0) {
          throw new Error("winding failed to close Wayland loader handle during initialization unwind");
        }
      });
      const ifaces = {
        registry: dlsymRequired(this.libdl, wlHandle, "wl_registry_interface"),
        compositor: dlsymRequired(this.libdl, wlHandle, "wl_compositor_interface"),
        shm: dlsymRequired(this.libdl, wlHandle, "wl_shm_interface"),
        shmPool: dlsymRequired(this.libdl, wlHandle, "wl_shm_pool_interface"),
        buffer: dlsymRequired(this.libdl, wlHandle, "wl_buffer_interface"),
        callback: dlsymRequired(this.libdl, wlHandle, "wl_callback_interface"),
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
        zxdgDecorationManagerIface,
        zxdgToplevelDecorationIface,
        wpFractionalScaleManagerIface,
        wpFractionalScaleIface,
        wpViewporterIface,
        wpViewportIface,
        zwpTextInputManagerIface,
        zwpTextInputIface,
      } = buildXdgIfaces(ifaces.seat, ifaces.surface, ifaces.pointer, ifaces.output);
      this.#xdgMem = mem;
      this.xdgWmBaseIface = xdgWmBaseIface;
      this.xdgSurfaceIface = xdgSurfaceIface;
      this.xdgToplevelIface = xdgToplevelIface;
      this.wpCursorShapeManagerIface = wpCursorShapeManagerIface;
      this.wpCursorShapeDeviceIface = wpCursorShapeDeviceIface;
      this.zxdgDecorationManagerIface = zxdgDecorationManagerIface;
      this.zxdgToplevelDecorationIface = zxdgToplevelDecorationIface;
      this.wpFractionalScaleManagerIface = wpFractionalScaleManagerIface;
      this.wpFractionalScaleIface = wpFractionalScaleIface;
      this.wpViewporterIface = wpViewporterIface;
      this.wpViewportIface = wpViewportIface;
      this.zwpTextInputManagerIface = zwpTextInputManagerIface;
      this.zwpTextInputIface = zwpTextInputIface;
      this.ifaces = ifaces;
      const sym = this.wl.symbols;

      // NULL asks libwayland to use the default display from the environment.
      const display = sym.wl_display_connect(null);
      if (!display) throw new Error("winding failed to connect to Wayland display");
      this.display = display;
      cleanup.defer(() => this.wl.symbols.wl_display_disconnect(display));

      this.noops = new WaylandNoopCallbacks();
      cleanup.defer(() => this.noops.close());
      this.#keyboardController = new WaylandKeyboardController({
        wl: this.wl,
        xkb: this.xkb,
        libc: this.libc,
        keyboardIface: this.ifaces.keyboard,
        noops: this.noops,
        guardCallback: (callback) => this.guardCallback(callback),
        pushEvent: (event) => this.pushEvent(event),
        windowForSurface: (surface) => this.#windowForSurface(surface),
        syncTextInput: (window) => this.#textInputController.syncWindow(window, true),
      });
      cleanup.defer(() => this.#keyboardController.close());
      this.#textInputController = new WaylandTextInputController({
        wl: this.wl,
        zwpTextInputIface: this.zwpTextInputIface,
        noops: this.noops,
        guardCallback: (callback) => this.guardCallback(callback),
        pushEvent: (event) => this.pushEvent(event),
        windowForSurface: (surface) => this.#windowForSurface(surface),
        keyboardFocus: () => this.#keyboardController.focus,
        windows: () => this.windows,
        resetLocalCompose: () => this.#keyboardController.resetCompose(),
        flushDisplay: (context) => this.flushDisplay(context),
      });
      cleanup.defer(() => this.#textInputController.close());
      this.#globals = new WaylandGlobalRegistry(
        (offer) => this.#bindGlobal(offer),
        (global) => this.#releaseGlobal(global),
      );
      this.#outputs = new WaylandOutputRegistry(
        (name, offeredVersion) => this.#bindOutput(name, offeredVersion),
        (output) => this.#releaseOutput(output),
      );
      cleanup.defer(() => this.#closeProtocolInitialization());

      // Set up pollfd for display fd
      const fd = sym.wl_display_get_fd(display);
      const pollDv = new DataView(this.#pollFd.buffer);
      pollDv.setInt32(0, fd, true); // fd
      pollDv.setInt16(4, POLLIN, true); // events = POLLIN
      // revents at offset 6 is zeroed by default

      this.#initGlobals();
      // Global events can bind objects while the registry roundtrip is already dispatching. A second
      // roundtrip makes those objects' seat-capability and SHM-format events available before return.
      if (this.#seat || this.shm) this.roundtripDisplay("bound global initialization");
      this.#callbackErrors.throwIfPending();
      if (this.shm) this.requireArgb8888ShmFormat();
      this.#initialized = true;
    } catch (error) {
      this.#closed = true;
      this.#events.close();
      cleanup.fail(error, "winding failed to initialize Wayland library");
    }
  }

  get decorationManager(): WaylandDecorationManagerBinding<Deno.PointerObject> | undefined {
    return this.#decorationManagers.current;
  }

  get fractionalScaleManagers(): WaylandFractionalScaleManagerPair<Deno.PointerObject> | undefined {
    return this.#fractionalScaleManagers.current;
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

    // Registry callbacks retain each advertised name so removals and replacements can be
    // correlated with the exact proxy that owns listeners and child input objects.
    const globalCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, reg, name, ifacePtr, version) => {
        if (this.#registry !== registry) return;
        if (!ifacePtr || !reg) return;
        const iface = new Deno.UnsafePointerView(ifacePtr).getCString();
        if (iface === "wl_output") {
          this.#outputs.announce(name, version);
          return;
        }
        if (!isWaylandGlobalInterface(iface)) return;
        this.#globals.announce({ name, interface: iface, offeredVersion: version });
      }),
    );
    this.#listeners.push(globalCb);
    const globalRemoveCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, _registry, name) => {
        if (this.#registry !== registry) return;
        this.#outputs.remove(name);
        this.#globals.remove(name);
      }),
    );
    this.#listeners.push(globalRemoveCb);

    const regVtable = makeVtable([globalCb, globalRemoveCb], REGISTRY_EVENT_SIGNATURES, this.noops);
    this.#vtables.push(regVtable);
    if (sym.wl_proxy_add_listener(registry, Deno.UnsafePointer.of(regVtable), null) !== 0) {
      throw new Error("winding failed to listen to the Wayland global registry");
    }

    this.roundtripDisplay("registry initialization");
  }

  #bindOutput(name: number, offeredVersion: number): NativeWaylandOutput | null {
    const registry = this.#registry;
    if (!registry || offeredVersion < 1) return null;
    const version = clampWaylandBindVersion(
      offeredVersion,
      4,
      readWaylandInterfaceVersion(this.ifaces.output),
    );
    if (version < 1) return null;
    const ifaceName = cStr("wl_output");
    const proxy = this.wl.symbols.wl_proxy_marshal_array_flags(
      registry,
      WlOp.REGISTRY_BIND,
      this.ifaces.output,
      version,
      0,
      args(
        BigInt(name),
        Deno.UnsafePointer.value(Deno.UnsafePointer.of(ifaceName)),
        BigInt(version),
        0n,
      ),
    );
    if (!proxy) return null;

    const generation = Symbol(`Wayland output ${name}`);
    const scaleState = new WaylandOutputScaleState(generation, version);
    const done = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      this.guardCallback(() => {
        const current = this.#outputs.get(name)?.binding;
        if (current?.generation !== generation) return;
        const scale = scaleState.done(generation);
        if (scale === undefined) return;
        for (const window of this.windows) window.updateOutputScale(generation, scale);
      }),
    );
    const scale = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32"], result: "void" },
      this.guardCallback((_data, _proxy, factor) => {
        const current = this.#outputs.get(name)?.binding;
        if (current?.generation !== generation) return;
        scaleState.stage(generation, factor);
      }),
    );
    const callbacks = [done, scale];
    const vtable = makeVtable([null, null, done, scale], OUTPUT_EVENT_SIGNATURES, this.noops);
    const output: NativeWaylandOutput = { proxy, version, generation, scale: scaleState, callbacks, vtable };
    if (this.wl.symbols.wl_proxy_add_listener(proxy, Deno.UnsafePointer.of(vtable), null) !== 0) {
      try {
        this.#destroyOutputProxy(proxy, version);
      } catch {
        // The optional output remains inert without an installed listener.
      }
      for (const callback of callbacks) {
        try {
          callback.close();
        } catch {
          // Output scaling is optional, so callback cleanup failure degrades to scale 1.
        }
      }
      return null;
    }
    this.#outputsByProxy.set(Deno.UnsafePointer.value(proxy), output);
    return output;
  }

  #releaseOutput(output: WaylandOutputBinding<NativeWaylandOutput>): void {
    const native = output.binding;
    const key = Deno.UnsafePointer.value(native.proxy);
    if (this.#outputsByProxy.get(key)?.generation === native.generation) this.#outputsByProxy.delete(key);
    for (const window of this.windows) window.removeOutput(native.generation);

    try {
      this.#destroyOutputProxy(native.proxy, native.version);
    } catch {
      for (const callback of native.callbacks) this.retainNativeCallbackRoot(callback);
      this.retainNativeResourceRoot(native);
      return;
    }
    for (const callback of native.callbacks) {
      try {
        callback.close();
      } catch {
        // The proxy is gone, so callback cleanup failure cannot corrupt protocol state.
      }
    }
  }

  #destroyOutputProxy(proxy: Deno.PointerObject, version: number): void {
    if (outputReleaseStrategy(version) === "release") {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        proxy,
        WlOp.OUTPUT_RELEASE,
        null,
        version,
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
      return;
    }
    this.wl.symbols.wl_proxy_destroy(proxy);
  }

  #bindGlobal(offer: WaylandGlobalOffer): Deno.PointerObject | null {
    const sym = this.wl.symbols;
    const registry = this.#registry;
    if (!registry) return null;

    let ifacePtr: Deno.PointerObject;
    let version = 1;

    if (offer.interface === "wl_compositor") {
      ifacePtr = this.ifaces.compositor;
      version = clampWaylandBindVersion(
        offer.offeredVersion,
        6,
        readWaylandInterfaceVersion(ifacePtr),
      );
      if (version < 1) return null;
    } else if (offer.interface === "wl_shm") {
      ifacePtr = this.ifaces.shm;
      version = Math.min(offer.offeredVersion, 1);
    } else if (offer.interface === "wl_seat") {
      ifacePtr = this.ifaces.seat;
      version = Math.min(offer.offeredVersion, 5);
    } else if (offer.interface === "xdg_wm_base") {
      ifacePtr = this.xdgWmBaseIface;
      version = Math.min(offer.offeredVersion, 7);
    } else if (offer.interface === "zxdg_decoration_manager_v1") {
      ifacePtr = this.zxdgDecorationManagerIface;
      version = Math.min(offer.offeredVersion, 2);
    } else if (offer.interface === "wp_fractional_scale_manager_v1") {
      ifacePtr = this.wpFractionalScaleManagerIface;
      version = Math.min(offer.offeredVersion, 1);
    } else if (offer.interface === "wp_viewporter") {
      ifacePtr = this.wpViewporterIface;
      version = Math.min(offer.offeredVersion, 1);
    } else if (offer.interface === "wp_cursor_shape_manager_v1") {
      ifacePtr = this.wpCursorShapeManagerIface;
      version = Math.min(offer.offeredVersion, 1);
    } else {
      ifacePtr = this.zwpTextInputManagerIface;
      version = Math.min(offer.offeredVersion, 1);
    }
    if (version < 1) return null;

    const ifaceName = cStr(offer.interface);
    let proxy: Deno.PointerValue;
    try {
      proxy = sym.wl_proxy_marshal_array_flags(
        registry,
        WlOp.REGISTRY_BIND,
        ifacePtr,
        version,
        0,
        args(
          BigInt(offer.name),
          Deno.UnsafePointer.value(Deno.UnsafePointer.of(ifaceName)),
          BigInt(version),
          0n,
        ),
      );
    } catch (error) {
      if (isOptionalFractionalScaleManager(offer.interface)) return null;
      throw error;
    }
    if (!proxy) return null;

    try {
      if (offer.interface === "wl_compositor") {
        this.compositor = proxy;
        this.#coreCursorUnavailable = false;
      } else if (offer.interface === "wl_shm") {
        this.shm = proxy;
        this.#coreCursorUnavailable = false;
        this.#setupShmFormatListener(proxy);
      } else if (offer.interface === "wl_seat") {
        this.#seat = proxy;
        this.#setupSeat(proxy);
      } else if (offer.interface === "xdg_wm_base") {
        this.xdgWmBase = proxy;
        this.#setupXdgWmBaseListener(proxy);
      } else if (offer.interface === "zxdg_decoration_manager_v1") {
        this.#decorationManagers.bind(proxy, version);
        for (const window of this.windows) window.tryCreateDecoration();
      } else if (offer.interface === "wp_fractional_scale_manager_v1") {
        this.#fractionalScaleManagers.bind("fractional-scale", proxy, version);
        for (const window of this.windows) window.tryCreateFractionalScale();
      } else if (offer.interface === "wp_viewporter") {
        this.#fractionalScaleManagers.bind("viewporter", proxy, version);
        for (const window of this.windows) window.tryCreateFractionalScale();
      } else if (offer.interface === "wp_cursor_shape_manager_v1") {
        this.#cursorShapeManager = proxy;
        this.#ensureCursorShapeDevice();
      } else if (!this.#textInputController.bindManager(proxy)) return null;
      return proxy;
    } catch (error) {
      try {
        this.#releaseGlobal({ ...offer, binding: proxy });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `failed to bind and unwind ${offer.interface}`);
      }
      if (
        offer.interface === "zxdg_decoration_manager_v1" ||
        offer.interface === "wp_fractional_scale_manager_v1" ||
        offer.interface === "wp_viewporter" ||
        offer.interface === "wp_cursor_shape_manager_v1" ||
        offer.interface === "zwp_text_input_manager_v3"
      ) return null;
      throw error;
    }
  }

  #releaseGlobal(global: BoundWaylandGlobal<Deno.PointerObject>): void {
    const proxy = global.binding;
    if (global.interface === "wl_compositor") {
      if (this.compositor === proxy) this.compositor = null;
      this.wl.symbols.wl_proxy_destroy(proxy);
      return;
    }
    if (global.interface === "wl_shm") {
      let listener: AnyCallback | null = null;
      if (this.shm === proxy) {
        this.shm = null;
        const generation = this.#shmFormatGeneration;
        this.#shmFormatGeneration = undefined;
        if (generation !== undefined) this.#shmFormats.releaseBinding(generation);
        listener = this.#shmFormatListener;
        this.#shmFormatListener = null;
        this.#shmFormatVtable = undefined;
      }
      const errors: unknown[] = [];
      collectCleanupError(errors, () => this.wl.symbols.wl_proxy_destroy(proxy));
      if (listener) collectCleanupError(errors, () => listener.close());
      throwCleanupErrors("winding failed to release Wayland shared memory", errors);
      return;
    }
    if (global.interface === "wl_seat") {
      this.#releaseSeat(proxy);
      return;
    }
    if (global.interface === "xdg_wm_base") {
      if (this.xdgWmBase === proxy) this.xdgWmBase = null;
      const listener = this.#xdgWmBaseListener;
      this.#xdgWmBaseListener = null;
      this.#xdgWmBaseVtable = undefined;
      const errors: unknown[] = [];
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          proxy,
          WlOp.XDG_WM_BASE_DESTROY,
          null,
          this.wl.symbols.wl_proxy_get_version(proxy),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
      if (listener) collectCleanupError(errors, () => listener.close());
      throwCleanupErrors("winding failed to release the Wayland window factory", errors);
      return;
    }
    if (global.interface === "zxdg_decoration_manager_v1") {
      this.#decorationManagers.unbind(proxy);
      this.wl.symbols.wl_proxy_marshal_array_flags(
        proxy,
        WlOp.ZXDG_DECORATION_MANAGER_DESTROY,
        null,
        this.wl.symbols.wl_proxy_get_version(proxy),
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
      return;
    }
    if (global.interface === "wp_fractional_scale_manager_v1") {
      this.#fractionalScaleManagers.unbind("fractional-scale", proxy);
      this.#destroyOptionalFractionalScaleManager(proxy, WlOp.WP_FRACTIONAL_SCALE_MANAGER_DESTROY);
      return;
    }
    if (global.interface === "wp_viewporter") {
      this.#fractionalScaleManagers.unbind("viewporter", proxy);
      this.#destroyOptionalFractionalScaleManager(proxy, WlOp.WP_VIEWPORTER_DESTROY);
      return;
    }
    if (global.interface === "wp_cursor_shape_manager_v1") {
      if (this.#cursorShapeManager === proxy) this.#cursorShapeManager = null;
      const device = this.#cursorShapeDevice;
      this.#cursorShapeDevice = null;
      const errors: unknown[] = [];
      if (device) {
        collectCleanupError(errors, () => {
          this.wl.symbols.wl_proxy_marshal_array_flags(
            device,
            WlOp.WP_CURSOR_SHAPE_DEVICE_DESTROY,
            null,
            this.wl.symbols.wl_proxy_get_version(device),
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        });
      }
      collectCleanupError(errors, () => {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          proxy,
          WlOp.WP_CURSOR_SHAPE_MANAGER_DESTROY,
          null,
          this.wl.symbols.wl_proxy_get_version(proxy),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
      throwCleanupErrors("winding failed to release the Wayland cursor-shape manager", errors);
      return;
    }
    this.#textInputController.unbindManager(proxy);
  }

  #destroyOptionalFractionalScaleManager(proxy: Deno.PointerObject, opcode: number): void {
    try {
      this.wl.symbols.wl_proxy_marshal_array_flags(
        proxy,
        opcode,
        null,
        this.wl.symbols.wl_proxy_get_version(proxy),
        WL_MARSHAL_FLAG_DESTROY,
        args(),
      );
    } catch {
      // Do not locally abandon a server-side object whose destructor could not be confirmed.
      // It has no listener, but the proxy itself must stay owned until display disconnect.
      this.retainNativeResourceRoot(proxy);
    }
  }

  #setupShmFormatListener(proxy: Deno.PointerObject): void {
    const generation = this.#shmFormats.beginBinding();
    this.#shmFormatGeneration = generation;
    const listener = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, _shm, format) => {
        if (this.#shmFormats.advertise(generation, format)) this.#coreCursorUnavailable = false;
      }),
    );
    this.#shmFormatListener = listener;
    const vtable = makeVtable([listener], SHM_EVENT_SIGNATURES, this.noops);
    this.#shmFormatVtable = vtable;
    if (this.wl.symbols.wl_proxy_add_listener(proxy, Deno.UnsafePointer.of(vtable), null) !== 0) {
      throw new Error("winding failed to listen for Wayland shared-memory formats");
    }
  }

  requireArgb8888ShmFormat(): void {
    this.#shmFormats.requireArgb8888();
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
    const cursorAttachment = this.#coreCursorAttachment;
    if (!pointer || !cursorSurface || !cursorAttachment) return;
    if (this.#coreCursorCommitted) {
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
      return;
    }

    const attachmentTransaction = new WaylandShmAttachmentTransaction(cursorAttachment);
    try {
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
      const surfaceVersion = sym.wl_proxy_get_version(cursorSurface);
      sym.wl_proxy_marshal_array_flags(
        cursorSurface,
        WlOp.SURFACE_ATTACH,
        null,
        surfaceVersion,
        0,
        args(Deno.UnsafePointer.value(cursorAttachment.buffer), 0n, 0n),
      );
      attachmentTransaction.markAttached();
      sym.wl_proxy_marshal_array_flags(
        cursorSurface,
        WlOp.SURFACE_DAMAGE,
        null,
        surfaceVersion,
        0,
        args(0n, 0n, BigInt(cursorAttachment.layout.width), BigInt(cursorAttachment.layout.height)),
      );
      sym.wl_proxy_marshal_array_flags(
        cursorSurface,
        WlOp.SURFACE_COMMIT,
        null,
        surfaceVersion,
        0,
        args(),
      );
      attachmentTransaction.markCommitted();
      this.#coreCursorCommitted = true;
    } catch {
      attachmentTransaction.fail();
      this.#disableCoreCursorFallback();
    }
  }

  #disableCoreCursorFallback(): void {
    const surface = this.#coreCursorSurface;
    const buffers = this.#coreCursorBuffers;
    this.#coreCursorSurface = null;
    this.#coreCursorAttachment = null;
    this.#coreCursorBuffers = null;
    this.#coreCursorCommitted = false;
    this.#coreCursorUnavailable = true;
    if (surface) {
      try {
        this.wl.symbols.wl_proxy_marshal_array_flags(
          surface,
          WlOp.SURFACE_DESTROY,
          null,
          this.wl.symbols.wl_proxy_get_version(surface),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      } catch {
        this.retainNativeResourceRoot(surface);
      }
    }
    try {
      buffers?.close();
    } catch {
      // The cursor is optional; failed buffer destruction retains its own graph.
    }
  }

  #ensureCoreCursor(): boolean {
    if (this.#coreCursorSurface && this.#coreCursorAttachment) return true;
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
      const attachment = buffers.write(
        createDefaultCursorPixels(),
        DEFAULT_CURSOR_WIDTH,
        DEFAULT_CURSOR_HEIGHT,
      );
      if (!attachment) throw new Error("winding failed to allocate the Wayland cursor buffer");
      this.#coreCursorSurface = surface;
      this.#coreCursorAttachment = attachment;
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
    try {
      this.#cursorShapeDevice = symbols.wl_proxy_marshal_array_flags(
        this.#cursorShapeManager,
        WlOp.WP_CURSOR_SHAPE_MANAGER_GET_POINTER,
        this.wpCursorShapeDeviceIface,
        symbols.wl_proxy_get_version(this.#cursorShapeManager),
        0,
        args(0n, Deno.UnsafePointer.value(this.#pointer)),
      );
    } catch {
      // cursor-shape-v1 is optional; the core cursor surface remains the fallback.
      this.#cursorShapeDevice = null;
    }
  }

  #setupXdgWmBaseListener(wmBase: Deno.PointerObject): void {
    const sym = this.wl.symbols;
    let pingCb: AnyCallback | null = null;
    try {
      pingCb = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer", "u32"], result: "void" },
        this.guardCallback((_data, _wmb, serial) => {
          if (this.xdgWmBase !== wmBase) return;
          // Respond to ping to avoid being killed for being unresponsive
          sym.wl_proxy_marshal_array_flags(
            wmBase,
            WlOp.XDG_WM_BASE_PONG,
            null,
            sym.wl_proxy_get_version(wmBase),
            0,
            args(BigInt(serial)),
          );
        }),
      );
      const vtable = makeVtable([pingCb], XDG_WM_BASE_EVENT_SIGNATURES, this.noops);
      if (sym.wl_proxy_add_listener(wmBase, Deno.UnsafePointer.of(vtable), null) !== 0) {
        throw new Error("winding failed to listen to the Wayland window factory");
      }
      this.#xdgWmBaseListener = pingCb;
      this.#xdgWmBaseVtable = vtable;
    } catch (error) {
      if (pingCb) {
        try {
          pingCb.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "failed to unwind the Wayland window factory listener");
        }
      }
      throw error;
    }
  }

  #setupSeat(seat: Deno.PointerObject): void {
    const sym = this.wl.symbols;
    const callbacks: AnyCallback[] = [];
    let installed = false;
    try {
      const capCb = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer", "u32"], result: "void" },
        this.guardCallback((_data, _seat, caps) => {
          if (this.#seat !== seat) return;
          const pointerAction = pointerCapabilityAction(
            (caps & WlSeatCap.POINTER) !== 0,
            this.#pointer !== null,
          );
          if (pointerAction === "acquire") this.#acquirePointer(seat);
          else if (pointerAction === "release") this.#releasePointer(true);
          if ((caps & WlSeatCap.KEYBOARD) && !this.#keyboardController.active) {
            this.#keyboardController.acquire(seat);
          }
          if (!(caps & WlSeatCap.KEYBOARD) && this.#keyboardController.active) {
            this.#keyboardController.release();
          }
        }),
      );
      callbacks.push(capCb);
      const nameCb = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer", "pointer"], result: "void" },
        this.guardCallback(() => {
          if (this.#seat !== seat) return;
        }),
      );
      callbacks.push(nameCb);
      const seatVtable = makeVtable(
        callbacks,
        SEAT_EVENT_SIGNATURES,
        this.noops,
      );
      if (sym.wl_proxy_add_listener(seat, Deno.UnsafePointer.of(seatVtable), null) !== 0) {
        throw new Error("winding failed to listen to the selected Wayland seat");
      }
      installed = true;
      this.#seatListeners = callbacks;
      this.#seatVtable = seatVtable;
      this.#textInputController.setSeat(seat);
    } catch (error) {
      if (installed) throw error;
      const errors: unknown[] = [error];
      for (const callback of callbacks) collectCleanupError(errors, () => callback.close());
      if (errors.length > 1) throw new AggregateError(errors, "failed to unwind the Wayland seat listeners");
      throw error;
    }
  }

  #initPointer(seat: Deno.PointerObject): void {
    if (this.#seat !== seat || this.#pointer) return;
    const sym = this.wl.symbols;
    const pointer = sym.wl_proxy_marshal_array_flags(
      seat,
      WlOp.SEAT_GET_POINTER,
      this.ifaces.pointer,
      sym.wl_proxy_get_version(seat),
      0,
      args(0n),
    );
    if (!pointer) return;
    this.#pointer = pointer;
    this.#pointerFrame.beginGeneration(sym.wl_proxy_get_version(pointer));
    this.#ensureCursorShapeDevice();

    // wl_pointer events (indices):
    // 0=enter, 1=leave, 2=motion, 3=button, 4=axis, 5=frame, 6=axis_source, 7=axis_stop, 8=axis_discrete ...
    const enterCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "pointer", "i32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, serial, surface, xFixed, yFixed) => {
        if (this.#pointer !== pointer) return;
        const window = this.#windowForSurface(surface);
        if (!window) return;
        this.#pointerFrame.reset();
        this.#pointerFocus = window;
        this.#pointerPosition.updateFixed(xFixed, yFixed);
        this.#setDefaultCursor(serial);
        this.#events.push({ type: "mouseenter", ...this.#pointerSnapshot(), window });
      }),
    );
    this.#pointerListeners.push(enterCb);
    const leaveCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, surface)
      { parameters: ["pointer", "pointer", "u32", "pointer"], result: "void" },
      this.guardCallback((_data, _ptr, _serial, surface) => {
        if (this.#pointer !== pointer) return;
        const window = this.#windowForSurface(surface);
        if (!window || window !== this.#pointerFocus) return;
        this.#pointerFrame.reset();
        this.#pointerFocus = null;
        this.#events.push({ type: "mouseleave", ...this.#pointerSnapshot(), window });
      }),
    );
    this.#pointerListeners.push(leaveCb);
    const motionCb = new Deno.UnsafeCallback(
      // (data, pointer, time, surface_x_fixed, surface_y_fixed)
      { parameters: ["pointer", "pointer", "u32", "i32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, time, xFixed, yFixed) => {
        if (this.#pointer !== pointer) return;
        const window = this.#pointerFocus;
        if (!window) return;
        this.#pointerPosition.updateFixed(xFixed, yFixed);
        this.#events.push({ type: "mousemove", ...this.#pointerSnapshot(time), window });
      }),
    );
    this.#pointerListeners.push(motionCb);
    const buttonCb = new Deno.UnsafeCallback(
      // (data, pointer, serial, time, button, state)
      { parameters: ["pointer", "pointer", "u32", "u32", "u32", "u32"], result: "void" },
      this.guardCallback((_data, _ptr, _serial, time, button, state) => {
        if (this.#pointer !== pointer) return;
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
        const snapshot = this.#pointerSnapshot(time);
        this.#events.push({
          type: state ? "mousedown" : "mouseup",
          button: b,
          detail: this.#clickCounter.detail(b, state !== 0, snapshot.timeStamp, snapshot.x, snapshot.y),
          ...snapshot,
          window,
        });
      }),
    );
    this.#pointerListeners.push(buttonCb);
    const axisCb = new Deno.UnsafeCallback(
      // (data, pointer, time, axis, value_fixed)
      { parameters: ["pointer", "pointer", "u32", "u32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, time, axis, value) => {
        if (this.#pointer !== pointer) return;
        const window = this.#pointerFocus;
        if (!window) return;
        const wheel = this.#pointerFrame.axis(time, axis, value);
        if (wheel === undefined) return;
        this.#events.push({
          type: "wheel",
          deltaX: wheel.deltaX,
          deltaY: wheel.deltaY,
          deltaMode: wheel.deltaMode,
          ...this.#pointerSnapshot(wheel.time),
          window,
        });
      }),
    );
    this.#pointerListeners.push(axisCb);
    const frameCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      this.guardCallback((_data, _ptr) => {
        if (this.#pointer !== pointer) return;
        const wheel = this.#pointerFrame.frame();
        const window = this.#pointerFocus;
        if (wheel === undefined || !window) return;
        this.#events.push({
          type: "wheel",
          deltaX: wheel.deltaX,
          deltaY: wheel.deltaY,
          deltaMode: wheel.deltaMode,
          ...this.#pointerSnapshot(wheel.time),
          window,
        });
      }),
    );
    this.#pointerListeners.push(frameCb);
    const axisSourceCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.guardCallback((_data, _ptr, source) => {
        if (this.#pointer !== pointer || !this.#pointerFocus) return;
        this.#pointerFrame.axisSource(source);
      }),
    );
    this.#pointerListeners.push(axisSourceCb);
    const axisStopCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "u32"], result: "void" },
      this.guardCallback((_data, _ptr, time, axis) => {
        if (this.#pointer !== pointer || !this.#pointerFocus) return;
        this.#pointerFrame.axisStop(time, axis);
      }),
    );
    this.#pointerListeners.push(axisStopCb);
    const axisDiscreteCb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32", "i32"], result: "void" },
      this.guardCallback((_data, _ptr, axis, discrete) => {
        if (this.#pointer !== pointer || !this.#pointerFocus) return;
        this.#pointerFrame.axisDiscrete(axis, discrete);
      }),
    );
    this.#pointerListeners.push(axisDiscreteCb);
    const pointerVtable = makeVtable(
      this.#pointerListeners,
      POINTER_EVENT_SIGNATURES,
      this.noops,
    );
    this.#pointerVtable = pointerVtable;
    if (sym.wl_proxy_add_listener(pointer, Deno.UnsafePointer.of(pointerVtable), null) !== 0) {
      throw new Error("winding failed to listen to the Wayland pointer");
    }
  }

  #acquirePointer(seat: Deno.PointerObject): void {
    try {
      this.#initPointer(seat);
    } catch (error) {
      try {
        this.#releasePointer(false);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to acquire and unwind the Wayland pointer");
      }
      throw error;
    }
  }

  #releaseSeat(seat: Deno.PointerObject): void {
    if (this.#seat === seat) this.#seat = null;
    const listeners = this.#seatListeners;
    this.#seatListeners = [];
    this.#seatVtable = undefined;

    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.#textInputController.setSeat(null));
    collectCleanupError(errors, () => this.#releasePointer(true));
    collectCleanupError(errors, () => this.#keyboardController.release());
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
    for (const listener of listeners) {
      collectCleanupError(errors, () => listener.close());
    }
    throwCleanupErrors("winding failed to release the Wayland seat", errors);
  }

  #releasePointer(emitLeave: boolean): void {
    const focusedWindow = this.#pointerFocus;
    const cursorShapeDevice = this.#cursorShapeDevice;
    const pointer = this.#pointer;
    const listeners = this.#pointerListeners;
    this.#pointerFocus = null;
    this.#pointerFrame.beginGeneration(0);
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
    screenX: null;
    screenY: null;
    buttons: number;
    timeStamp: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  } {
    return {
      x: this.#pointerPosition.x,
      y: this.#pointerPosition.y,
      ...waylandPointerScreenPosition(),
      buttons: this.#pointerButtons,
      timeStamp: time === undefined ? performance.now() : this.#pointerClock.timeStamp(time),
      ...pointerModifiers(this.#keyboardController.modifiers),
    };
  }

  #windowForSurface(surface: Deno.PointerValue): WaylandWindow | null {
    return surface ? this.#windowsBySurface.get(Deno.UnsafePointer.value(surface)) ?? null : null;
  }

  outputScale(output: Deno.PointerValue): WaylandOutputScaleSnapshot | undefined {
    if (!output) return undefined;
    const binding = this.#outputsByProxy.get(Deno.UnsafePointer.value(output));
    return binding === undefined ? undefined : { generation: binding.generation, scale: binding.scale.scale };
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
    if (this.#pointerFocus === window) {
      this.#pointerFocus = null;
      this.#pointerFrame.reset();
    }
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

  deferAfterNativeCallback(action: () => void): void {
    this.#afterNativeCallbacks.defer(action);
  }

  #drainAfterNativeCallbacks(): void {
    this.#afterNativeCallbacks.drain();
  }

  retainNativeCallbackRoot(callback: AnyCallback): void {
    this.#retainedCallbackRoots.add(callback);
  }

  releaseNativeCallbackRoot(callback: AnyCallback): void {
    this.#retainedCallbackRoots.delete(callback);
  }

  retainNativeResourceRoot(resource: object): void {
    this.#retainedNativeResourceRoots.add(resource);
  }

  retainNativeDisconnectCleanup(cleanup: () => void): void {
    this.#retainedNativeDisconnectCleanups.add(cleanup);
  }

  releaseNativeResourceRoot(resource: object): void {
    this.#retainedNativeResourceRoots.delete(resource);
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
    this.#drainAfterNativeCallbacks();
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
    this.requireArgb8888ShmFormat();
    return new WaylandWindow(this, w, h);
  }

  event(): UIEvent | undefined {
    this.throwIfConnectionFailed();
    if (this.#closed) return undefined;
    const queued = this.#events.shift();
    if (queued !== undefined) return queued;
    this.#callbackErrors.throwIfPending();
    // A text-input done batch may produce several public edits. The consumer recalculates its
    // surrounding-text snapshot while handling them, so recover only once that queue is empty.
    this.#textInputController.flushPendingState();
    const sym = this.wl.symbols;
    this.flushDisplay("event flush");

    // Non-blocking read: prepare_read -> poll fd -> read_events or cancel_read
    if (sym.wl_display_prepare_read(this.display) === 0) {
      const pollView = new DataView(this.#pollFd.buffer);
      pollView.setInt16(4, POLLIN | (this.#wantsWrite ? POLLOUT : 0), true);
      pollView.setInt16(6, 0, true); // clear revents
      const ready = this.libc.symbols.poll(this.#pollFd, 1n, 0);
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
    this.#drainAfterNativeCallbacks();
    this.#callbackErrors.throwIfPending();
    if (this.#closed) return undefined;
    this.#keyboardController.enqueueDueRepeat();
    const dispatched = this.#events.shift();
    if (dispatched !== undefined) return dispatched;
    this.#callbackErrors.throwIfPending();
    this.#textInputController.flushPendingState();
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
    if (!this.#initialized) throw error;
    try {
      this.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "winding closed after a fatal Wayland connection error");
    }
    throw error;
  }

  #closeProtocolInitialization(): void {
    const errors: unknown[] = [];
    collectCleanupError(errors, () => this.#releasePointer(false));

    const coreCursorSurface = this.#coreCursorSurface;
    this.#coreCursorSurface = null;
    this.#coreCursorAttachment = null;
    this.#coreCursorCommitted = false;
    const coreCursorBuffers = this.#coreCursorBuffers;
    this.#coreCursorBuffers = null;
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
    if (coreCursorBuffers) collectCleanupError(errors, () => coreCursorBuffers.close());

    collectCleanupError(errors, () => this.#outputs.close());
    this.#outputsByProxy.clear();
    collectCleanupError(errors, () => this.#globals.close());
    const registry = this.#registry;
    this.#registry = null;
    if (registry) collectCleanupError(errors, () => this.wl.symbols.wl_proxy_destroy(registry));

    const listeners = this.#listeners.splice(0);
    this.#vtables = [];
    for (const callback of listeners) collectCleanupError(errors, () => callback.close());
    collectCleanupError(errors, () => this.#callbackErrors.throwIfPending());
    throwCleanupErrors("winding failed to close Wayland protocol initialization", errors);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#initialized = false;
    this.#afterNativeCallbacks.close();
    this.#events.close();
    const errors: unknown[] = [];

    for (const window of [...this.windows]) {
      collectCleanupError(errors, () => window.close());
    }
    this.windows.clear();
    this.#windowsBySurface.clear();
    collectCleanupError(errors, () => this.#closeProtocolInitialization());
    collectCleanupError(errors, () => this.#textInputController.close());
    collectCleanupError(errors, () => this.#keyboardController.close());
    collectCleanupError(errors, () => this.xkb.close());
    let disconnected = false;
    collectCleanupError(errors, () => {
      this.wl.symbols.wl_display_disconnect(this.display);
      disconnected = true;
    });
    if (disconnected) {
      const retainedCallbackRoots = [...this.#retainedCallbackRoots];
      this.#retainedCallbackRoots.clear();
      const retainedDisconnectCleanups = [...this.#retainedNativeDisconnectCleanups];
      this.#retainedNativeDisconnectCleanups.clear();
      releaseWaylandShmRootsAfterDisconnect(
        retainedCallbackRoots,
        retainedDisconnectCleanups,
        (callback) => callback.close(),
        (error) => errors.push(error),
      );
      this.#retainedNativeResourceRoots.clear();
      collectCleanupError(errors, () => this.noops.close());
    } else if (this.#retainedNativeResourceRoots.size === 0) {
      collectCleanupError(errors, () => this.noops.close());
    }
    collectCleanupError(errors, () => this.wl.close());
    collectCleanupError(errors, () => {
      if (this.libdl.symbols.dlclose(this.#wlHandle) !== 0) {
        throw new Error("winding failed to close Wayland loader handle");
      }
    });
    collectCleanupError(errors, () => this.libdl.close());
    collectCleanupError(errors, () => this.libc.close());
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

function isOptionalFractionalScaleManager(interfaceName: string): boolean {
  return interfaceName === "wp_fractional_scale_manager_v1" || interfaceName === "wp_viewporter";
}

export function validateWaylandNativeLayout(os: string, arch: string, littleEndian: boolean): void {
  if (os === "linux" && (arch === "x86_64" || arch === "aarch64") && littleEndian) return;
  throw new Error("winding Wayland bindings require 64-bit little-endian Linux on x86-64 or AArch64");
}

function validateLiveWaylandNativeLayout(): void {
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  validateWaylandNativeLayout(Deno.build.os, Deno.build.arch, littleEndian);
}

export const load: LoadLibrary = () => {
  validateLiveWaylandNativeLayout();
  return new WaylandLibrary();
};
