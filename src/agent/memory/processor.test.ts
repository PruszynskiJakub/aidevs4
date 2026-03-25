import { describe, expect, test } from "bun:test";
import { processMemory, flushMemory } from "./processor.ts";
import { emptyMemoryState } from "../../types/memory.ts";
import type { MemoryState } from "../../types/memory.ts";
import type { LLMProvider, LLMMessage } from "../../types/llm.ts";
import type { Logger } from "../../types/logger.ts";

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

function createMockLogger(): Logger {
  return {
    info() {},
    success() {},
    error() {},
    debug() {},
    step() {},
    llm() {},
    plan() {},
    toolHeader() {},
    toolCall() {},
    toolOk() {},
    toolErr() {},
    batchDone() {},
    answer() {},
    maxIter() {},
    memoryObserve() {},
    memoryReflect() {},
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
  const log = createMockLogger();
  const sessionId = "test-session";

  test("passes through when below threshold", async () => {
    const messages = makeMessages(10_000); // well under 30K
    const state = emptyMemoryState();
    const provider = createMockProvider();

    const result = await processMemory("system prompt", messages, state, provider, log, sessionId);

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

    const result = await processMemory("system prompt", messages, state, provider, log, sessionId);

    expect(result.context.systemPrompt).toContain("Memory Observations");
    expect(result.context.systemPrompt).toContain("Important fact");
  });

  test("triggers observation when above threshold", async () => {
    const messages = makeMessages(35_000); // above 30K threshold
    const state = emptyMemoryState();
    const provider = createMockProvider("🟡 Observed something new");

    const result = await processMemory("system prompt", messages, state, provider, log, sessionId);

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
  const log = createMockLogger();
  const sessionId = "test-session";

  test("observes remaining messages when above minimum threshold", async () => {
    // Need > 1K tokens worth of messages for flush to trigger
    const messages: LLMMessage[] = [
      { role: "user", content: "x".repeat(5_000) },
      { role: "assistant", content: "y".repeat(5_000) },
    ];
    const state = emptyMemoryState();
    const provider = createMockProvider("🟢 User asked basic math");

    const result = await flushMemory(messages, state, provider, log, sessionId);

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

    const result = await flushMemory(messages, state, provider, log, sessionId);
    expect(result).toBe(state); // unchanged — too few tokens
  });

  test("returns state unchanged when nothing to observe", async () => {
    const messages: LLMMessage[] = [];
    const state = emptyMemoryState();
    const provider = createMockProvider();

    const result = await flushMemory(messages, state, provider, log, sessionId);

    expect(result).toBe(state); // same reference
  });
});
