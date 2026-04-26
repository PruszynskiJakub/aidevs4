import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import type { ToolResult } from "../../src/types/tool-result.ts";

// Mock orchestrator (no circular dep — delegate lazy-imports it)
const mockExecuteTurn = mock(() =>
  Promise.resolve({ answer: "child answer", sessionId: "child-session-123" }),
);
mock.module("../../src/agent/orchestrator.ts", () => ({
  executeTurn: mockExecuteTurn,
}));

// Import the tool — scanAgents runs at top level, reads real agent files
const { default: delegateTool } = await import("../../src/tools/delegate.ts");

// Spy on context functions after import
import * as context from "../../src/agent/context.ts";

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

describe("delegate tool", () => {
  beforeEach(() => {
    mockExecuteTurn.mockClear();
    mockExecuteTurn.mockResolvedValue({ answer: "child answer", sessionId: "child-session-123" });
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

  it("returns a ToolResult with child answer on success", async () => {
    spyOn(context, "getSessionId").mockReturnValueOnce("parent-session-456");
    spyOn(context, "getLogger").mockReturnValueOnce({ info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) } as any);

    const result = await delegateTool.handler({ agent: "proxy", prompt: "Hello" });
    expect(getText(result)).toBe("child answer");
    expect(mockExecuteTurn).toHaveBeenCalledWith({ prompt: "Hello", assistant: "proxy" });
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
    mockExecuteTurn.mockRejectedValueOnce(new Error("Max iterations exceeded"));
    await expect(delegateTool.handler({ agent: "proxy", prompt: "test" })).rejects.toThrow(
      'Delegation to agent "proxy" failed: Max iterations exceeded',
    );
  });

  it("passes correct args to executeTurn", async () => {
    spyOn(context, "getSessionId").mockReturnValueOnce("parent-session-456");
    spyOn(context, "getLogger").mockReturnValueOnce(null as any);

    await delegateTool.handler({ agent: "s2e1", prompt: "classify this" });
    expect(mockExecuteTurn).toHaveBeenCalledWith({
      prompt: "classify this",
      assistant: "s2e1",
    });
  });
});
