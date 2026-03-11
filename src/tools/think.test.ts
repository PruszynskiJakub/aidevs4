import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock llm before importing the tool
const completionMock = mock(() => Promise.resolve("The best approach is to call the API endpoint first."));

mock.module("../services/llm.ts", () => ({
  llm: {
    completion: completionMock,
    chatCompletion: mock(),
  },
}));

const { default: thinkTool } = await import("./think.ts");

describe("think tool", () => {
  beforeEach(() => {
    completionMock.mockClear();
  });

  it("has correct name", () => {
    expect(thinkTool.name).toBe("think");
  });

  it("returns ToolResponse with reasoning from LLM completion", async () => {
    const result = (await thinkTool.handler({
      question: "Which API endpoint should I call?",
      context: "Task requires fetching user data. Available endpoints: /users, /profiles.",
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.reasoning).toBe("The best approach is to call the API endpoint first.");
  });

  it("passes question and context to LLM", async () => {
    await thinkTool.handler({
      question: "What format is needed?",
      context: "The task says to submit a JSON file.",
    });

    expect(completionMock).toHaveBeenCalledTimes(1);
    const call = completionMock.mock.calls[0][0] as any;
    expect(call.userPrompt).toContain("What format is needed?");
    expect(call.userPrompt).toContain("The task says to submit a JSON file.");
    expect(call.systemPrompt).toBeTruthy();
  });
});
