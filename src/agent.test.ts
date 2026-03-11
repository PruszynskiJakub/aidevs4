import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { LLMProvider, LLMChatResponse, LLMMessage } from "./types/llm.ts";

// Stub prompt service before importing agent
mock.module("./services/prompt.ts", () => ({
  promptService: {
    load: async () => ({ model: "gpt-4.1", content: "You are an agent." }),
  },
}));

// Stub dispatcher — we control dispatch results per test
// Post SP-17: dispatch always returns ToolResponse shape { status, data, hints? }
let dispatchResults: Record<string, () => Promise<string>> = {};
mock.module("./tools/dispatcher.ts", () => ({
  getTools: async () => [],
  dispatch: async (name: string, _argsJson: string) => {
    const fn = dispatchResults[name];
    if (!fn) return JSON.stringify({ status: "error", data: { error: `Unknown tool: ${name}` } });
    return fn();
  },
}));

// Must import after mocks are installed
const { runAgent } = await import("./agent.ts");

function makeLLMProvider(responses: LLMChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    chatCompletion: async () => responses[callIndex++],
    completion: async () => "",
  };
}

function makeMessages(prompt: string): LLMMessage[] {
  return [
    { role: "system", content: "You are an agent." },
    { role: "user", content: prompt },
  ];
}

beforeEach(() => {
  dispatchResults = {};
});

describe("agent parallel tool calling", () => {
  it("dispatches multiple tool calls concurrently", async () => {
    const order: string[] = [];

    dispatchResults = {
      tool_a: async () => {
        order.push("a_start");
        await Bun.sleep(50);
        order.push("a_end");
        return JSON.stringify({ status: "ok", data: { result: "A" } });
      },
      tool_b: async () => {
        order.push("b_start");
        await Bun.sleep(10);
        order.push("b_end");
        return JSON.stringify({ status: "ok", data: { result: "B" } });
      },
    };

    const provider = makeLLMProvider([
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "tool_b", arguments: "{}" } },
        ],
      },
      { content: "Done", finishReason: "stop", toolCalls: [] },
    ]);

    await runAgent(makeMessages("test"), provider);

    // Both should start before either finishes (parallel, not sequential)
    expect(order.indexOf("b_start")).toBeLessThan(order.indexOf("a_end"));
  });

  it("preserves tool result order matching tool call order", async () => {
    dispatchResults = {
      slow: async () => {
        await Bun.sleep(40);
        return JSON.stringify({ status: "ok", data: { result: "slow" } });
      },
      fast: async () => {
        return JSON.stringify({ status: "ok", data: { result: "fast" } });
      },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;
    const responses: LLMChatResponse[] = [
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "slow", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "fast", arguments: "{}" } },
        ],
      },
      { content: "Done", finishReason: "stop", toolCalls: [] },
    ];

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        return responses[callIndex++];
      },
      completion: async () => "",
    };

    await runAgent(makeMessages("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0] as any).toolCallId).toBe("c1");
    expect((toolMessages[1] as any).toolCallId).toBe("c2");
  });

  it("handles mixed success and failure", async () => {
    dispatchResults = {
      good: async () => JSON.stringify({ status: "ok", data: { result: "ok" } }),
      bad: async () => { throw new Error("boom"); },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;
    const responses: LLMChatResponse[] = [
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "good", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "bad", arguments: "{}" } },
        ],
      },
      { content: "Done", finishReason: "stop", toolCalls: [] },
    ];

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        return responses[callIndex++];
      },
      completion: async () => "",
    };

    await runAgent(makeMessages("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    // First tool succeeded — agent extracts data from ToolResponse
    expect(JSON.parse((toolMessages[0] as any).content)).toEqual({ result: "ok" });

    // Second tool failed — Promise.allSettled catches the thrown error
    const secondResult = JSON.parse((toolMessages[1] as any).content);
    expect(secondResult.error).toBeDefined();
  });

  it("handles single tool call unchanged", async () => {
    dispatchResults = {
      solo: async () => JSON.stringify({ status: "ok", data: { result: "solo" } }),
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;
    const responses: LLMChatResponse[] = [
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "solo", arguments: "{}" } },
        ],
      },
      { content: "Done", finishReason: "stop", toolCalls: [] },
    ];

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        return responses[callIndex++];
      },
      completion: async () => "",
    };

    await runAgent(makeMessages("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse((toolMessages[0] as any).content)).toEqual({ result: "solo" });
  });

  it("handles no tool calls — prints response and exits", async () => {
    const provider = makeLLMProvider([
      { content: "Hello!", finishReason: "stop", toolCalls: [] },
    ]);

    await runAgent(makeMessages("test"), provider);
    // No assertions beyond not throwing — the agent should simply print and return
  });
});
