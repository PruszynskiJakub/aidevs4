import { describe, expect, test, mock } from "bun:test";
import { reflect } from "../../../src/agent/memory/reflector.ts";
import type { LLMProvider } from "../../../src/types/llm.ts";

function createMockProvider(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    async chatCompletion() {
      const content = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
    async completion() {
      return "";
    },
  };
}

describe("reflect", () => {
  test("returns compressed result when first level reaches target", async () => {
    const observations = "x".repeat(200_000); // ~50K tokens
    const compressed = "y".repeat(40_000); // ~10K tokens — under 20K target
    const provider = createMockProvider([compressed]);

    const result = await reflect(observations, 20_000, provider);
    expect(result.text).toBe(compressed);
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0].name).toBe("memory-reflector-L0");
  });

  test("escalates compression levels when target not reached", async () => {
    const observations = "x".repeat(200_000); // ~50K tokens
    const level0 = "a".repeat(160_000); // ~40K — still too big
    const level1 = "b".repeat(120_000); // ~30K — still too big
    const level2 = "c".repeat(40_000); // ~10K — under target
    const provider = createMockProvider([level0, level1, level2]);

    const result = await reflect(observations, 20_000, provider);
    expect(result.text).toBe(level2);
    expect(result.generations).toHaveLength(3);
  });

  test("returns best result when no level reaches target", async () => {
    const observations = "x".repeat(200_000);
    // Each level produces something large but level1 is smallest
    const level0 = "a".repeat(180_000); // 45K tokens
    const level1 = "b".repeat(100_000); // 25K tokens — smallest
    const level2 = "c".repeat(120_000); // 30K tokens
    const provider = createMockProvider([level0, level1, level2]);

    const result = await reflect(observations, 20_000, provider);
    // Should return the smallest result (level1)
    expect(result.text.length).toBeLessThanOrEqual(120_000);
    expect(result.generations).toHaveLength(3);
  });
});
