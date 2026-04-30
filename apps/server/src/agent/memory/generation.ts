import type { LLMChatResponse, LLMMessage } from "../../types/llm.ts";
import type { MemoryGeneration } from "../../types/events.ts";

/** Build a MemoryGeneration from an LLM call's inputs and response. */
export function buildMemoryGeneration(
  name: string,
  model: string,
  inputMessages: LLMMessage[],
  response: LLMChatResponse,
  startTime: number,
  durationMs: number,
): MemoryGeneration {
  return {
    name,
    model,
    input: inputMessages,
    output: { content: response.content },
    usage: {
      input: response.usage?.promptTokens ?? 0,
      output: response.usage?.completionTokens ?? 0,
      total: (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0),
    },
    durationMs,
    startTime,
  };
}