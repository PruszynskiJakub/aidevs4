import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ToolResult } from "../../src/types/tool-result.ts";

// Mock llm before importing the tool
const completionMock = mock(() => Promise.resolve("The best approach is to call the API endpoint first."));

mock.module("../../src/llm/llm.ts", () => ({
  llm: {
    completion: completionMock,
    chatCompletion: mock(),
  },
}));

const { default: thinkTool } = await import("../../src/tools/think.ts");

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

describe("think tool", () => {
  beforeEach(() => {
    completionMock.mockClear();
  });

  it("has correct name", () => {
    expect(thinkTool.name).toBe("think");
  });

  it("returns ToolResult with reasoning from LLM completion", async () => {
    const result = await thinkTool.handler({
      thought: "Which API endpoint should I call? Task requires fetching user data. Available endpoints: /users, /profiles.",
    });

    expect(getText(result)).toBe("The best approach is to call the API endpoint first.");
  });

  it("passes question and context to LLM", async () => {
    await thinkTool.handler({
      thought: "What format is needed? The task says to submit a JSON file.",
    });

    expect(completionMock).toHaveBeenCalledTimes(1);
    const call = (completionMock.mock.calls as any[][])[0][0];
    expect(call.userPrompt).toContain("What format is needed?");
    expect(call.systemPrompt).toBeTruthy();
  });
});
