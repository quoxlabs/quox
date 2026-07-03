import { assertEquals } from "@std/assert";
import { createVNode, Fragment, isQuoxVNode, type QuoxComponent, serializeQuoxStyle } from "./jsx-runtime.ts";

Deno.test("createVNode stores type, props, children, and key", () => {
  const vnode = createVNode("h1", { id: "title", children: "Hello" }, "main");

  assertEquals(isQuoxVNode(vnode), true);
  assertEquals(vnode.type, "h1");
  assertEquals(vnode.props, { id: "title" });
  assertEquals(vnode.children, "Hello");
  assertEquals(vnode.key, "main");
});

Deno.test("Fragment is available as a VNode type", () => {
  const vnode = createVNode(Fragment, { children: ["a", null, false, "b"] }, undefined);

  assertEquals(vnode.type, Fragment);
  assertEquals(vnode.children, ["a", null, false, "b"]);
});

Deno.test("serializeQuoxStyle preserves custom properties and kebab-cases normal properties", () => {
  assertEquals(
    serializeQuoxStyle({
      "--accent": "red",
      backgroundColor: "var(--accent)",
      width: 100,
      WebkitLineClamp: 2,
      display: null,
    }),
    "--accent:red;background-color:var(--accent);width:100;-webkit-line-clamp:2",
  );
});

Deno.test("QuoxComponent accepts an async implementation", () => {
  const AsyncComponent: QuoxComponent = async () => {
    await Promise.resolve();
    return createVNode("p", null);
  };

  assertEquals(typeof AsyncComponent, "function");
});
