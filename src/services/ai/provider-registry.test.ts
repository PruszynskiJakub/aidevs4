import { describe, it, expect } from "bun:test";
import { ProviderRegistry } from "./provider-registry.ts";
import type { LLMProvider, LLMChatResponse, ChatCompletionParams, CompletionParams } from "../../types/llm.ts";

function stubProvider(label: string): LLMProvider & { label: string } {
  return {
    label,
    chatCompletion: async (params: ChatCompletionParams): Promise<LLMChatResponse> => ({
      content: `${label}:chat`,
      toolCalls: [],
      finishReason: "stop",
    }),
    completion: async (params: CompletionParams): Promise<string> => `${label}:completion`,
  };
}

describe("ProviderRegistry", () => {
  describe("resolve", () => {
    it("resolves by string prefix", () => {
      const registry = new ProviderRegistry();
      const openai = stubProvider("openai");
      registry.register("gpt-", openai);

      expect(registry.resolve("gpt-4.1")).toBe(openai);
      expect(registry.resolve("gpt-4.1-mini")).toBe(openai);
    });

    it("resolves by RegExp", () => {
      const registry = new ProviderRegistry();
      const provider = stubProvider("custom");
      registry.register(/^claude-/, provider);

      expect(registry.resolve("claude-3-opus")).toBe(provider);
    });

    it("returns first matching provider (priority by registration order)", () => {
      const registry = new ProviderRegistry();
      const specific = stubProvider("specific");
      const general = stubProvider("general");
      registry.register("gpt-4.1-mini", specific);
      registry.register("gpt-", general);

      expect(registry.resolve("gpt-4.1-mini")).toBe(specific);
      expect(registry.resolve("gpt-4.1")).toBe(general);
    });

    it("throws for unknown model with helpful message", () => {
      const registry = new ProviderRegistry();
      registry.register("gpt-", stubProvider("openai"));

      expect(() => registry.resolve("claude-3")).toThrow('No provider registered for model "claude-3"');
      expect(() => registry.resolve("claude-3")).toThrow('"gpt-"');
    });

    it("throws with empty registry", () => {
      const registry = new ProviderRegistry();
      expect(() => registry.resolve("any-model")).toThrow("(none)");
    });

    it("matches 'o' prefix for o-series models", () => {
      const registry = new ProviderRegistry();
      const openai = stubProvider("openai");
      registry.register("o", openai);

      expect(registry.resolve("o1")).toBe(openai);
      expect(registry.resolve("o3-mini")).toBe(openai);
    });

    it("matches 'gemini-' prefix", () => {
      const registry = new ProviderRegistry();
      const gemini = stubProvider("gemini");
      registry.register("gemini-", gemini);

      expect(registry.resolve("gemini-2.5-flash")).toBe(gemini);
      expect(registry.resolve("gemini-1.5-pro")).toBe(gemini);
    });
  });

  describe("LLMProvider delegation", () => {
    it("chatCompletion delegates to resolved provider", async () => {
      const registry = new ProviderRegistry();
      registry.register("gpt-", stubProvider("openai"));
      registry.register("gemini-", stubProvider("gemini"));

      const result = await registry.chatCompletion({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result.content).toBe("gemini:chat");
    });

    it("completion delegates to resolved provider", async () => {
      const registry = new ProviderRegistry();
      registry.register("gpt-", stubProvider("openai"));

      const result = await registry.completion({
        model: "gpt-4.1",
        systemPrompt: "sys",
        userPrompt: "user",
      });
      expect(result).toBe("openai:completion");
    });

    it("chatCompletion throws for unregistered model", async () => {
      const registry = new ProviderRegistry();
      registry.register("gpt-", stubProvider("openai"));

      await expect(
        registry.chatCompletion({
          model: "unknown-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow('No provider registered for model "unknown-model"');
    });
  });
});
