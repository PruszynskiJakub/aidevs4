import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { LLMProvider, LLMChatResponse, LLMMessage, ChatCompletionParams } from "../types/llm.ts";
import type { AgentState } from "../types/agent-state.ts";
import { emptyMemoryState } from "../types/memory.ts";

// Use real prompt/assistant services. Tests check loop behavior, not model names.

// Stub dispatcher — we control dispatch results per test
let dispatchResults: Record<string, () => Promise<string>> = {};
mock.module("../tools/index.ts", () => ({
  register: () => {},
  getTools: async () => [],
  getToolsByName: () => undefined,
  dispatch: async (name: string, _argsJson: string, _toolCallId?: string) => {
    const fn = dispatchResults[name];
    if (!fn) return { content: `Error: Unknown tool: ${name}`, isError: true };
    return { content: await fn(), isError: false };
  },
  reset: () => {},
}));

// Must import after mocks are installed
const { runAgent } = await import("./loop.ts");

/**
 * Create a provider that returns responses in sequence.
 * Each iteration needs 1 response (act only).
 */
function makeLLMProvider(responses: LLMChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    chatCompletion: async () => responses[callIndex++],
    completion: async () => "",
  };
}

function makeState(prompt: string, overrides?: Partial<AgentState>): AgentState {
  return {
    sessionId: "test",
    messages: [{ role: "user", content: prompt }],
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: "default",
    model: "gpt-4.1",
    tools: [],
    memory: emptyMemoryState(),
    ...overrides,
  };
}

beforeEach(() => {
  dispatchResults = {};
});

describe("agent loop", () => {
  it("calls LLM once per iteration", async () => {
    const callLog: string[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ model }) => {
        callLog.push(`act:${model}`);
        return { content: "42", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("What is 2+2?"), provider);
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toMatch(/^act:/);
  });

  it("act phase receives system prompt from resolved assistant", async () => {
    let actMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        actMessages = messages;
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    // First message should be system prompt (from resolved assistant)
    expect(actMessages[0].role).toBe("system");
    expect((actMessages[0] as any).content).toBeTruthy();
    // Second should be user message
    expect(actMessages[1].role).toBe("user");
  });

  it("state.messages never contains system messages", async () => {
    const provider: LLMProvider = {
      chatCompletion: async () => {
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    const state = makeState("test");
    await runAgent(state, provider);

    const systemMessages = state.messages.filter(m => m.role === "system");
    expect(systemMessages).toHaveLength(0);
  });

  it("tool results appear in subsequent iterations", async () => {
    dispatchResults = {
      tool_a: async () => "result A",
    };

    let callIndex = 0;
    let secondCallMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        callIndex++;
        if (callIndex === 1) {
          return {
            content: null,
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
            ],
          };
        }
        secondCallMessages = messages;
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    // Second call should see tool result in history
    const hasToolResult = secondCallMessages.some((m) => m.role === "tool");
    expect(hasToolResult).toBe(true);
  });
});

describe("agent parallel tool calling", () => {
  it("dispatches multiple tool calls concurrently", async () => {
    const order: string[] = [];

    dispatchResults = {
      tool_a: async () => {
        order.push("a_start");
        await Bun.sleep(50);
        order.push("a_end");
        return "result A";
      },
      tool_b: async () => {
        order.push("b_start");
        await Bun.sleep(10);
        order.push("b_end");
        return "result B";
      },
    };

    const provider = makeLLMProvider([
      // Iteration 1: act with tools
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "tool_b", arguments: "{}" } },
        ],
      },
      // Iteration 2: act with finish
      { content: "Done", finishReason: "stop", toolCalls: [] },
    ]);

    await runAgent(makeState("test"), provider);

    // Both should start before either finishes (parallel, not sequential)
    expect(order.indexOf("b_start")).toBeLessThan(order.indexOf("a_end"));
  });

  it("preserves tool result order matching tool call order", async () => {
    dispatchResults = {
      slow: async () => {
        await Bun.sleep(40);
        return "slow result";
      },
      fast: async () => {
        return "fast result";
      },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        if (callIndex++ === 0) {
          return {
            content: null,
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", type: "function", function: { name: "slow", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "fast", arguments: "{}" } },
            ],
          };
        }
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0] as any).toolCallId).toBe("c1");
    expect((toolMessages[1] as any).toolCallId).toBe("c2");
  });

  it("handles mixed success and failure", async () => {
    dispatchResults = {
      good: async () => "ok result",
      bad: async () => { throw new Error("boom"); },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        if (callIndex++ === 0) {
          return {
            content: null,
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", type: "function", function: { name: "good", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "bad", arguments: "{}" } },
            ],
          };
        }
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    // First tool succeeded — plain text
    expect((toolMessages[0] as any).content).toContain("ok result");

    // Second tool failed — Promise.allSettled catches the thrown error
    expect((toolMessages[1] as any).content).toContain("Error: boom");
  });

  it("handles single tool call unchanged", async () => {
    dispatchResults = {
      solo: async () => "solo result",
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ messages }) => {
        capturedMessages = messages;
        if (callIndex++ === 0) {
          return {
            content: null,
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", type: "function", function: { name: "solo", arguments: "{}" } },
            ],
          };
        }
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect((toolMessages[0] as any).content).toContain("solo result");
  });

  it("handles no tool calls — prints response and exits", async () => {
    const provider = makeLLMProvider([
      { content: "Hello!", finishReason: "stop", toolCalls: [] },
    ]);

    const result = await runAgent(makeState("test"), provider);
    expect(result.answer).toBe("Hello!");
  });
});

describe("agent model override", () => {
  it("uses model from state for act phase", async () => {
    let capturedModel = "";
    const provider: LLMProvider = {
      chatCompletion: async ({ model }) => {
        capturedModel = model;
        return { content: "ok", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test", { model: "gpt-4.1-mini" }), provider);
    expect(capturedModel).toBe("gpt-4.1-mini");
  });

  it("falls back to resolved assistant model when state.model is empty", async () => {
    let capturedActModel = "";
    const provider: LLMProvider = {
      chatCompletion: async ({ model }) => {
        capturedActModel = model;
        return { content: "ok", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test", { model: "" }), provider);
    // Should use model from resolved assistant (not empty)
    expect(capturedActModel).toBeTruthy();
  });
});
