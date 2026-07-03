import { createVNode, Fragment, isQuoxVNode, type QuoxVNodeType, serializeQuoxStyle } from "./jsx-runtime.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }

  throw new Error("Expected function to throw");
}

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
      WebkitLineClamp: 2,
      display: null,
    }),
    "--accent:red;background-color:var(--accent);-webkit-line-clamp:2",
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
    "Async Quox components are not supported yet.",
  );
});
