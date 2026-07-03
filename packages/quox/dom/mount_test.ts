import { createVNode, Fragment, type QuoxRenderable, type QuoxVNodeType } from "@quoxlabs/jsx";
import type { QuoxRenderer as WasmRenderer } from "../lib/quox.js";
import { QuoxDocument } from "./document.ts";
import { getDocumentFunctionProps } from "./handlers.ts";
import { mountRenderable } from "./mount.ts";
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

function createTestDocument(): {
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
  );

  return {
    document,
    renderer,
    root: new QuoxElement(document, 0),
  };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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

Deno.test("mountRenderable walks fragments, function components, and nested arrays", () => {
  const { renderer, root } = createTestDocument();
  const Leaf = (props: { label: string; children?: QuoxRenderable }) =>
    createVNode("span", {
      className: "leaf",
      children: [props.label, props.children],
    });

  mountRenderable(
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

  assertEquals(renderer.operations, [
    { type: "create_element", id: 1, tagName: "h1" },
    { type: "create_text_node", id: 2, text: "Hi" },
    { type: "append_child", parentId: 1, childId: 2 },
    { type: "create_text_node", id: 3, text: "loose" },
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

Deno.test("mountRenderable lowers props and stores function-valued DOM props", () => {
  const { document, renderer, root } = createTestDocument();
  const onClick = () => "clicked";
  const [node] = mountRenderable(
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
  assert(getDocumentFunctionProps(document)?.get(node.nodeId)?.get("onClick") === onClick, "onClick was not stored");
});

Deno.test("mountRenderable rejects unsupported object attributes", () => {
  const { root } = createTestDocument();

  assertThrows(
    () => mountRenderable(root, createVNode("div", { value: { nested: true } })),
    'Cannot set object value as "value" attribute.',
  );
});

Deno.test("mountRenderable rejects async function components", () => {
  const { root } = createTestDocument();
  const AsyncComponent = (() => Promise.resolve(createVNode("p", null))) as unknown as QuoxVNodeType;

  assertThrows(
    () => mountRenderable(root, createVNode(AsyncComponent, null)),
    "Async Quox components are not supported yet.",
  );
});
