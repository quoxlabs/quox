import type { Window } from "../types.ts";
import { CompositionState, ImeActivationState, type ImeCursorArea, normalizeImeCursorArea } from "../input/mod.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp } from "./ffi.ts";
import { createWaylandSurroundingTextState, type WaylandSurroundingTextState } from "./text_input.ts";
import {
  type AnyCallback,
  args,
  CALLBACK_EVENT_SIGNATURES,
  collectCleanupError,
  FRACTIONAL_SCALE_EVENT_SIGNATURES,
  hasXdgToplevelState,
  makeVtable,
  type NativeCallbackHost,
  SURFACE_EVENT_SIGNATURES,
  SUSPENDED_TOPLEVEL_STATE,
  throwCleanupErrors,
  WL_MARSHAL_FLAG_DESTROY,
  XDG_SURFACE_EVENT_SIGNATURES,
  XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
  XDG_TOPLEVEL_EVENT_SIGNATURES,
} from "./protocol.ts";
import {
  createOpaqueBlackFrame,
  validateWaylandShmLayout,
  WaylandShmAttachmentTransaction,
  WaylandShmBuffer,
  type WaylandShmHost,
} from "./shm_buffer.ts";
import {
  setupServerSideDecorationBeforeInitialCommit,
  tryDestroyWaylandDecoration,
  type WaylandDecorationGeneration,
  WaylandDecorationLifecycle,
  type WaylandDecorationManagerBinding,
  WaylandDecorationMode,
} from "./decoration.ts";
import {
  planWaylandSurfaceFrame,
  WaylandConfigureAckState,
  type WaylandOutputGeneration,
  type WaylandOutputScaleSnapshot,
  WaylandSurfaceOutputScaleState,
} from "./output.ts";
import {
  type WaylandFractionalScaleChildGeneration,
  WaylandFractionalScaleLifecycle,
  type WaylandFractionalScaleManagerPair,
  WaylandFractionalSurfaceOwnership,
} from "./fractional_scale.ts";
import { WaylandWindowLifecycleGate } from "./window_lifecycle.ts";
import {
  addWaylandFrameCallbackListenerOrRollback,
  copyWaylandFrame,
  drainWaylandPendingFrame,
  WaylandDeferredFrameRetry,
  type WaylandFrameCallbackActions,
  WaylandFrameCallbackOwnership,
  type WaylandFrameCallbackRegistration,
  type WaylandOwnedFrame,
  WaylandPendingFrameState,
} from "./frame_pacing.ts";

export const DEFAULT_WAYLAND_APP_ID = "winding";

export function setDefaultWaylandAppIdBeforeInitialCommit(
  setAppId: (appId: string) => void,
  commitSurface: () => void,
): void {
  setAppId(DEFAULT_WAYLAND_APP_ID);
  commitSurface();
}

export function damageOpcodeForSurfaceVersion(version: number): number {
  return version >= 4 ? WlOp.SURFACE_DAMAGE_BUFFER : WlOp.SURFACE_DAMAGE;
}

/** Preserve listener ownership when a local wl_surface destroy cannot be confirmed. */
export function tryDestroyWaylandSurfaceWithListeners<Proxy, Callback, Owner extends object>(
  proxy: Proxy,
  callbacks: readonly Callback[],
  owner: Owner,
  destroy: (proxy: Proxy) => void,
  retainCallback: (callback: Callback) => void,
  retainOwner: (owner: Owner) => void,
  reportError: (error: unknown) => void,
): boolean {
  try {
    destroy(proxy);
    return true;
  } catch (error) {
    for (const callback of callbacks) retainCallback(callback);
    retainOwner(owner);
    reportError(error);
    return false;
  }
}

export interface WaylandConfiguration {
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  readonly framebufferWidth: number;
  readonly framebufferHeight: number;
  readonly devicePixelRatio: number;
  readonly suspended: boolean;
  readonly frameToken: number;
  readonly fractionalScaleNumerator?: number;
}

export interface CompletedWaylandConfiguration {
  readonly configuration: WaylandConfiguration;
  readonly visibilityChanged: boolean;
}

interface StagedToplevelState {
  readonly width: number;
  readonly height: number;
  readonly suspended: boolean;
}

export function frameMatchesConfiguration(
  configuration: WaylandConfiguration,
  width: number,
  height: number,
  frameToken: number | undefined,
): boolean {
  return width === configuration.framebufferWidth &&
    height === configuration.framebufferHeight &&
    (frameToken === undefined || frameToken === configuration.frameToken);
}

/** Latches role events with the following xdg_surface.configure serial. */
export class WaylandConfigureState {
  #width: number;
  #height: number;
  #suspended = false;
  #nextFrameToken = 0;
  #staged: StagedToplevelState | undefined;

  constructor(width: number, height: number) {
    this.#width = width;
    this.#height = height;
  }

  stageToplevel(width: number, height: number, suspended: boolean): void {
    this.#staged = { width, height, suspended };
  }

  complete(serial: number): CompletedWaylandConfiguration {
    const staged = this.#staged;
    this.#staged = undefined;
    const previousSuspended = this.#suspended;
    if (staged !== undefined) {
      if (staged.width > 0) this.#width = staged.width;
      if (staged.height > 0) this.#height = staged.height;
      this.#suspended = staged.suspended;
    }
    this.#nextFrameToken++;
    return {
      configuration: {
        serial: serial >>> 0,
        width: this.#width,
        height: this.#height,
        framebufferWidth: this.#width,
        framebufferHeight: this.#height,
        devicePixelRatio: 1,
        suspended: this.#suspended,
        frameToken: this.#nextFrameToken,
      },
      visibilityChanged: previousSuspended !== this.#suspended,
    };
  }

