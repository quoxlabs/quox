export const x11functions = {
  XOpenDisplay: { parameters: ["usize"], result: "pointer" },
  XCloseDisplay: { parameters: ["pointer"], result: "void" },
  XDefaultScreenOfDisplay: { parameters: ["pointer"], result: "pointer" },
  XMapWindow: { parameters: ["pointer", "usize"], result: "void" },
  XFlush: { parameters: ["pointer"], result: "void" },
  XPending: { parameters: ["pointer"], result: "i32" },
  XSelectInput: { parameters: ["pointer", "usize", "u64"], result: "void" },
  XNextEvent: { parameters: ["pointer", "pointer"], result: "void" },
  XDefaultVisual: { parameters: ["pointer", "i32"], result: "pointer" },
  XCreateSimpleWindow: {
    parameters: ["pointer", "usize", "i32", "i32", "u32", "u32", "u32", "u64", "u64"],
    result: "usize",
  },
  XCreateGC: { parameters: ["pointer", "usize", "u32", "usize"], result: "usize" },
  XCreateImage: {
    parameters: ["pointer", "pointer", "u32", "i32", "i32", "buffer", "u32", "u32", "i32", "i32"],
    result: "pointer",
  },
  XPutImage: {
    parameters: ["pointer", "usize", "usize", "pointer", "i32", "i32", "i32", "i32", "u32", "u32"],
    result: "i32",
  },
  XInternAtom: { parameters: ["pointer", "buffer", "i32"], result: "usize" },
  XSetWMProtocols: { parameters: ["pointer", "usize", "buffer", "i32"], result: "i32" },
  XChangeWindowAttributes: {
    parameters: ["pointer", "usize", "u64", "buffer"],
    result: "i32",
  },
} as const satisfies Deno.ForeignLibraryInterface;
