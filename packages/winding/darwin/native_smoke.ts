import type { Library, UIEvent, Window } from "../types.ts";
import { cStr, getClass, LIBOBJC, makeNSRange, NS_NOT_FOUND, NSRANGE, runtimeSymbols, sel } from "./ffi.ts";
import { load } from "./mod.ts";

interface NativeDarwinWindow extends Window {
  readonly contentView: Deno.PointerValue;
}

Deno.test({
  name: "Darwin raw text and AppKit commands use commit-only callbacks",
  ignore: Deno.build.os !== "darwin",
  permissions: { ffi: true },
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = Deno.dlopen(LIBOBJC, runtimeSymbols);
    const sendId = Deno.dlopen(LIBOBJC, {
      objc_msgSend: { parameters: ["pointer", "pointer"], result: "pointer" },
    });
    const sendIdBuffer = Deno.dlopen(LIBOBJC, {
      objc_msgSend: { parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
    });
    const sendVoid = Deno.dlopen(LIBOBJC, {
      objc_msgSend: { parameters: ["pointer", "pointer"], result: "void" },
    });
    const sendInsert = Deno.dlopen(LIBOBJC, {
      objc_msgSend: { parameters: ["pointer", "pointer", "pointer", NSRANGE], result: "void" },
    });
    const sendCommand = Deno.dlopen(LIBOBJC, {
      objc_msgSend: { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    });
    const library = load();
    try {
      const window = library.openWindow(0, 0, 64, 48) as NativeDarwinWindow;
      drainEvents(library);
      const allocation = sendId.symbols.objc_msgSend(getClass(runtime, "NSString"), sel(runtime, "alloc"));
      const text = sendIdBuffer.symbols.objc_msgSend(
        allocation,
        sel(runtime, "initWithUTF8String:"),
        cStr("ä"),
      );
      if (text === null) throw new Error("failed to create NSString");
      try {
        sendInsert.symbols.objc_msgSend(
          window.contentView,
          sel(runtime, "insertText:replacementRange:"),
          text,
          makeNSRange(NS_NOT_FOUND, 0n),
        );
        const committed = nextEvent(library, (event) => event.type === "textinput");
        if (committed?.type !== "textinput" || committed.text !== "ä") {
          throw new Error("expected Darwin committed text");
        }

        sendCommand.symbols.objc_msgSend(
          window.contentView,
          sel(runtime, "doCommandBySelector:"),
          sel(runtime, "deleteBackward:"),
        );
        const command = nextEvent(library, (event) => event.type === "apple-standard-keybinding");
        if (command?.type !== "apple-standard-keybinding" || command.command !== "deleteBackward:") {
          throw new Error("expected Darwin AppKit editing command");
        }

        if (!window.fullscreenEnabled) throw new Error("Expected AppKit fullscreen support");
        window.setFullscreen(true);
        const entered = await waitForEvent(library, (event) => event.type === "fullscreenchange");
        if (entered?.type !== "fullscreenchange" || !entered.fullscreen) {
          throw new Error("Expected AppKit fullscreen entry confirmation");
        }
        window.setFullscreen(false);
        const exited = await waitForEvent(library, (event) => event.type === "fullscreenchange");
        if (exited?.type !== "fullscreenchange" || exited.fullscreen) {
          throw new Error("Expected AppKit fullscreen exit confirmation");
        }
      } finally {
        sendVoid.symbols.objc_msgSend(text, sel(runtime, "release"));
        window.close();
      }
    } finally {
      library.close();
      sendCommand.close();
      sendInsert.close();
      sendVoid.close();
      sendIdBuffer.close();
      sendId.close();
      runtime.close();
    }
  },
});

function drainEvents(library: Library): void {
  for (let count = 0; count < 64 && library.event() !== undefined; count++);
}

function nextEvent(library: Library, predicate: (event: UIEvent) => boolean): UIEvent | undefined {
  for (let count = 0; count < 64; count++) {
    const event = library.event();
    if (event === undefined) return undefined;
    if (predicate(event)) return event;
  }
  throw new Error("Darwin smoke test exceeded its event limit");
}

async function waitForEvent(library: Library, predicate: (event: UIEvent) => boolean): Promise<UIEvent | undefined> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = nextEvent(library, predicate);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}