  applyScale(
    configuration: WaylandConfiguration,
    scale: number,
    advanceFrameToken: boolean,
  ): WaylandConfiguration {
    const framebufferWidth = configuration.width * scale;
    const framebufferHeight = configuration.height * scale;
    if (
      configuration.fractionalScaleNumerator === undefined &&
      configuration.devicePixelRatio === scale &&
      configuration.framebufferWidth === framebufferWidth &&
      configuration.framebufferHeight === framebufferHeight
    ) return configuration;
    if (advanceFrameToken) this.#nextFrameToken++;
    const { fractionalScaleNumerator: _fractionalScaleNumerator, ...unscaled } = configuration;
    return {
      ...unscaled,
      framebufferWidth,
      framebufferHeight,
      devicePixelRatio: scale,
      frameToken: advanceFrameToken ? this.#nextFrameToken : configuration.frameToken,
    };
  }

  applyFractionalScale(
    configuration: WaylandConfiguration,
    framebufferWidth: number,
    framebufferHeight: number,
    devicePixelRatio: number,
    numerator: number,
    advanceFrameToken: boolean,
  ): WaylandConfiguration {
    if (
      configuration.devicePixelRatio === devicePixelRatio &&
      configuration.framebufferWidth === framebufferWidth &&
      configuration.framebufferHeight === framebufferHeight &&
      configuration.fractionalScaleNumerator === numerator
    ) return configuration;
    if (advanceFrameToken) this.#nextFrameToken++;
    return {
      ...configuration,
      framebufferWidth,
      framebufferHeight,
      devicePixelRatio,
      frameToken: advanceFrameToken ? this.#nextFrameToken : configuration.frameToken,
      fractionalScaleNumerator: numerator,
    };
  }
}

export function selectWaylandConfigurationScale(
  configureState: WaylandConfigureState,
  configuration: WaylandConfiguration,
  fractionalScale: WaylandFractionalScaleLifecycle,
  outputScale: WaylandSurfaceOutputScaleState | undefined,
  advanceFrameToken: boolean,
): WaylandConfiguration {
  const fractionalSize = fractionalScale.framebufferSize(
    configuration.width,
    configuration.height,
    (size) => {
      try {
        validateWaylandShmLayout(size.width, size.height);
        return true;
      } catch {
        return false;
      }
    },
  );
  if (fractionalSize !== undefined) {
    return configureState.applyFractionalScale(
      configuration,
      fractionalSize.width,
      fractionalSize.height,
      fractionalSize.devicePixelRatio,
      fractionalSize.numerator,
      advanceFrameToken,
    );
  }
  const scale = outputScale?.effectiveScale((candidate) => {
    try {
      validateWaylandShmLayout(configuration.width * candidate, configuration.height * candidate);
      return true;
    } catch {
      return false;
    }
  }) ?? 1;
  return configureState.applyScale(configuration, scale, advanceFrameToken);
}

export function createInitialWaylandBlackFrame(configuration: WaylandConfiguration): Uint8Array {
  return createOpaqueBlackFrame(configuration.framebufferWidth, configuration.framebufferHeight);
}

export function dispatchWaylandWindowCallbackIfOpen(closed: boolean, callback: () => void): boolean {
  if (closed) return false;
  callback();
  return true;
}

/** Remove public/native routing before an optional child destructor can strand the owner. */
export function teardownWaylandWindowChildrenAfterUnregister(
  registered: boolean,
  markUnregistered: () => void,
  unregister: () => void,
  teardownChildren: () => boolean,
  reportError: (error: unknown) => void,
): boolean {
  if (registered) {
    markUnregistered();
    try {
      unregister();
    } catch (error) {
      reportError(error);
    }
  }
  return teardownChildren();
}

export function teardownWaylandOptionalWindowChildren(
  teardownDecoration: () => boolean,
  teardownFractionalScale: () => boolean,
): boolean {
  const decorationDestroyed = teardownDecoration();
  const fractionalScaleDestroyed = teardownFractionalScale();
  return decorationDestroyed && fractionalScaleDestroyed;
}

/** Enforce callback, optional-child, role, then wl_surface teardown ordering. */
export function teardownWaylandWindowNativeGraphInOrder(
  teardownFramePacing: () => void,
  teardownOptionalChildren: () => boolean,
  teardownRoles: () => void,
  teardownSurface: () => void,
): boolean {
  teardownFramePacing();
  if (!teardownOptionalChildren()) return false;
  teardownRoles();
  teardownSurface();
  return true;
}

export interface WaylandWindowHost extends NativeCallbackHost, WaylandShmHost {
  readonly compositor: Deno.PointerObject | null;
  readonly xdgWmBase: Deno.PointerObject | null;
  readonly xdgSurfaceIface: Deno.PointerObject;
  readonly xdgToplevelIface: Deno.PointerObject;
  readonly zxdgToplevelDecorationIface: Deno.PointerObject;
  readonly wpFractionalScaleIface: Deno.PointerObject;
  readonly wpViewportIface: Deno.PointerObject;
  readonly decorationManager: WaylandDecorationManagerBinding<Deno.PointerObject> | undefined;
  readonly fractionalScaleManagers: WaylandFractionalScaleManagerPair<Deno.PointerObject> | undefined;
  readonly ifaces: {
    readonly surface: Deno.PointerObject;
    readonly shmPool: Deno.PointerObject;
    readonly buffer: Deno.PointerObject;
    readonly callback: Deno.PointerObject;
  };
  registerWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  unregisterWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  updateWindowImeState(window: WaylandWindow): void;
  updateWindowImeCursorArea(window: WaylandWindow): void;
  updateWindowImeSurroundingText(window: WaylandWindow): void;
  throwCallbackError(): void;
  roundtripDisplay(context: string): void;
  flushDisplay(context: string): void;
  deferAfterNativeCallback(action: () => void): void;
  outputScale(output: Deno.PointerValue): WaylandOutputScaleSnapshot | undefined;
  releaseNativeCallbackRoot(callback: AnyCallback): void;
  releaseNativeResourceRoot(resource: object): void;
}

