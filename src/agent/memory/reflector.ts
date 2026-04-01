import type { LLMProvider } from "../../types/llm.ts";
import type { MemoryGeneration } from "../../types/events.ts";
import { promptService } from "../../llm/prompt.ts";
import { config } from "../../config/index.ts";
import { estimateTokens } from "../../utils/tokens.ts";

const COMPRESSION_GUIDANCE: Record<number, string> = {
  0: "Level 0 — Reorganize: Merge duplicate observations, group by topic, remove redundancies. Keep all priority levels intact.",
  1: "Level 1 — Condense: Aggressively summarize 🟢 Context and older 🟡 Important items. Merge related items. Keep all 🔴 Critical items verbatim.",
  2: "Level 2 — Essential only: Keep only durable facts — 🔴 Critical items, key 🟡 Important findings still relevant to the active task. Collapse all 🟢 Context into a single brief summary if any context remains relevant.",
};

export interface ReflectResult {
  text: string;
  generations: MemoryGeneration[];
}

export async function reflect(
  observations: string,
  targetTokens: number,
  provider: LLMProvider,
): Promise<ReflectResult> {
  const maxLevels = config.memory.maxReflectionLevels;
  let bestResult = observations;
  let bestTokens = estimateTokens(observations);
  const generations: MemoryGeneration[] = [];

  for (let level = 0; level < maxLevels; level++) {
    const guidance = COMPRESSION_GUIDANCE[level] ?? COMPRESSION_GUIDANCE[2]!;
    const targetChars = targetTokens * 4;

    const prompt = await promptService.load("reflector", {
      compression_guidance: guidance,
      target_tokens: String(targetTokens),
      target_chars: String(targetChars),
      observations,
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

    generations.push({
      name: `memory-reflector-L${level}`,
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
    });

    const result = response.content?.trim() ?? observations;
    const resultTokens = estimateTokens(result);

    if (resultTokens < bestTokens) {
      bestResult = result;
      bestTokens = resultTokens;
    }

    if (resultTokens <= targetTokens) {
      return { text: result, generations };
    }

    // Feed the compressed result into the next level
    observations = bestResult;
  }

  // None reached target — return best (smallest) result
  return { text: bestResult, generations };
}
