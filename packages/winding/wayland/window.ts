import type { Window } from "../types.ts";
import { utf8CString as cStr } from "../text_encoding.ts";
import { WlOp } from "./ffi.ts";
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
} from "./protocol.ts";

export interface WaylandWindowHost extends NativeCallbackHost {
  readonly display: Deno.PointerObject;
  readonly compositor: Deno.PointerObject | null;
  readonly xdgWmBase: Deno.PointerObject | null;
  readonly xdgSurfaceIface: Deno.PointerObject;
  readonly xdgToplevelIface: Deno.PointerObject;
  readonly ifaces: {
    readonly surface: Deno.PointerObject;
  };
  readonly noop: AnyCallback;
  registerWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  unregisterWindow(surface: Deno.PointerObject, window: WaylandWindow): void;
  throwCallbackError(): void;
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
  #width: number;
  #height: number;
  #windowSurface: Deno.UnsafeWindowSurface | null = null;
  #pendingSerial = 0;
  #suspended = false;
  #registered = false;
  #closed = false;

  constructor(readonly lib: WaylandWindowHost, width: number, height: number) {
    this.#width = width;
    this.#height = height;
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
      symbols.wl_proxy_marshal_array_flags(
        this.#surface,
        WlOp.SURFACE_COMMIT,
        null,
        symbols.wl_proxy_get_version(this.#surface),
        0,
        args(),
      );
      symbols.wl_display_roundtrip(lib.display);
      lib.throwCallbackError();
      this.#ackPendingConfigure();
      return;
    } catch (error) {
      errors.push(error);
    }
    this.#closed = true;
    this.#cleanup(errors);
    throwCleanupErrors("winding failed to create Wayland window", errors);
  }

  #setupListeners(): void {
    const symbols = this.lib.wl.symbols;
    this.#xdgSurfaceConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "u32"], result: "void" },
      this.lib.guardCallback((_data, _surface, serial) => {
        this.#pendingSerial = serial;
        this.#ackPendingConfigure();
      }),
    );
    this.#surfaceVtable = makeVtable([this.#xdgSurfaceConfigure], 1, this.lib.noop);
    symbols.wl_proxy_add_listener(
      this.#xdgSurface!,
      Deno.UnsafePointer.of(this.#surfaceVtable),
      null,
    );

    this.#toplevelConfigure = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer", "i32", "i32", "pointer"], result: "void" },
      this.lib.guardCallback((_data, _toplevel, width, height, states) => {
        if (width > 0 && height > 0) {
          this.#width = width;
          this.#height = height;
          this.lib.pushEvent({ type: "resize", width, height, window: this });
        }
        const suspended = hasXdgToplevelState(states, SUSPENDED_TOPLEVEL_STATE);
        if (suspended !== this.#suspended) {
          this.#suspended = suspended;
          this.lib.pushEvent({ type: "visibilitychange", visible: !suspended, window: this });
        }
      }),
    );
    this.#toplevelClose = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      this.lib.guardCallback(() => this.lib.pushEvent({ type: "close", window: this })),
    );
    this.#toplevelVtable = makeVtable(
      [this.#toplevelConfigure, this.#toplevelClose],
      4,
      this.lib.noop,
    );
    symbols.wl_proxy_add_listener(
      this.#xdgToplevel!,
      Deno.UnsafePointer.of(this.#toplevelVtable),
      null,
    );
  }

  #ackPendingConfigure(): void {
    if (this.#pendingSerial === 0 || !this.#xdgSurface) return;
    const symbols = this.lib.wl.symbols;
    symbols.wl_proxy_marshal_array_flags(
      this.#xdgSurface,
      WlOp.XDG_SURFACE_ACK_CONFIGURE,
      null,
      symbols.wl_proxy_get_version(this.#xdgSurface),
      0,
      args(BigInt(this.#pendingSerial)),
    );
    this.#pendingSerial = 0;
  }

  setTitle(title: string): void {
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
    symbols.wl_display_flush(this.lib.display);
  }

  windowSurface(): Deno.UnsafeWindowSurface {
    if (this.#closed || !this.#surface) throw new Error("winding Wayland window is closed");
    this.#ackPendingConfigure();
    this.#windowSurface ??= new Deno.UnsafeWindowSurface({
      system: "wayland",
      windowHandle: this.#surface,
      displayHandle: this.lib.display,
      width: this.#width,
      height: this.#height,
    });
    return this.#windowSurface;
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

  #cleanup(errors: unknown[]): void {
    const surface = this.#surface;
    if (surface && this.#registered) {
      this.#registered = false;
      collectCleanupError(errors, () => this.lib.unregisterWindow(surface, this));
    }
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
