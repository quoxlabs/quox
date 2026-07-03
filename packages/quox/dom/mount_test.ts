import { createVNode, Fragment, type QuoxRenderable, type QuoxVNodeType } from "@quoxlabs/jsx";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { getElementFunctionProps } from "./handlers.ts";
import { mount } from "./mount.ts";
import { QuoxElement } from "./node.ts";

type Operation =
  | { type: "create_element"; id: number; tagName: string }
  | { type: "create_text_node"; id: number; text: string }
  | { type: "append_child"; parentId: number; childId: number }
  | { type: "set_attribute"; nodeId: number; name: string; value: string };

class FakeRenderer {
  readonly operations: Operation[] = [];
  #nextNodeId = 1;
  readonly #text = new Map<number, string>();
  #title = "";

  create_element(tagName: string): number {
    const id = this.#nextNodeId++;
    this.operations.push({ type: "create_element", id, tagName });
    return id;
  }

  create_text_node(text: string): number {
    const id = this.#nextNodeId++;
    this.#text.set(id, text);
    this.operations.push({ type: "create_text_node", id, text });
    return id;
  }

  append_child(parentId: number, childId: number): void {
    this.operations.push({ type: "append_child", parentId, childId });
  }

  set_attribute(nodeId: number, name: string, value: string): void {
    this.operations.push({ type: "set_attribute", nodeId, name, value });
  }

  text_content(nodeId: number): string {
    return this.#text.get(nodeId) ?? "";
  }

  title(): string {
    return this.#title;
  }

  set_title(value: string): void {
    this.#title = value;
  }

  set_text_content(nodeId: number, value: string): void {
    this.#text.set(nodeId, value);
  }

  remove_node(nodeId: number): void {
    void nodeId;
  }

  set_inner_html(nodeId: number, html: string): void {
    void nodeId;
    void html;
  }

  document_element(): number {
    return 0;
  }

  head(): number {
    return 0;
  }

  body(): number {
    return 0;
  }

  remove_attribute(nodeId: number, name: string): void {
    void nodeId;
    void name;
  }
}

function createTestDocument(setNativeTitle?: (title: string) => void): {
  document: QuoxDocument;
  renderer: FakeRenderer;
  root: QuoxElement;
} {
  const renderer = new FakeRenderer();
  const noop = () => undefined;
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    noop,
    noop,
    setNativeTitle,
  );

  return {
    document,
    renderer,
    root: new QuoxElement(document, 0),
  };
}

Deno.test("document.title reads and writes the renderer title", () => {
  const nativeTitles: string[] = [];
  let renderCount = 0;
  const renderer = new FakeRenderer();
  const document = new QuoxDocument(
    renderer as unknown as WasmRenderer,
    () => {
      renderCount += 1;
    },
    () => undefined,
    (title) => nativeTitles.push(title),
  );

  assertEquals(document.title, "");

  document.title = "Quox Notes";

  assertEquals(document.title, "Quox Notes");
  assertEquals(renderer.title(), "Quox Notes");
  assertEquals(nativeTitles, ["Quox Notes"]);
  assertEquals(renderCount, 1);
});

Deno.test("document.title reads live renderer state without side effects", () => {
  const nativeTitles: string[] = [];
  const { document, renderer } = createTestDocument((title) => nativeTitles.push(title));

  renderer.set_title("Changed elsewhere");

  assertEquals(document.title, "Changed elsewhere");
  assertEquals(nativeTitles, []);
});

Deno.test("syncNativeTitle pushes title changes made via generic DOM mutation", () => {
  const nativeTitles: string[] = [];
  const { document, renderer } = createTestDocument((title) => nativeTitles.push(title));

  renderer.set_title("Changed elsewhere");
  document.syncNativeTitle();

  assertEquals(nativeTitles, ["Changed elsewhere"]);

  document.syncNativeTitle();
  assertEquals(nativeTitles, ["Changed elsewhere"]);
});

Deno.test("mount walks fragments, function components, and nested arrays", async () => {
  const { renderer, root } = createTestDocument();
  const Leaf = (props: { label: string; children?: QuoxRenderable }) =>
    createVNode("span", {
      className: "leaf",
      children: [props.label, props.children],
    });

  await mount(
    root,
    createVNode(Fragment, {
      children: [
        createVNode("h1", { children: "Hi" }),
        [
          null,
          false,
          "loose",
          createVNode(Leaf as unknown as QuoxVNodeType, {
            label: "Leaf",
            children: [" child", 7],
          }),
        ],
      ],
    }),
  );

  // Siblings resolve concurrently, so independent subtrees' low-level operations interleave
  // (here, the "loose" text node is created before "Hi" gets appended into <h1>) even though
  // final document order (the append_child calls onto `root` at the end) is unaffected.
  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "h1" },
    { type: "create_text_node", id: 2, text: "Hi" },
    { type: "create_text_node", id: 3, text: "loose" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "create_element", id: 4, tagName: "span" },
    { type: "set_attribute", nodeId: 4, name: "class", value: "leaf" },
    { type: "create_text_node", id: 5, text: "Leaf" },
    { type: "create_text_node", id: 6, text: " child" },
    { type: "create_text_node", id: 7, text: "7" },
    { type: "append_child", parentId: 4, childId: 5 },
    { type: "append_child", parentId: 4, childId: 6 },
    { type: "append_child", parentId: 4, childId: 7 },
    { type: "append_child", parentId: 0, childId: 1 },
    { type: "append_child", parentId: 0, childId: 3 },
    { type: "append_child", parentId: 0, childId: 4 },
  ]);
});

