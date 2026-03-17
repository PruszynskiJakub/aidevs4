import type { LLMProvider } from "../types/llm.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { createOpenAIProvider } from "../providers/openai.ts";
import { createGeminiProvider } from "../providers/gemini.ts";

export { createOpenAIProvider } from "../providers/openai.ts";

const registry = new ProviderRegistry();

registry.register("gpt-", createOpenAIProvider());
registry.register("o", createOpenAIProvider());

const geminiKey = process.env.GEMINI_API_KEY;
if (geminiKey) {
  registry.register("gemini-", createGeminiProvider(geminiKey));
}

export const llm: LLMProvider = registry;
