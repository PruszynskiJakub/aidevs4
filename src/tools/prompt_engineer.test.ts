import { describe, it, expect, mock, beforeEach } from "bun:test";
import prompt_engineer from "./prompt_engineer.ts";

// Mock the LLM service
const mockCompletion = mock(() =>
  Promise.resolve(
    JSON.stringify({
      prompt: "Classify as DNG or NEU. Item {id}: {description}. Answer:",
      token_estimate: 18,
      reasoning: "Minimal prompt to fit token budget",
    }),
  ),
);

mock.module("../services/llm.ts", () => ({
  llm: {
    completion: mockCompletion,
  },
}));

mock.module("../services/prompt.ts", () => ({
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

describe("prompt_engineer tool", () => {
  beforeEach(() => {
    mockCompletion.mockClear();
  });

  it("crafts a new prompt from scratch", async () => {
    const result = (await prompt_engineer.handler({
      goal: "Classify items as dangerous or neutral",
      constraints: "Max 100 tokens, output DNG or NEU only",
      context: "Items have {id} and {description} placeholders",
      current_prompt: "",
      feedback: "",
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.prompt).toContain("Classify");
    expect(result.data.token_estimate).toBe(18);
    expect(result.data.reasoning).toBeTruthy();
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

    const callArgs = mockCompletion.mock.calls[0][0] as any;
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

  it("throws on invalid JSON from LLM (caught by dispatcher)", async () => {
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

  it("handles LLM returning JSON without prompt field", async () => {
    mockCompletion.mockImplementationOnce(() =>
      Promise.resolve(JSON.stringify({ reasoning: "no prompt here" })),
    );

    const result = (await prompt_engineer.handler({
      goal: "Classify items",
      constraints: "Max 100 tokens",
      context: "Some context",
      current_prompt: "",
      feedback: "",
    })) as any;

    expect(result.status).toBe("error");
    expect(result.hints).toBeTruthy();
  });

  it("has correct tool name", () => {
    expect(prompt_engineer.name).toBe("prompt_engineer");
  });
});
