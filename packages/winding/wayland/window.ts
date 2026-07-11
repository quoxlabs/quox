import type { Window } from "../types.ts";
import { CompositionState, ImeActivationState, type ImeCursorArea, normalizeImeCursorArea } from "../input/mod.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp } from "./ffi.ts";
import { createWaylandSurroundingTextState, type WaylandSurroundingTextState } from "./text_input.ts";
import {
  type AnyCallback,
  args,
  collectCleanupError,
  hasXdgToplevelState,
  makeVtable,
  type NativeCallbackHost,
  SUSPENDED_TOPLEVEL_STATE,
  throwCleanupErrors,
  WL_MARSHAL_FLAG_DESTROY,
  XDG_SURFACE_EVENT_SIGNATURES,
  XDG_TOPLEVEL_DECORATION_EVENT_SIGNATURES,
  XDG_TOPLEVEL_EVENT_SIGNATURES,
} from "./protocol.ts";
import { createOpaqueBlackFrame, WaylandShmBuffer, type WaylandShmHost } from "./shm_buffer.ts";
import {
  setupServerSideDecorationBeforeInitialCommit,
  tryDestroyWaylandDecoration,
  type WaylandDecorationGeneration,
  WaylandDecorationLifecycle,
  type WaylandDecorationManagerBinding,
  WaylandDecorationMode,
} from "./decoration.ts";

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

export interface WaylandConfiguration {
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  readonly suspended: boolean;
  readonly frameToken: number;
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
  return width === configuration.width &&
    height === configuration.height &&
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
        suspended: this.#suspended,
        frameToken: this.#nextFrameToken,
      },
      visibilityChanged: previousSuspended !== this.#suspended,
    };
  }
}

export interface WaylandWindowHost extends NativeCallbackHost, WaylandShmHost {
  readonly compositor: Deno.PointerObject | null;
  readonly xdgWmBase: Deno.PointerObject | null;
  readonly xdgSurfaceIface: Deno.PointerObject;
  readonly xdgToplevelIface: Deno.PointerObject;
  readonly zxdgToplevelDecorationIface: Deno.PointerObject;
  readonly decorationManager: WaylandDecorationManagerBinding<Deno.PointerObject> | undefined;
  readonly ifaces: {
    readonly surface: Deno.PointerObject;
    readonly shmPool: Deno.PointerObject;
    readonly buffer: Deno.PointerObject;
  };
  registerWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  unregisterWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  updateWindowImeState(window: WaylandWindow): void;
  updateWindowImeCursorArea(window: WaylandWindow): void;
  updateWindowImeSurroundingText(window: WaylandWindow): void;
  throwCallbackError(): void;
  roundtripDisplay(context: string): void;
  flushDisplay(context: string): void;
  retainNativeCallbackRoot(callback: AnyCallback): void;
  releaseNativeCallbackRoot(callback: AnyCallback): void;
  retainNativeResourceRoot(resource: object): void;
  releaseNativeResourceRoot(resource: object): void;
}

export class WaylandWindow implements Window {
  #surface: Deno.PointerObject | null = null;
  #xdgSurface: Deno.PointerObject | null = null;
  #xdgToplevel: Deno.PointerObject | null = null;
  #surfaceVtable: BigUint64Array<ArrayBuffer> | undefined;
  #toplevelVtable: BigUint64Array<ArrayBuffer> | undefined;
  #xdgSurfaceConfigure: AnyCallback | null = null;
  #toplevelConfigure: AnyCallback | null = null;
  #toplevelClose: AnyCallback | null = null;
  #decoration: Deno.PointerObject | null = null;
  #decorationGeneration: WaylandDecorationGeneration | undefined;
  #decorationConfigure: AnyCallback | null = null;
  #decorationVtable: BigUint64Array<ArrayBuffer> | undefined;
  readonly #decorationLifecycle = new WaylandDecorationLifecycle();
  readonly #shmBuffer: WaylandShmBuffer;
  readonly #configureState: WaylandConfigureState;
  #configuration: WaylandConfiguration | undefined;
  #acknowledgedFrameToken: number | undefined;
  #registered = false;
  #closed = false;
  readonly imeActivation = new ImeActivationState();
  readonly composition = new CompositionState();
  #imeCursorArea: ImeCursorArea | undefined;
  #imeSurroundingText: WaylandSurroundingTextState | undefined;