Deno.test("mount lowers props and stores function-valued DOM props", async () => {
  const { renderer, root } = createTestDocument();
  const onClick = () => "clicked";
  const [node] = await mount(
    root,
    createVNode("label", {
      className: "cta",
      htmlFor: "target-input",
      hidden: true,
      disabled: false,
      onClick,
      style: {
        "--accent": "red",
        backgroundColor: "var(--accent)",
        width: 100,
        opacity: 0,
        ignored: false,
      },
      children: "Go",
    }),
  );

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "label" },
    { type: "set_attribute", nodeId: 1, name: "class", value: "cta" },
    { type: "set_attribute", nodeId: 1, name: "for", value: "target-input" },
    { type: "set_attribute", nodeId: 1, name: "hidden", value: "" },
    {
      type: "set_attribute",
      nodeId: 1,
      name: "style",
      value: "--accent:red;background-color:var(--accent);width:100;opacity:0",
    },
    { type: "create_text_node", id: 2, text: "Go" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "append_child", parentId: 0, childId: 1 },
  ]);
  assert(getElementFunctionProps(node as QuoxElement)?.get("onClick") === onClick, "onClick was not stored");
});

Deno.test("mount kebab-cases vendor-prefixed style properties", async () => {
  const { renderer, root } = createTestDocument();

  await mount(
    root,
    createVNode("div", {
      style: { WebkitLineClamp: 2, display: null },
    }),
  );

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "div" },
    { type: "set_attribute", nodeId: 1, name: "style", value: "-webkit-line-clamp:2" },
    { type: "append_child", parentId: 0, childId: 1 },
  ]);
});

Deno.test("mount rejects unsupported object attributes", async () => {
  const { root } = createTestDocument();

  await assertRejects(
    () => mount(root, createVNode("div", { value: { nested: true } })),
    TypeError,
    'Cannot set object value as "value" attribute.',
  );
});

Deno.test("mount awaits async function components", async () => {
  const { renderer, root } = createTestDocument();
  const AsyncComponent = (() => Promise.resolve(createVNode("p", { children: "hi" }))) as unknown as QuoxVNodeType;

  await mount(root, createVNode(AsyncComponent, null));

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "p" },
    { type: "create_text_node", id: 2, text: "hi" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "append_child", parentId: 0, childId: 1 },
  ]);
});

Deno.test("mount preserves source order when concurrent async siblings resolve out of order", async () => {
  const { root } = createTestDocument();
  let resolveFirst!: (v: unknown) => void;
  let resolveSecond!: (v: unknown) => void;
  const First = (() =>
    new Promise((resolve) => {
      resolveFirst = resolve;
    })) as unknown as QuoxVNodeType;
  const Second = (() =>
    new Promise((resolve) => {
      resolveSecond = resolve;
    })) as unknown as QuoxVNodeType;

  const pending = mount(root, [
    createVNode(First, null),
    createVNode(Second, null),
  ]);

  // Resolve out of source order: since both siblings start concurrently, resolving Second
  // first proves the *result* order still matches source order, not resolution order.
  resolveSecond("second");
  resolveFirst("first");

  const nodes = await pending;

  assertEquals(nodes.map((node) => node.textContent), ["first", "second"]);
});

Deno.test("mount propagates rejection from an async function component", async () => {
  const { root } = createTestDocument();
  const Failing = (() => Promise.reject(new Error("boom"))) as unknown as QuoxVNodeType;

  await assertRejects(
    () => mount(root, createVNode(Failing, null)),
    Error,
    "boom",
  );
});

Deno.test("mount propagates a synchronous throw from a function component as a rejection", async () => {
  const { root } = createTestDocument();
  const Throws = (() => {
    throw new Error("sync boom");
  }) as unknown as QuoxVNodeType;

  await assertRejects(
    () => mount(root, createVNode(Throws, null)),
    Error,
    "sync boom",
  );
});

// A plain object shaped like a Preact vnode: `type`, `props`, and `constructor: undefined`
// (Preact's own anti-forgery marker). No `preact` import is used anywhere in this test.
function createPreactLikeVNode(
  type: string | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
): object {
  return Object.assign(Object.create(null), { type, props, key: null, ref: null });
}

Deno.test("mount recognizes duck-typed Preact-shaped vnodes", async () => {
  const { renderer, root } = createTestDocument();

  await mount(
    root,
    createPreactLikeVNode("h1", { className: "title", children: "Hi" }),
  );

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "h1" },
    { type: "set_attribute", nodeId: 1, name: "class", value: "title" },
    { type: "create_text_node", id: 2, text: "Hi" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "append_child", parentId: 0, childId: 1 },
  ]);
});

Deno.test("mount resolves Preact-shaped fragments and function components without special-casing", async () => {
  const { renderer, root } = createTestDocument();
  const PreactFragment = (props: { children?: unknown }) => props.children;
  const Leaf = (props: { label: string }) => createPreactLikeVNode("span", { children: props.label });

  await mount(
    root,
    createPreactLikeVNode(PreactFragment, {
      children: [
        createPreactLikeVNode("p", { children: "loose" }),
        createPreactLikeVNode(Leaf as unknown as (props: Record<string, unknown>) => unknown, { label: "Leaf" }),
      ],
    }),
  );

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "p" },
    { type: "create_text_node", id: 2, text: "loose" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "create_element", id: 3, tagName: "span" },
    { type: "create_text_node", id: 4, text: "Leaf" },
    { type: "append_child", parentId: 3, childId: 4 },
    { type: "append_child", parentId: 0, childId: 1 },
    { type: "append_child", parentId: 0, childId: 3 },
  ]);
});