export class WaylandWindow implements Window {
  #surface: Deno.PointerObject | null = null;
  #xdgSurface: Deno.PointerObject | null = null;
  #xdgToplevel: Deno.PointerObject | null = null;
  #surfaceVtable: BigUint64Array<ArrayBuffer> | undefined;
  #wlSurfaceVtable: BigUint64Array<ArrayBuffer> | undefined;
  #surfaceEnter: AnyCallback | null = null;
  #surfaceLeave: AnyCallback | null = null;
  #surfacePreferredScale: AnyCallback | null = null;
  readonly #frameCallbacks = new WaylandFrameCallbackOwnership<
    Deno.PointerObject,
    AnyCallback,
    BigUint64Array<ArrayBuffer>,
    BigUint64Array<ArrayBuffer>,
    WaylandWindow
  >(this);
  readonly #pendingFrames = new WaylandPendingFrameState();
  readonly #deferredFrameRetry: WaylandDeferredFrameRetry;
  #queuedFrameDone: { readonly address: bigint; readonly generation: number } | undefined;
  #toplevelVtable: BigUint64Array<ArrayBuffer> | undefined;
  #xdgSurfaceConfigure: AnyCallback | null = null;
  #toplevelConfigure: AnyCallback | null = null;
  #toplevelClose: AnyCallback | null = null;
  #decoration: Deno.PointerObject | null = null;
  #decorationGeneration: WaylandDecorationGeneration | undefined;
  #decorationConfigure: AnyCallback | null = null;
  #decorationVtable: BigUint64Array<ArrayBuffer> | undefined;
  readonly #decorationLifecycle = new WaylandDecorationLifecycle();
  readonly #fractionalScaleOwnership = new WaylandFractionalSurfaceOwnership<
    Deno.PointerObject,
    AnyCallback,
    BigUint64Array<ArrayBuffer>,
    WaylandWindow
  >(this);
  #fractionalScaleGeneration: WaylandFractionalScaleChildGeneration | undefined;
  readonly #fractionalScaleLifecycle = new WaylandFractionalScaleLifecycle();
  readonly #shmBuffer: WaylandShmBuffer;
  readonly #configureState: WaylandConfigureState;
  #surfaceOutputScale: WaylandSurfaceOutputScaleState | undefined;
  #configuration: WaylandConfiguration | undefined;
  readonly #configureAcks = new WaylandConfigureAckState();
  #registered = false;
  readonly #lifecycle = new WaylandWindowLifecycleGate();
  readonly imeActivation = new ImeActivationState();
  readonly composition = new CompositionState();
  #imeCursorArea: ImeCursorArea | undefined;
  #imeSurroundingText: WaylandSurroundingTextState | undefined;

