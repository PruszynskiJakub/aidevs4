import { describe, expect, test } from "bun:test";
import { estimateTokens, estimateMessagesTokens } from "./tokens.ts";
import type { LLMMessage } from "../types/llm.ts";

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("returns ceiling of length/4", () => {
    expect(estimateTokens("hello")).toBe(2); // 5/4 = 1.25 → 2
    expect(estimateTokens("abcd")).toBe(1); // 4/4 = 1
    expect(estimateTokens("a")).toBe(1); // 1/4 = 0.25 → 1
  });

  test("handles long text", () => {
    const text = "x".repeat(10_000);
    expect(estimateTokens(text)).toBe(2500);
  });
});

describe("estimateMessagesTokens", () => {
  test("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  test("sums user and assistant messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "abcd" }, // 1 token
      { role: "assistant", content: "abcdefgh", toolCalls: [] }, // 2 tokens
    ];
    expect(estimateMessagesTokens(messages)).toBe(3);
  });

  test("includes tool call arguments in estimate", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "1", type: "function", function: { name: "test", arguments: '{"x":1}' } },
        ],
      },
    ];
    // "test({"x":1})" = 14 chars → 4 tokens
    expect(estimateMessagesTokens(messages)).toBe(4);
  });

  test("handles tool result messages", () => {
    const messages: LLMMessage[] = [
      { role: "tool", toolCallId: "1", content: "result data here" },
    ];
    // 16 chars → 4 tokens
    expect(estimateMessagesTokens(messages)).toBe(4);
  });

  test("handles multipart user content", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "base64data", mimeType: "image/png" },
          { type: "text", text: "world" },
        ],
      },
    ];
    // "hello\nworld" = 11 chars → 3 tokens
    expect(estimateMessagesTokens(messages)).toBe(3);
  });

  test("skips system messages content estimation", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
    ];
    // 27 chars → 7 tokens
    expect(estimateMessagesTokens(messages)).toBe(7);
  });
});
