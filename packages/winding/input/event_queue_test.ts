import type { Window, WindowEvent } from "../types.ts";
import { EventQueue } from "./event_queue.ts";

interface TestEvent extends WindowEvent {
  type: "test";
  value: number;
}

function testWindow(): Window {
  return {
    [Symbol.dispose]() {},
    close() {},
    setTitle() {},
    fullscreenEnabled: true,
    setFullscreen() {},
    blit() {},
  };
}

Deno.test("event queue preserves batches and purges one window without reordering", () => {
  const first = testWindow();
  const second = testWindow();
  const queue = new EventQueue<TestEvent>();

  queue.push({ type: "test", value: 1, window: first });
  queue.pushBatch([
    { type: "test", value: 2, window: second },
    { type: "test", value: 3, window: first },
    { type: "test", value: 4, window: second },
  ]);
  queue.prepend({ type: "test", value: 0, window: second });
  queue.purgeWindow(first);

  assertEquals(queue.shift()?.value, 0);
  assertEquals(queue.shift()?.value, 2);
  assertEquals(queue.shift()?.value, 4);
  assertEquals(queue.shift(), undefined);
});

Deno.test("closed event queue drops pending and callback-late events", () => {
  const window = testWindow();
  const queue = new EventQueue<TestEvent>();
  queue.push({ type: "test", value: 1, window });
  queue.close();
  queue.push({ type: "test", value: 2, window });
  queue.pushBatch([{ type: "test", value: 3, window }]);

  assertEquals(queue.closed, true);
  assertEquals(queue.length, 0);
  assertEquals(queue.shift(), undefined);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
}