  constructor(readonly lib: WaylandWindowHost, width: number, height: number) {
    this.#deferredFrameRetry = new WaylandDeferredFrameRetry(
      lib.guardCallback(() => this.#runDeferredFrameRetry()),
      (retry) => lib.deferAfterNativeCallback(retry),
    );
    this.#shmBuffer = new WaylandShmBuffer(
      lib,
      lib.guardCallback(() => {
        if (!this.#lifecycle.closed) this.#deferredFrameRetry.request();
      }),
    );
    this.#configureState = new WaylandConfigureState(width, height);
    const symbols = lib.wl.symbols;
    const errors: unknown[] = [];
    try {
      this.#surface = symbols.wl_proxy_marshal_array_flags(
        lib.compositor!,
        WlOp.COMPOSITOR_CREATE_SURFACE,
        lib.ifaces.surface,
        symbols.wl_proxy_get_version(lib.compositor!),
        0,
        args(0n),
      );
      if (!this.#surface) throw new Error("winding failed to create wl_surface");
      this.#surfaceOutputScale = new WaylandSurfaceOutputScaleState(
        symbols.wl_proxy_get_version(this.#surface),
      );

      this.#xdgSurface = symbols.wl_proxy_marshal_array_flags(
        lib.xdgWmBase!,
        WlOp.XDG_WM_BASE_GET_XDG_SURFACE,
        lib.xdgSurfaceIface,
        symbols.wl_proxy_get_version(lib.xdgWmBase!),
        0,
        args(0n, Deno.UnsafePointer.value(this.#surface)),
      );
      if (!this.#xdgSurface) throw new Error("winding failed to create xdg_surface");

      this.#xdgToplevel = symbols.wl_proxy_marshal_array_flags(
        this.#xdgSurface,
        WlOp.XDG_SURFACE_GET_TOPLEVEL,
        lib.xdgToplevelIface,
        symbols.wl_proxy_get_version(this.#xdgSurface),
        0,
        args(0n),
      );
      if (!this.#xdgToplevel) throw new Error("winding failed to create xdg_toplevel");

      this.#setupListeners();
      this.tryCreateFractionalScale();
      this.setTitle("winding");
      lib.registerWindow(this.#surface, this);
      this.#registered = true;
      setupServerSideDecorationBeforeInitialCommit(
        (preferredMode) => this.tryCreateDecoration(preferredMode),
        () =>
          setDefaultWaylandAppIdBeforeInitialCommit(
            (appId) => this.#setAppId(appId),
            () => {
              symbols.wl_proxy_marshal_array_flags(
                this.#surface!,
                WlOp.SURFACE_COMMIT,
                null,
                symbols.wl_proxy_get_version(this.#surface!),
                0,
                args(),
              );
              this.#decorationLifecycle.markInitialSurfaceCommit();
            },
          ),
      );
      lib.roundtripDisplay("initial window configure");
      if (this.#decorationLifecycle.awaitingInitialConfigure) {
        lib.roundtripDisplay("late initial window decoration configure");
      }
      lib.throwCallbackError();
      const configuration = this.#configuration;
      if (!configuration) throw new Error("winding Wayland compositor did not send an initial configure");
      this.#abandonUnconfiguredInitialDecoration();
      const initialFrame = copyWaylandFrame(
        createInitialWaylandBlackFrame(configuration),
        configuration.framebufferWidth,
        configuration.framebufferHeight,
        configuration.frameToken,
      );
      if (!this.#present(initialFrame, configuration)) {
        throw new Error("winding Wayland could not map the initial window buffer");
      }
      return;
    } catch (error) {
      errors.push(error);
    }
    this.#lifecycle.close(() => this.#cleanup(errors));
    throwCleanupErrors("winding failed to create Wayland window", errors);
  }

  get imeEnabled(): boolean {
    return this.imeActivation.desired;
  }

  get imeCursorArea(): ImeCursorArea | undefined {
    return this.#imeCursorArea;
  }

  get imeSurroundingText(): WaylandSurroundingTextState | undefined {
    return this.#imeSurroundingText;
  }

  tryCreateDecoration(preferredMode: WaylandDecorationMode = WaylandDecorationMode.serverSide): void {
    if (this.#lifecycle.closed || !this.#xdgToplevel || this.#decoration) return;
    const binding = this.lib.decorationManager;
    if (binding === undefined) return;
    const generation = this.#decorationLifecycle.begin(binding.generation, binding.version);
    if (generation === undefined) return;
    this.#decorationGeneration = generation;

    try {
      const symbols = this.lib.wl.symbols;
      const decoration = symbols.wl_proxy_marshal_array_flags(
        binding.manager,
        WlOp.ZXDG_DECORATION_MANAGER_GET_TOPLEVEL_DECORATION,
        this.lib.zxdgToplevelDecorationIface,
        binding.version,
        0,
        args(0n, Deno.UnsafePointer.value(this.#xdgToplevel)),
      );
      if (!decoration) throw new Error("winding could not create an optional Wayland toplevel decoration");
      this.#decoration = decoration;

      const configure = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer", "u32"], result: "void" },
        this.lib.guardCallback((_data, _decoration, mode) => {
          dispatchWaylandWindowCallbackIfOpen(
            this.#lifecycle.closed,
            () => this.#decorationLifecycle.configure(generation, mode),
          );
        }),
      );
      this.#decorationConfigure = configure;
      const vtable = makeVtable(
        [configure],
        XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
        this.lib.noops,
      );
      this.#decorationVtable = vtable;
      if (symbols.wl_proxy_add_listener(decoration, Deno.UnsafePointer.of(vtable), null) !== 0) {
        throw new Error("winding could not listen to an optional Wayland toplevel decoration");
      }
      symbols.wl_proxy_marshal_array_flags(
        decoration,
        WlOp.ZXDG_TOPLEVEL_DECORATION_SET_MODE,
        null,
        symbols.wl_proxy_get_version(decoration),
        0,
        args(BigInt(preferredMode)),
      );
    } catch {
      this.#cleanupDecoration([]);
    }
  }

  tryCreateFractionalScale(): void {
    if (this.#lifecycle.closed || !this.#surface) return;
    const managers = this.lib.fractionalScaleManagers;
    if (managers === undefined) return;
    const generation = this.#fractionalScaleLifecycle.begin(managers);
    if (generation === undefined) return;
    this.#fractionalScaleGeneration = generation;

    try {
      const symbols = this.lib.wl.symbols;
      const fractionalScale = symbols.wl_proxy_marshal_array_flags(
        managers.fractionalScale.manager,
        WlOp.WP_FRACTIONAL_SCALE_MANAGER_GET_FRACTIONAL_SCALE,
        this.lib.wpFractionalScaleIface,
        managers.fractionalScale.version,
        0,
        args(0n, Deno.UnsafePointer.value(this.#surface)),
      );
      if (!fractionalScale) throw new Error("winding could not create optional Wayland fractional scale");
      this.#fractionalScaleOwnership.installFractionalScaleProxy(fractionalScale);

      const preferred = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer", "u32"], result: "void" },
        this.lib.guardCallback((_data, _fractionalScale, numerator) => {
          if (this.#lifecycle.closed || !this.#fractionalScaleLifecycle.prefer(generation, numerator)) return;
          this.#reconcileOutputScale();
        }),
      );
      this.#fractionalScaleOwnership.installPreferredCallback(preferred);
      const vtable = makeVtable(
        [preferred],
        FRACTIONAL_SCALE_EVENT_SIGNATURES,
        this.lib.noops,
      );
      this.#fractionalScaleOwnership.installVtable(vtable);
      if (symbols.wl_proxy_add_listener(fractionalScale, Deno.UnsafePointer.of(vtable), null) !== 0) {
        throw new Error("winding could not listen to optional Wayland fractional scale");
      }

      const viewport = symbols.wl_proxy_marshal_array_flags(
        managers.viewporter.manager,
        WlOp.WP_VIEWPORTER_GET_VIEWPORT,
        this.lib.wpViewportIface,
        managers.viewporter.version,
        0,
        args(0n, Deno.UnsafePointer.value(this.#surface)),
      );
      if (!viewport) throw new Error("winding could not create optional Wayland viewport");
      this.#fractionalScaleOwnership.installViewport(viewport);
      if (!this.#fractionalScaleLifecycle.activate(generation)) {
        throw new Error("winding could not activate optional Wayland fractional scale");
      }
    } catch {
      // Both extensions are optional. Safely unwind whatever was created and retain any
      // unconfirmed proxy/listener ownership rather than poisoning the core integer path.
      this.#cleanupFractionalScale([]);
    }
  }

  updateOutputScale(generation: WaylandOutputGeneration, scale: number): void {
    if (this.#lifecycle.closed) return;
    if (!this.#surfaceOutputScale?.update(generation, scale)) return;
    this.#reconcileOutputScale();
  }

  removeOutput(generation: WaylandOutputGeneration): void {
    if (this.#lifecycle.closed) return;
    if (!this.#surfaceOutputScale?.leave(generation)) return;
    this.#reconcileOutputScale();
  }

  #reconcileOutputScale(): void {
    const configuration = this.#configuration;
    if (configuration === undefined) return;
    const updated = this.#configurationWithCurrentScale(configuration, true);
    if (updated === configuration) return;
    this.#configuration = updated;
    this.#discardStalePendingFrame();
    this.#emitResize(updated);
  }

  #configurationWithCurrentScale(
    configuration: WaylandConfiguration,
    advanceFrameToken: boolean,
  ): WaylandConfiguration {
    return selectWaylandConfigurationScale(
      this.#configureState,
      configuration,
      this.#fractionalScaleLifecycle,
      this.#surfaceOutputScale,
      advanceFrameToken,
    );
  }

  #emitResize(configuration: WaylandConfiguration): void {
    this.lib.pushEvent({
      type: "resize",
      width: configuration.width,
      height: configuration.height,
      framebufferWidth: configuration.framebufferWidth,
      framebufferHeight: configuration.framebufferHeight,
      devicePixelRatio: configuration.devicePixelRatio,
      frameToken: configuration.frameToken,
      window: this,
    });
  }

  #setupListeners(): void {
    const symbols = this.lib.wl.symbols;
    const frameDone = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.lib.guardCallback((data, callback, _callbackData) => {
        if (this.#lifecycle.closed || !data || !callback) return;
        const generationValue = new Deno.UnsafePointerView(data).getBigUint64(0);
        if (generationValue < 1n || generationValue > BigInt(Number.MAX_SAFE_INTEGER)) return;
        const address = Deno.UnsafePointer.value(callback);
        const generation = Number(generationValue);
        if (this.#frameCallbacks.matches(address, generation) === undefined) return;
        this.#queuedFrameDone = { address, generation };
        this.#deferredFrameRetry.request();
      }),
    );
    this.#frameCallbacks.installListener(frameDone);
    this.#frameCallbacks.installVtable(
      makeVtable([frameDone], CALLBACK_EVENT_SIGNATURES, this.lib.noops),
    );

    this.#surfaceEnter = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.lib.guardCallback((_data, _surface, output) => {
        if (this.#lifecycle.closed) return;
        const snapshot = this.lib.outputScale(output);
        if (snapshot === undefined || !this.#surfaceOutputScale?.enter(snapshot.generation, snapshot.scale)) return;
        this.#reconcileOutputScale();
      }),
    );
    this.#surfaceLeave = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "pointer"], result: "void" },
      this.lib.guardCallback((_data, _surface, output) => {
        if (this.#lifecycle.closed) return;
        const snapshot = this.lib.outputScale(output);
        if (snapshot === undefined || !this.#surfaceOutputScale?.leave(snapshot.generation)) return;
        this.#reconcileOutputScale();
      }),
    );
    this.#surfacePreferredScale = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32"], result: "void" },
      this.lib.guardCallback((_data, _surface, factor) => {
        if (this.#lifecycle.closed) return;
        if (!this.#surfaceOutputScale?.prefer(factor)) return;
        this.#reconcileOutputScale();
      }),
    );
    this.#wlSurfaceVtable = makeVtable(
      [this.#surfaceEnter, this.#surfaceLeave, this.#surfacePreferredScale, null],
      SURFACE_EVENT_SIGNATURES,
      this.lib.noops,
    );
    if (
      symbols.wl_proxy_add_listener(
        this.#surface!,
        Deno.UnsafePointer.of(this.#wlSurfaceVtable),
        null,
      ) !== 0
    ) throw new Error("winding failed to listen to the Wayland core surface");

    this.#xdgSurfaceConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.lib.guardCallback((_data, _surface, serial) => {
        dispatchWaylandWindowCallbackIfOpen(this.#lifecycle.closed, () => {
          const completed = this.#configureState.complete(serial);
          const configuration = this.#configurationWithCurrentScale(completed.configuration, false);
          this.#configuration = configuration;
          this.#discardStalePendingFrame();
          this.#emitResize(configuration);
          if (completed.visibilityChanged) {
            this.lib.pushEvent({
              type: "visibilitychange",
              visible: !configuration.suspended,
              window: this,
            });
          }
        });
      }),
    );
    this.#surfaceVtable = makeVtable(
      [this.#xdgSurfaceConfigure],
      XDG_SURFACE_EVENT_SIGNATURES,
      this.lib.noops,
    );
    if (
      symbols.wl_proxy_add_listener(
        this.#xdgSurface!,
        Deno.UnsafePointer.of(this.#surfaceVtable),
        null,
      ) !== 0
    ) throw new Error("winding failed to listen to the Wayland window surface");

    this.#toplevelConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32", "pointer"], result: "void" },
      this.lib.guardCallback((_data, _toplevel, width, height, states) => {
        dispatchWaylandWindowCallbackIfOpen(this.#lifecycle.closed, () => {
          const suspended = hasXdgToplevelState(states, SUSPENDED_TOPLEVEL_STATE);
          this.#configureState.stageToplevel(width, height, suspended);
        });
      }),
    );
    this.#toplevelClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      this.lib.guardCallback(() => {
        dispatchWaylandWindowCallbackIfOpen(
          this.#lifecycle.closed,
          () => this.lib.pushEvent({ type: "close", window: this }),
        );
      }),
    );
    this.#toplevelVtable = makeVtable(
      [this.#toplevelConfigure, this.#toplevelClose],
      XDG_TOPLEVEL_EVENT_SIGNATURES,
      this.lib.noops,
    );
    if (
      symbols.wl_proxy_add_listener(
        this.#xdgToplevel!,
        Deno.UnsafePointer.of(this.#toplevelVtable),
        null,
      ) !== 0
    ) throw new Error("winding failed to listen to the Wayland top-level window");
  }

  #ackConfiguration(configuration: WaylandConfiguration): void {
    if (!this.#xdgSurface) return;
    const symbols = this.lib.wl.symbols;
    this.#configureAcks.ack(configuration.serial, (serial) => {
      symbols.wl_proxy_marshal_array_flags(
        this.#xdgSurface,
        WlOp.XDG_SURFACE_ACK_CONFIGURE,
        null,
        symbols.wl_proxy_get_version(this.#xdgSurface),
        0,
        args(BigInt(serial)),
      );
    });
  }

  #setAppId(appId: string): void {
    const symbols = this.lib.wl.symbols;
    const appIdBuffer = cStr(appId);
    symbols.wl_proxy_marshal_array_flags(
      this.#xdgToplevel!,
      WlOp.XDG_TOPLEVEL_SET_APP_ID,
      null,
      symbols.wl_proxy_get_version(this.#xdgToplevel!),
      0,
      args(Deno.UnsafePointer.value(Deno.UnsafePointer.of(appIdBuffer))),
    );
  }

  setTitle(title: string): void {
    this.#lifecycle.mutate("setTitle", () => {
      this.lib.throwIfConnectionFailed();
      if (!this.#xdgToplevel) return;
      const symbols = this.lib.wl.symbols;
      const titleBuffer = cStr(title);
      symbols.wl_proxy_marshal_array_flags(
        this.#xdgToplevel,
        WlOp.XDG_TOPLEVEL_SET_TITLE,
        null,
        symbols.wl_proxy_get_version(this.#xdgToplevel),
        0,
        args(Deno.UnsafePointer.value(Deno.UnsafePointer.of(titleBuffer))),
      );
      this.lib.flushDisplay("setting a window title");
    });
  }

  setImeEnabled(enabled: boolean): void {
    this.#lifecycle.mutate("setImeEnabled", () => {
      this.lib.throwIfConnectionFailed();
      if (this.imeActivation.desired === enabled) return;
      this.imeActivation.setDesired(enabled);
      this.lib.updateWindowImeState(this);
    });
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.#lifecycle.mutate("setImeCursorArea", () => {
      this.lib.throwIfConnectionFailed();
      const area = normalizeImeCursorArea(x, y, width, height);
      if (area === undefined) return;
      this.#imeCursorArea = area;
      this.lib.updateWindowImeCursorArea(this);
    });
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    this.#lifecycle.mutate("setImeSurroundingText", () => {
      this.lib.throwIfConnectionFailed();
      this.#imeSurroundingText = createWaylandSurroundingTextState(
        text,
        selectionStartBytes,
        selectionEndBytes,
      );
      this.lib.updateWindowImeSurroundingText(this);
    });
  }

  blit(rgba: Uint8Array, width: number, height: number, frameToken?: number): void {
    this.#lifecycle.mutate("blit", () => {
      this.lib.throwIfConnectionFailed();
      this.#pendingFrames.assertAvailable();
      if (!this.#surface) return;
      const configuration = this.#configuration;
      if (!configuration || !frameMatchesConfiguration(configuration, width, height, frameToken)) return;
      const frame = copyWaylandFrame(rgba, width, height, frameToken);
      this.#pendingFrames.replace(frame);
      this.#drainPendingFrame();
    });
  }

  #discardStalePendingFrame(): void {
    const configuration = this.#configuration;
    this.#pendingFrames.discardUnless((frame) =>
      configuration !== undefined &&
      frameMatchesConfiguration(configuration, frame.width, frame.height, frame.frameToken)
    );
  }

  #drainPendingFrame(): void {
    const configuration = this.#configuration;
    drainWaylandPendingFrame(
      this.#pendingFrames,
      this.#frameCallbacks.outstanding || this.#lifecycle.closed,
      (frame) =>
        configuration !== undefined &&
        frameMatchesConfiguration(configuration, frame.width, frame.height, frame.frameToken),
      (frame) => this.#present(frame, configuration!),
    );
  }

  #runDeferredFrameRetry(): void {
    if (this.#lifecycle.closed) return;
    const frameDone = this.#queuedFrameDone;
    this.#queuedFrameDone = undefined;
    if (frameDone !== undefined) this.#completeFrameCallback(frameDone.address, frameDone.generation);
    this.#drainPendingFrame();
  }

  #completeFrameCallback(address: bigint, generation: number): void {
    const errors: unknown[] = [];
    const completion = this.#frameCallbacks.complete(
      address,
      generation,
      this.#frameCallbackActions(errors),
    );
    if (completion.kind === "ignored") return;
    if (completion.kind === "stranded") this.#pendingFrames.disable();
    throwCleanupErrors("winding failed to finish a Wayland frame callback", errors);
  }

  #frameCallbackActions(
    errors: unknown[],
  ): WaylandFrameCallbackActions<Deno.PointerObject, AnyCallback, WaylandWindow> {
    return {
      destroyProxy: (proxy) => this.lib.wl.symbols.wl_proxy_destroy(proxy),
      closeListener: (callback) => callback.close(),
      retainListener: (callback) => this.lib.retainNativeCallbackRoot(callback),
      retainOwner: (owner) => this.lib.retainNativeResourceRoot(owner),
      reportError: (error) => errors.push(error),
    };
  }

  #armFrameCallback(): WaylandFrameCallbackRegistration<
    Deno.PointerObject,
    BigUint64Array<ArrayBuffer>
  > {
    const surface = this.#surface;
    const vtable = this.#frameCallbacks.vtable;
    if (!surface || vtable === undefined || this.#frameCallbacks.listener === null) {
      this.#pendingFrames.disable();
      throw new Error("winding Wayland frame listener is not available");
    }
    if (this.#frameCallbacks.outstanding) {
      this.#pendingFrames.disable();
      throw new Error("winding attempted to arm more than one Wayland frame callback");
    }

    const generationData = new BigUint64Array(1);
    const symbols = this.lib.wl.symbols;
    const callback = symbols.wl_proxy_marshal_array_flags(
      surface,
      WlOp.SURFACE_FRAME,
      this.lib.ifaces.callback,
      symbols.wl_proxy_get_version(surface),
      0,
      args(0n),
    );
    if (!callback) {
      this.#pendingFrames.disable();
      throw new Error("winding failed to create a Wayland frame callback");
    }

    const registration = this.#frameCallbacks.arm(
      callback,
      Deno.UnsafePointer.value(callback),
      generationData,
    );
    generationData[0] = BigInt(registration.generation);
    const generationPointer = Deno.UnsafePointer.of(generationData);
    addWaylandFrameCallbackListenerOrRollback(
      () => {
        if (!generationPointer) throw new Error("winding failed to root a Wayland frame callback generation");
        return symbols.wl_proxy_add_listener(
          callback,
          Deno.UnsafePointer.of(vtable),
          generationPointer,
        );
      },
      (error) => {
        const errors: unknown[] = [error];
        this.#pendingFrames.disable();
        this.#frameCallbacks.abort(registration, this.#frameCallbackActions(errors));
        throwCleanupErrors("winding failed to arm a Wayland frame callback", errors);
        throw error;
      },
    );
    return registration;
  }

  #present(frame: WaylandOwnedFrame, configuration: WaylandConfiguration): boolean {
    if (!this.#surface || this.#pendingFrames.disabled) return false;
    if (!this.#decorationLifecycle.canAttachInitialBuffer) {
      this.#abandonUnconfiguredInitialDecoration();
      if (!this.#decorationLifecycle.canAttachInitialBuffer) return false;
    }
    const attachment = this.#shmBuffer.write(frame.rgba, frame.width, frame.height);
    if (!attachment) return false;
    const attachmentTransaction = new WaylandShmAttachmentTransaction(attachment);
    let frameCallback:
      | WaylandFrameCallbackRegistration<Deno.PointerObject, BigUint64Array<ArrayBuffer>>
      | undefined;
    try {
      const symbols = this.lib.wl.symbols;
      const version = symbols.wl_proxy_get_version(this.#surface);
      const requests = planWaylandSurfaceFrame(
        version,
        configuration.devicePixelRatio,
        configuration.width,
        configuration.height,
        configuration.framebufferWidth,
        configuration.framebufferHeight,
        {
          viewportAvailable: this.#fractionalScaleOwnership.viewport !== null,
          fractionalScaleNumerator: configuration.fractionalScaleNumerator,
          requestFrameCallback: true,
        },
      );
      this.#ackConfiguration(configuration);
      for (const request of requests) {
        switch (request.kind) {
          case "set-buffer-scale":
            symbols.wl_proxy_marshal_array_flags(
              this.#surface,
              WlOp.SURFACE_SET_BUFFER_SCALE,
              null,
              version,
              0,
              args(BigInt(request.scale)),
            );
            break;
          case "set-viewport-destination": {
            const viewport = this.#fractionalScaleOwnership.viewport;
            if (!viewport) break;
            symbols.wl_proxy_marshal_array_flags(
              viewport,
              WlOp.WP_VIEWPORT_SET_DESTINATION,
              null,
              symbols.wl_proxy_get_version(viewport),
              0,
              args(BigInt(request.width), BigInt(request.height)),
            );
            break;
          }
          case "attach":
            symbols.wl_proxy_marshal_array_flags(
              this.#surface,
              WlOp.SURFACE_ATTACH,
              null,
              version,
              0,
              args(Deno.UnsafePointer.value(attachment.buffer), 0n, 0n),
            );
            attachmentTransaction.markAttached();
            break;
          case "damage-buffer":
          case "damage-surface":
            symbols.wl_proxy_marshal_array_flags(
              this.#surface,
              request.kind === "damage-buffer" ? WlOp.SURFACE_DAMAGE_BUFFER : WlOp.SURFACE_DAMAGE,
              null,
              version,
              0,
              args(0n, 0n, BigInt(request.width), BigInt(request.height)),
            );
            break;
          case "frame":
            frameCallback = this.#armFrameCallback();
            break;
          case "commit":
            if (frameCallback === undefined) {
              throw new Error("winding Wayland frame plan omitted its pacing callback");
            }
            symbols.wl_proxy_marshal_array_flags(
              this.#surface,
              WlOp.SURFACE_COMMIT,
              null,
              version,
              0,
              args(),
            );
            attachmentTransaction.markCommitted();
            this.#decorationLifecycle.markBufferCommit();
            break;
        }
      }
      if (!attachmentTransaction.committed) {
        throw new Error("winding Wayland frame plan omitted its surface commit");
      }
      this.lib.flushDisplay("presenting a window frame");
      return true;
    } catch (error) {
      this.#pendingFrames.disable();
      const settlement = attachmentTransaction.fail();
      if (settlement === "committed") throw error;
      const errors: unknown[] = [error];
      if (frameCallback !== undefined) {
        this.#frameCallbacks.abort(frameCallback, this.#frameCallbackActions(errors));
      }
      throwCleanupErrors("winding failed to submit a paced Wayland frame", errors);
      throw error;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    this.#lifecycle.close(() => {
      const errors: unknown[] = [];
      this.#cleanup(errors);
      throwCleanupErrors("winding failed to close Wayland window", errors);
    });
  }

  #abandonUnconfiguredInitialDecoration(): void {
    if (this.#decorationLifecycle.canAttachInitialBuffer) return;
    this.#cleanupDecoration([]);
  }

  #cleanupFractionalScale(errors: unknown[]): boolean {
    const symbols = this.lib.wl.symbols;
    const destroyed = this.#fractionalScaleOwnership.cleanup({
      destroyViewport: (proxy) => {
        symbols.wl_proxy_marshal_array_flags(
          proxy,
          WlOp.WP_VIEWPORT_DESTROY,
          null,
          symbols.wl_proxy_get_version(proxy),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      },
      destroyFractionalScale: (proxy) => {
        symbols.wl_proxy_marshal_array_flags(
          proxy,
          WlOp.WP_FRACTIONAL_SCALE_DESTROY,
          null,
          symbols.wl_proxy_get_version(proxy),
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      },
      closeCallback: (callback) => callback.close(),
      retainCallback: (callback) => this.lib.retainNativeCallbackRoot(callback),
      releaseCallback: (callback) => this.lib.releaseNativeCallbackRoot(callback),
      retainOwnershipRoot: (root) => this.lib.retainNativeResourceRoot(root),
      releaseOwnershipRoot: (root) => this.lib.releaseNativeResourceRoot(root),
      reportError: (error) => errors.push(error),
    });

    const generation = this.#fractionalScaleGeneration;
    if (destroyed) {
      this.#fractionalScaleGeneration = undefined;
      if (generation !== undefined) this.#fractionalScaleLifecycle.finish(generation);
      return true;
    }

    if (generation !== undefined) this.#fractionalScaleLifecycle.disable(generation);
    return false;
  }

  #cleanupDecoration(errors: unknown[]): boolean {
    const decoration = this.#decoration;
    const configure = this.#decorationConfigure;
    if (decoration) {
      const destroyed = tryDestroyWaylandDecoration(
        () => {
          this.lib.wl.symbols.wl_proxy_marshal_array_flags(
            decoration,
            WlOp.ZXDG_TOPLEVEL_DECORATION_DESTROY,
            null,
            this.lib.wl.symbols.wl_proxy_get_version(decoration),
            WL_MARSHAL_FLAG_DESTROY,
            args(),
          );
        },
        () => {
          if (configure) this.lib.retainNativeCallbackRoot(configure);
          this.lib.retainNativeResourceRoot(this);
        },
        (error) => errors.push(error),
      );
      if (!destroyed) return false;
    }
    this.#decoration = null;
    const generation = this.#decorationGeneration;
    this.#decorationGeneration = undefined;
    if (generation !== undefined) this.#decorationLifecycle.finish(generation);
    this.#decorationConfigure = null;
    this.#decorationVtable = undefined;
    if (configure) {
      this.lib.releaseNativeCallbackRoot(configure);
      collectCleanupError(errors, () => configure.close());
    }
    this.lib.releaseNativeResourceRoot(this);
    return true;
  }

  #cleanup(errors: unknown[]): void {
    const surface = this.#surface;
    const symbols = this.lib.wl.symbols;
    teardownWaylandWindowNativeGraphInOrder(
      () => {
        this.#deferredFrameRetry.close();
        this.#queuedFrameDone = undefined;
        this.#pendingFrames.close();
        this.#frameCallbacks.close(this.#frameCallbackActions(errors));
      },
      () =>
        teardownWaylandWindowChildrenAfterUnregister(
          this.#registered,
          () => {
            this.#registered = false;
          },
          () => {
            if (!surface) throw new Error("winding lost a registered Wayland surface during cleanup");
            this.lib.unregisterWindow(surface, this);
          },
          () =>
            teardownWaylandOptionalWindowChildren(
              () => this.#cleanupDecoration(errors),
              () => this.#cleanupFractionalScale(errors),
            ),
          (error) => errors.push(error),
        ),
      () => {
        collectCleanupError(errors, () => this.#shmBuffer.close());
        const toplevel = this.#xdgToplevel;
        this.#xdgToplevel = null;
        if (toplevel) {
          collectCleanupError(errors, () => {
            symbols.wl_proxy_marshal_array_flags(
              toplevel,
              WlOp.XDG_TOPLEVEL_DESTROY,
              null,
              1,
              WL_MARSHAL_FLAG_DESTROY,
              args(),
            );
          });
        }
        const xdgSurface = this.#xdgSurface;
        this.#xdgSurface = null;
        if (xdgSurface) {
          collectCleanupError(errors, () => {
            symbols.wl_proxy_marshal_array_flags(
              xdgSurface,
              WlOp.XDG_SURFACE_DESTROY,
              null,
              1,
              WL_MARSHAL_FLAG_DESTROY,
              args(),
            );
          });
        }
      },
      () => {
        const surfaceCallbacks = [this.#surfaceEnter, this.#surfaceLeave, this.#surfacePreferredScale].filter(
          (callback): callback is AnyCallback => callback !== null,
        );
        let surfaceDestroyed = surface === null;
        if (surface) {
          surfaceDestroyed = tryDestroyWaylandSurfaceWithListeners(
            surface,
            surfaceCallbacks,
            this,
            (proxy) => {
              symbols.wl_proxy_marshal_array_flags(
                proxy,
                WlOp.SURFACE_DESTROY,
                null,
                1,
                WL_MARSHAL_FLAG_DESTROY,
                args(),
              );
            },
            (callback) => this.lib.retainNativeCallbackRoot(callback),
            (owner) => this.lib.retainNativeResourceRoot(owner),
            (error) => errors.push(error),
          );
          if (surfaceDestroyed) this.#surface = null;
        }
        if (surfaceDestroyed) {
          for (const callback of surfaceCallbacks) collectCleanupError(errors, () => callback.close());
          this.#surfaceEnter = null;
          this.#surfaceLeave = null;
          this.#surfacePreferredScale = null;
          this.#wlSurfaceVtable = undefined;
          this.#surfaceOutputScale = undefined;
        }
        for (const callback of [this.#xdgSurfaceConfigure, this.#toplevelConfigure, this.#toplevelClose]) {
          if (callback) collectCleanupError(errors, () => callback.close());
        }
        this.#xdgSurfaceConfigure = null;
        this.#toplevelConfigure = null;
        this.#toplevelClose = null;
        this.#surfaceVtable = undefined;
        this.#toplevelVtable = undefined;
      },
    );
  }
}
