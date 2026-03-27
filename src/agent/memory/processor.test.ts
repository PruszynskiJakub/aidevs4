import { describe, expect, test } from "bun:test";
import { processMemory, flushMemory } from "./processor.ts";
import { emptyMemoryState } from "../../types/memory.ts";
import type { MemoryState } from "../../types/memory.ts";
import type { LLMProvider, LLMMessage } from "../../types/llm.ts";

function createMockProvider(content: string = "🟡 New observation"): LLMProvider {
  return {
    async chatCompletion() {
      return {
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
    async completion() {
      return "";
    },
  };
}

function makeMessages(tokenCount: number): LLMMessage[] {
  // Each message ~1000 chars = ~250 tokens
  const msgCount = Math.ceil(tokenCount / 250);
  const messages: LLMMessage[] = [];
  for (let i = 0; i < msgCount; i++) {
    messages.push({ role: "user", content: `Message ${i}: ${"x".repeat(990)}` });
  }
  return messages;
}

describe("processMemory", () => {
  const sessionId = "test-session";

  test("passes through when below threshold", async () => {
    const messages = makeMessages(10_000); // well under 30K
    const state = emptyMemoryState();
    const provider = createMockProvider();

    const result = await processMemory("system prompt", messages, state, provider, sessionId);

    expect(result.context.messages).toBe(messages); // same reference — untouched
    expect(result.context.systemPrompt).toBe("system prompt"); // no observations appended
    expect(result.state.lastObservedIndex).toBe(0);
  });

  test("appends existing observations to system prompt even when below threshold", async () => {
    const messages = makeMessages(10_000);
    const state: MemoryState = {
      activeObservations: "🔴 Important fact",
      lastObservedIndex: 0,
      observationTokenCount: 10,
      generationCount: 0,
    };
    const provider = createMockProvider();

    const result = await processMemory("system prompt", messages, state, provider, sessionId);

    expect(result.context.systemPrompt).toContain("Memory Observations");
    expect(result.context.systemPrompt).toContain("Important fact");
  });

  test("does not orphan tool responses from their tool_calls assistant message", async () => {
    // Build messages that exceed threshold, with a tool_calls + tool pair
    // near the split boundary so the naive split would land between them.
    const filler = makeMessages(30_000); // bulk to trigger compression
    const assistantWithToolCalls: LLMMessage = {
      role: "assistant",
      content: "Let me check.",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
      ],
    };
    const toolResponse1: LLMMessage = { role: "tool", toolCallId: "call_1", content: "file a contents" };
    const toolResponse2: LLMMessage = { role: "tool", toolCallId: "call_2", content: "file b contents" };
    const recentUser: LLMMessage = { role: "user", content: "Thanks!" };

    const messages = [...filler, assistantWithToolCalls, toolResponse1, toolResponse2, recentUser];
    const state = emptyMemoryState();
    const provider = createMockProvider("🟡 Observed tool usage");

    const result = await processMemory("system prompt", messages, state, provider, sessionId);

    // The tail must never start with a tool message
    const tail = result.context.messages;
    if (tail.length > 0) {
      expect(tail[0].role).not.toBe("tool");
    }

    // If the assistant+tool messages are in the tail, they must all be there together
    const tailRoles = tail.map((m) => m.role);
    const toolIdx = tailRoles.indexOf("tool");
    if (toolIdx !== -1) {
      // There must be an assistant message before the first tool message
      const precedingRoles = tailRoles.slice(0, toolIdx);
      expect(precedingRoles).toContain("assistant");
    }
  });

  test("triggers observation when above threshold", async () => {
    const messages = makeMessages(35_000); // above 30K threshold
    const state = emptyMemoryState();
    const provider = createMockProvider("🟡 Observed something new");

    const result = await processMemory("system prompt", messages, state, provider, sessionId);

    // State should be updated
    expect(result.state.lastObservedIndex).toBeGreaterThan(0);
    expect(result.state.activeObservations).toContain("Observed something new");
    // Messages should be trimmed (only tail preserved)
    expect(result.context.messages.length).toBeLessThan(messages.length);
    // System prompt should include observations
    expect(result.context.systemPrompt).toContain("Memory Observations");
  });
});

describe("flushMemory", () => {
  const sessionId = "test-session";

  test("observes remaining messages when above minimum threshold", async () => {
    // Need > 1K tokens worth of messages for flush to trigger
    const messages: LLMMessage[] = [
      { role: "user", content: "x".repeat(5_000) },
      { role: "assistant", content: "y".repeat(5_000) },
    ];
    const state = emptyMemoryState();
    const provider = createMockProvider("🟢 User asked basic math");

    const result = await flushMemory(messages, state, provider, sessionId);

    expect(result.activeObservations).toContain("basic math");
    expect(result.lastObservedIndex).toBe(2);
  });

  test("skips flush when messages are too small", async () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];
    const state = emptyMemoryState();
    const provider = createMockProvider();

    const result = await flushMemory(messages, state, provider, sessionId);
    expect(result).toBe(state); // unchanged — too few tokens
  });

  test("returns state unchanged when nothing to observe", async () => {
    const messages: LLMMessage[] = [];
    const state = emptyMemoryState();
    const provider = createMockProvider();

    const result = await flushMemory(messages, state, provider, sessionId);

    expect(result).toBe(state); // same reference
  });
});
