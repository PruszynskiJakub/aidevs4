import type { LLMProvider } from "../../types/llm.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { createOpenAIProvider } from "../../providers/openai.ts";
import { createGeminiProvider } from "../../providers/gemini.ts";
import { config } from "../../config/index.ts";

export { createOpenAIProvider } from "../../providers/openai.ts";

export function createLlmService(): LLMProvider {
  const registry = new ProviderRegistry();

  const openai = createOpenAIProvider();
  registry.register("gpt-", openai);
  registry.register(/^o[1-9]/, openai);

  const geminiKey = config.keys.geminiApiKey;
  if (geminiKey) {
    registry.register("gemini-", createGeminiProvider(geminiKey));
  }

  return registry;
}

export const llm: LLMProvider = createLlmService();
