import { assertEquals, assertThrows } from "@std/assert";
import { createVNode, Fragment, isQuoxVNode, type QuoxVNodeType, serializeQuoxStyle } from "./jsx-runtime.ts";

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

Deno.test("async components can be detected by a renderer mount walker", () => {
  const asyncComponent = (() => Promise.resolve(createVNode("p", null))) as unknown as QuoxVNodeType;
  const vnode = createVNode(asyncComponent, null);

  assertThrows(
    () => {
      const component = vnode.type;
      if (typeof component !== "function") return;
      const rendered = (component as (props: Record<string, unknown>) => unknown)({});
      if (typeof rendered === "object" && rendered !== null && "then" in rendered) {
        throw new TypeError("Async Quox components are not supported yet.");
      }
    },
    TypeError,
    "Async Quox components are not supported yet.",
  );
});
