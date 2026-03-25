import type { LLMProvider } from "../../types/llm.ts";
import { promptService } from "../../llm/prompt.ts";
import { config } from "../../config/index.ts";
import { estimateTokens } from "../../utils/tokens.ts";

const COMPRESSION_GUIDANCE: Record<number, string> = {
  0: "Level 0 — Reorganize: Merge duplicate observations, group by topic, remove redundancies. Keep all priority levels intact.",
  1: "Level 1 — Condense: Aggressively summarize 🟢 Context and older 🟡 Important items. Merge related items. Keep all 🔴 Critical items verbatim.",
  2: "Level 2 — Essential only: Keep only durable facts — 🔴 Critical items, key 🟡 Important findings still relevant to the active task. Collapse all 🟢 Context into a single brief summary if any context remains relevant.",
};

export async function reflect(
  observations: string,
  targetTokens: number,
  provider: LLMProvider,
): Promise<string> {
  const maxLevels = config.memory.maxReflectionLevels;
  let bestResult = observations;
  let bestTokens = estimateTokens(observations);

  for (let level = 0; level < maxLevels; level++) {
    const guidance = COMPRESSION_GUIDANCE[level] ?? COMPRESSION_GUIDANCE[2]!;
    const targetChars = targetTokens * 4;

    const prompt = await promptService.load("reflector", {
      compression_guidance: guidance,
      target_tokens: String(targetTokens),
      target_chars: String(targetChars),
      observations,
    });

    const response = await provider.chatCompletion({
      model: prompt.model ?? config.models.memory,
      messages: [
        { role: "system", content: prompt.content },
      ],
      ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
    });

    const result = response.content?.trim() ?? observations;
    const resultTokens = estimateTokens(result);

    if (resultTokens < bestTokens) {
      bestResult = result;
      bestTokens = resultTokens;
    }

    if (resultTokens <= targetTokens) {
      return result;
    }

    // Feed the compressed result into the next level
    observations = bestResult;
  }

  // None reached target — return best (smallest) result
  return bestResult;
}
