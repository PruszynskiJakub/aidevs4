import type { LLMMessage } from "../types/llm.ts";

/**
 * Estimate token count from text using character-length heuristic.
 * Centralized version of the Math.ceil(length / 4) pattern.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Serialize a single message to a string for token estimation. */
function serializeMessage(msg: LLMMessage): string {
  if (msg.role === "assistant") {
    const parts: string[] = [];
    if (msg.content) parts.push(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        parts.push(`${tc.function.name}(${tc.function.arguments})`);
      }
    }
    return parts.join("\n");
  }

  if (msg.role === "user") {
    if (typeof msg.content === "string") return msg.content;
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // system or tool
  return msg.content;
}

/** Estimate total tokens across an array of messages. */
export function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(serializeMessage(msg));
  }
  return total;
}
