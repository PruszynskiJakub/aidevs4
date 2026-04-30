import { describe, expect, test } from "bun:test";
import { serializeMessages } from "../../../apps/server/src/agent/memory/observer.ts";
import type { LLMMessage } from "../../../apps/server/src/types/llm.ts";

describe("serializeMessages", () => {
  test("serializes user messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Hello there" },
    ];
    const result = serializeMessages(messages);
    expect(result).toContain("[USER]");
    expect(result).toContain("Hello there");
  });

  test("serializes assistant messages with tool calls", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "Let me check",
        toolCalls: [
          { id: "1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
        ],
      },
    ];
    const result = serializeMessages(messages);
    expect(result).toContain("[ASSISTANT]");
    expect(result).toContain("Let me check");
    expect(result).toContain("TOOL_CALL: search");
  });

  test("serializes tool results", () => {
    const messages: LLMMessage[] = [
      { role: "tool", toolCallId: "1", content: "<document>result</document>" },
    ];
    const result = serializeMessages(messages);
    expect(result).toContain("[TOOL_RESULT]");
    expect(result).toContain("result");
  });

  test("skips system messages", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are an assistant" },
      { role: "user", content: "Hi" },
    ];
    const result = serializeMessages(messages);
    expect(result).not.toContain("You are an assistant");
    expect(result).toContain("[USER]");
  });

  test("truncates long tool payloads", () => {
    const longContent = "x".repeat(50_000);
    const messages: LLMMessage[] = [
      { role: "tool", toolCallId: "1", content: longContent },
    ];
    const result = serializeMessages(messages);
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain("…[truncated]");
  });

  test("handles multipart user content", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
      },
    ];
    const result = serializeMessages(messages);
    expect(result).toContain("Look at this");
    expect(result).not.toContain("base64");
  });
});
