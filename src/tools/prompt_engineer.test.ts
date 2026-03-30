import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ToolResult } from "../types/tool-result.ts";

// Mock the LLM service — must come before importing the tool
const mockCompletion = mock(() =>
  Promise.resolve(
    JSON.stringify({
      prompt: "Classify as DNG or NEU. Item {id}: {description}. Answer:",
      token_estimate: 18,
      reasoning: "Minimal prompt to fit token budget",
    }),
  ),
);

mock.module("../llm/llm.ts", () => ({
  llm: {
    completion: mockCompletion,
  },
}));

const { default: prompt_engineer } = await import("./prompt_engineer.ts");

mock.module("../llm/prompt.ts", () => ({
  promptService: {
    load: mock(() =>
      Promise.resolve({
        model: "gpt-4.1",
        temperature: 0.3,
        content: "You are a prompt engineer.",
      }),
    ),
  },
}));

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

describe("prompt_engineer tool", () => {
  beforeEach(() => {
    mockCompletion.mockClear();
  });

  it("crafts a new prompt from scratch", async () => {
    const result = await prompt_engineer.handler({
      goal: "Classify items as dangerous or neutral",
      constraints: "Max 100 tokens, output DNG or NEU only",
      context: "Items have {id} and {description} placeholders",
      current_prompt: "",
      feedback: "",
    });

    const data = JSON.parse(getText(result));
    expect(data.prompt).toContain("Classify");
    expect(data.token_estimate).toBe(18);
    expect(data.reasoning).toBeTruthy();
    expect(mockCompletion).toHaveBeenCalledTimes(1);
  });

  it("includes current_prompt and feedback in refinement mode", async () => {
    await prompt_engineer.handler({
      goal: "Classify items",
      constraints: "Max 100 tokens",
      context: "Sample data",
      current_prompt: "Old prompt here",
      feedback: "Item 3 was misclassified",
    });

    const callArgs = (mockCompletion.mock.calls as any[][])[0][0];
    expect(callArgs.userPrompt).toContain("## Current Prompt");
    expect(callArgs.userPrompt).toContain("Old prompt here");
    expect(callArgs.userPrompt).toContain("## Feedback");
    expect(callArgs.userPrompt).toContain("Item 3 was misclassified");
  });

  it("rejects empty goal", async () => {
    await expect(
      prompt_engineer.handler({
        goal: "",
        constraints: "Max 100 tokens",
        context: "Some context",
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow("goal is required");
  });

  it("rejects empty constraints", async () => {
    await expect(
      prompt_engineer.handler({
        goal: "Classify items",
        constraints: "   ",
        context: "Some context",
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow("constraints is required");
  });

  it("rejects goal exceeding max length", async () => {
    await expect(
      prompt_engineer.handler({
        goal: "x".repeat(2_001),
        constraints: "Max 100 tokens",
        context: "Some context",
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow();
  });

  it("rejects context exceeding max length", async () => {
    await expect(
      prompt_engineer.handler({
        goal: "Classify",
        constraints: "Max 100 tokens",
        context: "x".repeat(5_001),
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow();
  });

  it("throws on invalid JSON from LLM", async () => {
    mockCompletion.mockImplementationOnce(() =>
      Promise.resolve("This is not JSON"),
    );

    await expect(
      prompt_engineer.handler({
        goal: "Classify items",
        constraints: "Max 100 tokens",
        context: "Some context",
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow("Invalid JSON");
  });

  it("throws when LLM returns JSON without prompt field", async () => {
    mockCompletion.mockImplementationOnce(() =>
      Promise.resolve(JSON.stringify({ reasoning: "no prompt here" })),
    );

    await expect(
      prompt_engineer.handler({
        goal: "Classify items",
        constraints: "Max 100 tokens",
        context: "Some context",
        current_prompt: "",
        feedback: "",
      }),
    ).rejects.toThrow("LLM did not return a valid prompt field");
  });

  it("has correct tool name", () => {
    expect(prompt_engineer.name).toBe("prompt_engineer");
  });
});
