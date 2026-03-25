import type { LLMProvider } from "../types/llm.ts";
import { ProviderRegistry } from "./router.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createGeminiProvider } from "./gemini.ts";
import { config } from "../config/index.ts";

export { createOpenAIProvider } from "./openai.ts";

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
