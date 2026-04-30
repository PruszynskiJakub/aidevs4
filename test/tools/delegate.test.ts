import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ToolResult } from "../../apps/server/src/types/tool-result.ts";
import type { ToolCallContext } from "../../apps/server/src/types/tool.ts";
import type { RunCtx } from "../../apps/server/src/agent/run-ctx.ts";
import { createIsolatedRuntime } from "../../apps/server/src/runtime.ts";

// Mock orchestrator (no circular dep — delegate lazy-imports it)
const mockCreateChildRun = mock(() =>
  Promise.resolve({
    sessionId: "child-session-123",
    runId: "r-child",
  }),
);
mock.module("../../apps/server/src/agent/orchestrator.ts", () => ({
  createChildRun: mockCreateChildRun,
}));

// Import the tool — scanAgents runs at top level, reads real agent files
const { default: delegateTool } = await import("../../apps/server/src/tools/delegate.ts");

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

const noopLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

function makeCtx(overrides: Partial<RunCtx> = {}): ToolCallContext {
  const runtime = createIsolatedRuntime();
  return {
    toolCallId: "call-delegate-1",
    runCtx: {
      runtime,
      log: noopLog as any,
      state: { sessionId: "parent-session-456" } as any,
      files: runtime.files.scoped("parent-session-456"),
      sessionId: "parent-session-456",
      runId: "r-parent",
      rootRunId: "r-root",
      traceId: "trace-parent",
      depth: 2,
      agentName: "default",
      ...overrides,
    },
  };
}

describe("delegate tool", () => {
  beforeEach(() => {
    mockCreateChildRun.mockClear();
    mockCreateChildRun.mockResolvedValue({
      sessionId: "child-session-123",
      runId: "r-child",
    });
    noopLog.info.mockClear();
    noopLog.warn.mockClear();
    noopLog.error.mockClear();
  });

  it("has correct name and schema", () => {
    expect(delegateTool.name).toBe("delegate");
    expect(delegateTool.schema.name).toBe("delegate");
    expect(delegateTool.schema.description).toContain("Delegate a subtask");
  });

  it("schema contains dynamically loaded agent names", () => {
    const desc = delegateTool.schema.description;
    expect(desc).toContain("default");
    expect(desc).toContain("proxy");
    expect(desc).toContain("s2e1");
  });

  it("returns a wait ToolResult after creating a child run", async () => {
    const result = await delegateTool.handler({ agent: "proxy", prompt: "Hello" }, makeCtx());
    expect(getText(result)).toBe("Delegated to proxy (run r-child)");
    expect(result.wait).toEqual({ kind: "child_run", childRunId: "r-child" });
    expect(mockCreateChildRun).toHaveBeenCalledWith({
      prompt: "Hello",
      assistant: "proxy",
      parentRunId: "r-parent",
      rootRunId: "r-root",
      parentTraceId: "trace-parent",
      parentDepth: 2,
      sourceCallId: "call-delegate-1",
    }, expect.any(Object));
  });

  it("throws on empty prompt", async () => {
    await expect(delegateTool.handler({ agent: "proxy", prompt: "" })).rejects.toThrow(
      "prompt must not be empty",
    );
  });

  it("throws on whitespace-only prompt", async () => {
    await expect(delegateTool.handler({ agent: "proxy", prompt: "   " })).rejects.toThrow(
      "prompt must not be empty",
    );
  });

  it("throws on prompt exceeding max length", async () => {
    const longPrompt = "a".repeat(10_001);
    await expect(delegateTool.handler({ agent: "proxy", prompt: longPrompt })).rejects.toThrow(
      "exceeds max length",
    );
  });

  it("wraps child failure in actionable error", async () => {
    mockCreateChildRun.mockRejectedValueOnce(new Error("Max iterations exceeded"));
    await expect(delegateTool.handler({ agent: "proxy", prompt: "test" }, makeCtx())).rejects.toThrow(
      'Delegation to agent "proxy" failed: Max iterations exceeded',
    );
  });

  it("passes parent run context to createChildRun", async () => {
    await delegateTool.handler({ agent: "s2e1", prompt: "classify this" }, makeCtx({
      rootRunId: undefined,
      traceId: undefined,
      depth: 0,
    }));
    expect(mockCreateChildRun).toHaveBeenCalledWith({
      prompt: "classify this",
      assistant: "s2e1",
      parentRunId: "r-parent",
      rootRunId: "r-parent",
      parentTraceId: undefined,
      parentDepth: 0,
      sourceCallId: "call-delegate-1",
    }, expect.any(Object));
  });
});
