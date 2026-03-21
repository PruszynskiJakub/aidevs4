import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Document } from "../types/document.ts";

// Mock llm before importing the tool
const completionMock = mock(() => Promise.resolve("The best approach is to call the API endpoint first."));

mock.module("../services/ai/llm.ts", () => ({
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

  it("returns Document with reasoning from LLM completion", async () => {
    const result = await thinkTool.handler({
      thought: "Which API endpoint should I call? Task requires fetching user data. Available endpoints: /users, /profiles.",
    }) as Document;

    expect(result.text).toBe("The best approach is to call the API endpoint first.");
    expect(result.description).toContain("Reasoning about:");
    expect(result.metadata.type).toBe("document");
    expect(result.metadata.mimeType).toBe("text/plain");
    expect(result.metadata.source).toBeNull();
  });

  it("passes question and context to LLM", async () => {
    await thinkTool.handler({
      thought: "What format is needed? The task says to submit a JSON file.",
    });

    expect(completionMock).toHaveBeenCalledTimes(1);
    const call = completionMock.mock.calls[0][0] as any;
    expect(call.userPrompt).toContain("What format is needed?");
    expect(call.systemPrompt).toBeTruthy();
  });
});
