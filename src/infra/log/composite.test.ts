import { describe, it, expect } from "bun:test";
import { createCompositeLogger } from "./composite.ts";
import type { Logger } from "../../types/logger.ts";

function mockLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const handler = {
    get(_: unknown, prop: string) {
      if (prop === "calls") return calls;
      return (...args: unknown[]) => {
        calls[prop] ??= [];
        calls[prop].push(args);
      };
    },
  };
  // @ts-expect-error Proxy implements Logger at runtime via get trap
  return new Proxy({ calls }, handler);
}

const ALL_METHODS: Array<{ method: keyof Logger; args: unknown[] }> = [
  { method: "step", args: [1, 10, "gpt-4.1", 5] },
  { method: "llm", args: ["1.23s", 100, 200] },
  { method: "plan", args: ["do stuff", "gpt-4.1", "0.5s", 50, 60] },
  { method: "toolHeader", args: [3] },
  { method: "toolCall", args: ["my_tool", '{"key":"val"}'] },
  { method: "toolOk", args: ["my_tool", "0.1s", '<document id="x" description="test">ok</document>'] },
  { method: "toolErr", args: ["my_tool", "something failed"] },
  { method: "batchDone", args: [5, "2.0s"] },
  { method: "answer", args: ["final answer"] },
  { method: "maxIter", args: [20] },
  { method: "info", args: ["info msg"] },
  { method: "success", args: ["success msg"] },
  { method: "error", args: ["error msg"] },
  { method: "debug", args: ["debug msg"] },
];

describe("createCompositeLogger", () => {
  it("delegates step to all targets with correct args", () => {
    const a = mockLogger();
    const b = mockLogger();
    const logger = createCompositeLogger([a, b]);

    logger.step(1, 10, "gpt-4.1", 5);

    expect(a.calls["step"]).toEqual([[1, 10, "gpt-4.1", 5]]);
    expect(b.calls["step"]).toEqual([[1, 10, "gpt-4.1", 5]]);
  });

  it("delegates all 14 methods to all targets", () => {
    for (const { method, args } of ALL_METHODS) {
      const a = mockLogger();
      const b = mockLogger();
      const logger = createCompositeLogger([a, b]);

      (logger[method] as (...a: unknown[]) => void)(...args);

      expect(a.calls[method]).toEqual([args]);
      expect(b.calls[method]).toEqual([args]);
    }
  });

  it("works with zero targets (no-op, no throw)", () => {
    const logger = createCompositeLogger([]);

    expect(() => {
      for (const { method, args } of ALL_METHODS) {
        (logger[method] as (...a: unknown[]) => void)(...args);
      }
    }).not.toThrow();
  });
});
