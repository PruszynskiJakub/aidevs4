import type { LLMProvider, LLMMessage } from "../../types/llm.ts";
import type { MemoryGeneration } from "../../types/events.ts";
import { promptService } from "../../llm/prompt.ts";
import { config } from "../../config/index.ts";
import { estimateTokens } from "../../utils/tokens.ts";
import { buildMemoryGeneration } from "./generation.ts";

const NO_NEW = "NO_NEW_OBSERVATIONS";

/** Truncate a string to a token budget (approximate). */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…[truncated]";
}

/** Serialize messages for the observer prompt, respecting truncation limits. */
export function serializeMessages(messages: LLMMessage[]): string {
  const { message: msgLimit, toolPayload: toolLimit } = config.memory.truncationLimits;
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      lines.push(`[USER]\n${truncateToTokens(content, msgLimit)}`);
    } else if (msg.role === "assistant") {
      const parts: string[] = [];
      if (msg.content) parts.push(truncateToTokens(msg.content, msgLimit));
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push(`TOOL_CALL: ${tc.function.name}(${truncateToTokens(tc.function.arguments, toolLimit)})`);
        }
      }
      lines.push(`[ASSISTANT]\n${parts.join("\n")}`);
    } else if (msg.role === "tool") {
      lines.push(`[TOOL_RESULT]\n${truncateToTokens(msg.content, toolLimit)}`);
    }
  }

  return lines.join("\n\n");
}

export type { ObserveResult } from "../../types/memory-ops.ts";
import type { ObserveResult } from "../../types/memory-ops.ts";

export async function observe(
  messages: LLMMessage[],
  existingObservations: string,
  provider: LLMProvider,
): Promise<ObserveResult> {
  const serialized = serializeMessages(messages);

  const prompt = await promptService.load("observer", {
    existing_observations: existingObservations || "(none)",
    messages: serialized,
  });

  const model = prompt.model ?? config.models.memory;
  const inputMessages = [{ role: "system" as const, content: prompt.content }];

  const startTime = Date.now();
  const response = await provider.chatCompletion({
    model,
    messages: inputMessages,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });
  const durationMs = Date.now() - startTime;

  const result = response.content?.trim() ?? "";
  const text = (result === NO_NEW || !result) ? "" : result;

  const generation = buildMemoryGeneration(
    "memory-observer", model, inputMessages, response, startTime, durationMs,
  );

  return { text, generation };
}
