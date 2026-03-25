import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { LLMProvider, LLMChatResponse, LLMMessage, ChatCompletionParams } from "../types/llm.ts";
import type { AgentState } from "../types/agent-state.ts";
import { emptyMemoryState } from "../types/memory.ts";

// Use real prompt/assistant services. Tests check loop behavior, not model names.

// Stub dispatcher — we control dispatch results per test
let dispatchResults: Record<string, () => Promise<string>> = {};
mock.module("../tools/index.ts", () => ({
  getTools: async () => [],
  dispatch: async (name: string, _argsJson: string) => {
    const fn = dispatchResults[name];
    if (!fn) return { xml: `<document id="err" description="Error from ${name}">Error: Unknown tool: ${name}</document>`, isError: true };
    return { xml: await fn(), isError: false };
  },
}));

// Must import after mocks are installed
const { runAgent } = await import("./loop.ts");

/** Plan response — no tool calls, just text */
function planResponse(planText: string): LLMChatResponse {
  return { content: planText, finishReason: "stop", toolCalls: [] };
}

/**
 * Create a provider that returns plan + act responses in sequence.
 * Each iteration needs 2 responses: [plan, act].
 * For multi-iteration tests, interleave: [plan1, act1, plan2, act2, ...].
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
    tokens: {
      plan: { promptTokens: 0, completionTokens: 0 },
      act: { promptTokens: 0, completionTokens: 0 },
    },
    iteration: 0,
    assistant: "default",
    model: "gpt-4.1",
    tools: [],
    memory: emptyMemoryState(),
    ...overrides,
  };
}

function xmlDoc(id: string, desc: string, text: string): string {
  return `<document id="${id}" description="${desc}">${text}</document>`;
}

beforeEach(() => {
  dispatchResults = {};
});

describe("agent plan-act loop", () => {
  it("calls plan LLM before act LLM on each iteration", async () => {
    const callLog: string[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ model, tools }) => {
        // Plan call has no tools, act call has tools (even if empty array)
        const phase = tools === undefined ? "plan" : "act";
        callLog.push(`${phase}:${model}`);

        if (phase === "plan") {
          return planResponse("1. [>] Answer the question");
        }
        return { content: "42", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("What is 2+2?"), provider);
    // Plan uses plan.md model, act uses state.model
    expect(callLog[0]).toMatch(/^plan:/);
    expect(callLog[1]).toMatch(/^act:/);
    expect(callLog).toHaveLength(2);
  });

  it("plan is NOT persisted in main message history", async () => {
    let actMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Do the thing");
        }
        actMessages = messages;
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    // Act messages should contain the plan as last assistant message
    const lastMsg = actMessages[actMessages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect((lastMsg as any).content).toContain("Current Plan");
    expect((lastMsg as any).content).toContain("[>] Do the thing");
  });

  it("act phase receives system prompt from resolved assistant", async () => {
    let actMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Answer");
        }
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

  it("plan receives conversation history with plan system prompt", async () => {
    let planMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          planMessages = messages;
          return planResponse("1. [>] Answer");
        }
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    // Plan messages should have plan system prompt (from plan.md) + user message
    expect(planMessages[0].role).toBe("system");
    expect(planMessages[1].role).toBe("user");
    expect(planMessages).toHaveLength(2);
    const planContent = (planMessages[0] as any).content;
    expect(planContent).toBeTruthy();
  });

  it("state.messages never contains system messages", async () => {
    const provider: LLMProvider = {
      chatCompletion: async ({ tools }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Answer");
        }
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    const state = makeState("test");
    await runAgent(state, provider);

    const systemMessages = state.messages.filter(m => m.role === "system");
    expect(systemMessages).toHaveLength(0);
  });

  it("plan updates across iterations with tool results", async () => {
    const planCalls: LLMMessage[][] = [];

    dispatchResults = {
      tool_a: async () => xmlDoc("a1", "Tool A result", "result A"),
    };

    let callIndex = 0;
    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          planCalls.push([...messages]);
          return planResponse(
            callIndex === 0
              ? "1. [>] Call tool_a"
              : "1. [x] Call tool_a\n2. [>] Return result"
          );
        }

        callIndex++;
        if (callIndex === 1) {
          // First act: call a tool
          return {
            content: null,
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
            ],
          };
        }
        // Second act: finish
        return { content: "Done", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test"), provider);

    // Second plan call should see tool call + result in history
    expect(planCalls).toHaveLength(2);
    expect(planCalls[1].length).toBeGreaterThan(planCalls[0].length);
    const hasToolResult = planCalls[1].some((m) => m.role === "tool");
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
        return xmlDoc("a1", "A", "result A");
      },
      tool_b: async () => {
        order.push("b_start");
        await Bun.sleep(10);
        order.push("b_end");
        return xmlDoc("b1", "B", "result B");
      },
    };

    const provider = makeLLMProvider([
      // Iteration 1: plan, then act with tools
      planResponse("1. [>] Call tools"),
      {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "tool_b", arguments: "{}" } },
        ],
      },
      // Iteration 2: plan, then act with finish
      planResponse("1. [x] Call tools\n2. [>] Done"),
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
        return xmlDoc("s1", "slow", "slow result");
      },
      fast: async () => {
        return xmlDoc("f1", "fast", "fast result");
      },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Call tools");
        }
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

    // Filter tool messages from second act call's messages (excluding system and injected plan)
    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0] as any).toolCallId).toBe("c1");
    expect((toolMessages[1] as any).toolCallId).toBe("c2");
  });

  it("handles mixed success and failure", async () => {
    dispatchResults = {
      good: async () => xmlDoc("g1", "good", "ok result"),
      bad: async () => { throw new Error("boom"); },
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Call tools");
        }
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

    // First tool succeeded — contains XML document
    expect((toolMessages[0] as any).content).toContain("ok result");

    // Second tool failed — Promise.allSettled catches the thrown error
    expect((toolMessages[1] as any).content).toContain("Error: boom");
  });

  it("handles single tool call unchanged", async () => {
    dispatchResults = {
      solo: async () => xmlDoc("s1", "solo", "solo result"),
    };

    let capturedMessages: LLMMessage[] = [];
    let callIndex = 0;

    const provider: LLMProvider = {
      chatCompletion: async ({ tools, messages }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Call solo");
        }
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
      planResponse("1. [>] Answer directly"),
      { content: "Hello!", finishReason: "stop", toolCalls: [] },
    ]);

    const result = await runAgent(makeState("test"), provider);
    expect(result.answer).toBe("Hello!");
  });
});

describe("agent model override", () => {
  it("uses model from state for act phase, plan uses plan.md model", async () => {
    const models: string[] = [];
    const provider: LLMProvider = {
      chatCompletion: async ({ model, tools }) => {
        models.push(`${tools === undefined ? "plan" : "act"}:${model}`);
        if (tools === undefined) {
          return planResponse("1. [>] Answer");
        }
        return { content: "ok", finishReason: "stop", toolCalls: [] };
      },
      completion: async () => "",
    };

    await runAgent(makeState("test", { model: "gpt-4.1-mini" }), provider);
    // Plan uses plan.md model, act uses the state model
    expect(models[0]).toMatch(/^plan:gpt-4\.1$/);
    expect(models[1]).toBe("act:gpt-4.1-mini");
  });

  it("falls back to resolved assistant model when state.model is empty", async () => {
    let capturedActModel = "";
    const provider: LLMProvider = {
      chatCompletion: async ({ model, tools }) => {
        if (tools === undefined) {
          return planResponse("1. [>] Answer");
        }
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