  constructor(readonly lib: WaylandWindowHost, width: number, height: number) {
    this.#shmBuffer = new WaylandShmBuffer(lib);
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
      this.#present(
        createOpaqueBlackFrame(configuration.width, configuration.height),
        configuration.width,
        configuration.height,
        configuration,
      );
      return;
    } catch (error) {
      errors.push(error);
    }
    this.#closed = true;
    this.#cleanup(errors);
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
    if (this.#closed || !this.#xdgToplevel || this.#decoration) return;
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
          this.#decorationLifecycle.configure(generation, mode);
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

  #setupListeners(): void {
    const symbols = this.lib.wl.symbols;
    this.#xdgSurfaceConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.lib.guardCallback((_data, _surface, serial) => {
        const completed = this.#configureState.complete(serial);
        this.#configuration = completed.configuration;
        this.lib.pushEvent({
          type: "resize",
          width: completed.configuration.width,
          height: completed.configuration.height,
          framebufferWidth: completed.configuration.width,
          framebufferHeight: completed.configuration.height,
          devicePixelRatio: 1,
          frameToken: completed.configuration.frameToken,
          window: this,
        });
        if (completed.visibilityChanged) {
          this.lib.pushEvent({
            type: "visibilitychange",
            visible: !completed.configuration.suspended,
            window: this,
          });
        }
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
        const suspended = hasXdgToplevelState(states, SUSPENDED_TOPLEVEL_STATE);
        this.#configureState.stageToplevel(width, height, suspended);
      }),
    );
    this.#toplevelClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      this.lib.guardCallback(() => this.lib.pushEvent({ type: "close", window: this })),
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
    if (!this.#xdgSurface || this.#acknowledgedFrameToken === configuration.frameToken) return;
    const symbols = this.lib.wl.symbols;
    symbols.wl_proxy_marshal_array_flags(
      this.#xdgSurface,
      WlOp.XDG_SURFACE_ACK_CONFIGURE,
      null,
      symbols.wl_proxy_get_version(this.#xdgSurface),
      0,
      args(BigInt(configuration.serial)),
    );
    this.#acknowledgedFrameToken = configuration.frameToken;
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
    this.lib.throwIfConnectionFailed();
    if (!this.#xdgToplevel || this.#closed) return;
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
  }

  setImeEnabled(enabled: boolean): void {
    this.lib.throwIfConnectionFailed();
    if (this.#closed || this.imeActivation.desired === enabled) return;
    this.imeActivation.setDesired(enabled);
    this.lib.updateWindowImeState(this);
  }

  setImeCursorArea(x: number, y: number, width: number, height: number): void {
    this.lib.throwIfConnectionFailed();
    if (this.#closed) return;
    const area = normalizeImeCursorArea(x, y, width, height);
    if (area === undefined) return;
    this.#imeCursorArea = area;
    this.lib.updateWindowImeCursorArea(this);
  }

  setImeSurroundingText(text: string, selectionStartBytes: number, selectionEndBytes: number): void {
    this.lib.throwIfConnectionFailed();
    if (this.#closed) return;
    this.#imeSurroundingText = createWaylandSurroundingTextState(
      text,
      selectionStartBytes,
      selectionEndBytes,
    );
    this.lib.updateWindowImeSurroundingText(this);
  }

  blit(rgba: Uint8Array, width: number, height: number, frameToken?: number): void {
    this.lib.throwIfConnectionFailed();
    if (this.#closed || !this.#surface) return;
    const configuration = this.#configuration;
    if (!configuration || !frameMatchesConfiguration(configuration, width, height, frameToken)) return;
    this.#present(rgba, width, height, configuration);
  }

  #present(rgba: Uint8Array, width: number, height: number, configuration: WaylandConfiguration): void {
    if (!this.#surface) return;
    if (!this.#decorationLifecycle.canAttachInitialBuffer) {
      this.#abandonUnconfiguredInitialDecoration();
      if (!this.#decorationLifecycle.canAttachInitialBuffer) return;
    }
    const attachment = this.#shmBuffer.write(rgba, width, height);
    if (!attachment) return;
    this.#ackConfiguration(configuration);
    const symbols = this.lib.wl.symbols;
    const version = symbols.wl_proxy_get_version(this.#surface);
    symbols.wl_proxy_marshal_array_flags(
      this.#surface,
      WlOp.SURFACE_ATTACH,
      null,
      version,
      0,
      args(Deno.UnsafePointer.value(attachment.buffer), 0n, 0n),
    );
    symbols.wl_proxy_marshal_array_flags(
      this.#surface,
      damageOpcodeForSurfaceVersion(version),
      null,
      version,
      0,
      args(0n, 0n, BigInt(attachment.layout.width), BigInt(attachment.layout.height)),
    );
    symbols.wl_proxy_marshal_array_flags(
      this.#surface,
      WlOp.SURFACE_COMMIT,
      null,
      version,
      0,
      args(),
    );
    this.#decorationLifecycle.markBufferCommit();
    this.lib.flushDisplay("presenting a window frame");
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    this.#cleanup(errors);
    throwCleanupErrors("winding failed to close Wayland window", errors);
  }

  #abandonUnconfiguredInitialDecoration(): void {
    if (this.#decorationLifecycle.canAttachInitialBuffer) return;
    this.#cleanupDecoration([]);
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
    if (!this.#cleanupDecoration(errors)) return;
    const surface = this.#surface;
    if (surface && this.#registered) {
      this.#registered = false;
      collectCleanupError(errors, () => this.lib.unregisterWindow(surface, this));
    }
    collectCleanupError(errors, () => this.#shmBuffer.close());
    const symbols = this.lib.wl.symbols;
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
    this.#surface = null;
    if (surface) {
      collectCleanupError(errors, () => {
        symbols.wl_proxy_marshal_array_flags(
          surface,
          WlOp.SURFACE_DESTROY,
          null,
          1,
          WL_MARSHAL_FLAG_DESTROY,
          args(),
        );
      });
    }
    for (const callback of [this.#xdgSurfaceConfigure, this.#toplevelConfigure, this.#toplevelClose]) {
      if (callback) collectCleanupError(errors, () => callback.close());
    }
    this.#xdgSurfaceConfigure = null;
    this.#toplevelConfigure = null;
    this.#toplevelClose = null;
    this.#surfaceVtable = undefined;
    this.#toplevelVtable = undefined;
  }
}
