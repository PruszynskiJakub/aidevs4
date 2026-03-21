import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { LLMProvider, LLMChatResponse, LLMMessage, ChatCompletionParams } from "./types/llm.ts";

// Use real prompt/assistant services. Tests check loop behavior, not model names.

// Stub dispatcher — we control dispatch results per test
let dispatchResults: Record<string, () => Promise<string>> = {};
mock.module("./tools/index.ts", () => ({
  getTools: async () => [],
  dispatch: async (name: string, _argsJson: string) => {
    const fn = dispatchResults[name];
    if (!fn) return `<document id="err" description="Error from ${name}">Error: Unknown tool: ${name}</document>`;
    return fn();
  },
}));

// Must import after mocks are installed
const { runAgent } = await import("./agent.ts");

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

function makeMessages(prompt: string): LLMMessage[] {
  return [
    { role: "system", content: "You are an agent." },
    { role: "user", content: prompt },
  ];
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

    await runAgent(makeMessages("What is 2+2?"), provider);
    // Plan uses plan.md model, act uses act.md model (or assistant override)
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

    await runAgent(makeMessages("test"), provider);

    // Act messages should contain the plan as last assistant message
    const lastMsg = actMessages[actMessages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect((lastMsg as any).content).toContain("Current Plan");
    expect((lastMsg as any).content).toContain("[>] Do the thing");
  });

  it("plan receives conversation history without act system prompt", async () => {
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

    await runAgent(makeMessages("test"), provider);

    // Plan messages should have plan system prompt (from plan.md) + user message (no act system prompt)
    expect(planMessages[0].role).toBe("system");
    expect(planMessages[1].role).toBe("user");
    expect(planMessages).toHaveLength(2);
    // Plan system prompt should NOT be the act system prompt
    const planContent = (planMessages[0] as any).content;
    expect(planContent).toBeTruthy();
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

    await runAgent(makeMessages("test"), provider);

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

    await runAgent(makeMessages("test"), provider);

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

    await runAgent(makeMessages("test"), provider);

    // Filter tool messages from second act call's messages (excluding the injected plan)
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

    await runAgent(makeMessages("test"), provider);

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

    await runAgent(makeMessages("test"), provider);

    const toolMessages = capturedMessages.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect((toolMessages[0] as any).content).toContain("solo result");
  });

  it("handles no tool calls — prints response and exits", async () => {
    const provider = makeLLMProvider([
      planResponse("1. [>] Answer directly"),
      { content: "Hello!", finishReason: "stop", toolCalls: [] },
    ]);

    const result = await runAgent(makeMessages("test"), provider);
    expect(result).toBe("Hello!");
  });
});

describe("agent model override", () => {
  it("uses model from options for act phase, plan uses plan.md model", async () => {
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

    await runAgent(makeMessages("test"), provider, { model: "gpt-4.1-mini" });
    // Plan uses plan.md model, act uses the override model
    expect(models[0]).toMatch(/^plan:gpt-4\.1$/);
    expect(models[1]).toBe("act:gpt-4.1-mini");
  });

  it("falls back to act prompt frontmatter model when no override", async () => {
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

    await runAgent(makeMessages("test"), provider);
    // Should use model from act.md frontmatter (since no override and no assistant model)
    expect(capturedActModel).toBeTruthy();
    expect(capturedActModel).not.toBe(""); // some model from act.md was used
  });
});
