import { describe, test, expect, beforeEach, mock } from "bun:test";
import { condense } from "../../src/infra/condense.ts";
import type { LLMProvider } from "../../src/types/llm.ts";

// Stub provider that echoes a fixed summary
function stubProvider(summary: string): LLMProvider {
  return {
    async chatCompletion() {
      throw new Error("not used");
    },
    async completion() {
      return summary;
    },
  };
}

describe("condense", () => {
  test("passes through content below threshold", async () => {
    const result = await condense({
      content: "short output",
      intent: "test",
      threshold: 1_000,
    });

    expect(result.condensed).toBe(false);
    expect(result.text).toBe("short output");
    expect(result.fullPath).toBeNull();
  });

  test("condenses content above threshold", async () => {
    const longContent = "x".repeat(20_000); // ~5000 tokens
    const provider = stubProvider("condensed summary");

    const result = await condense({
      content: longContent,
      intent: "scraped example.com",
      threshold: 1_000,
      provider,
    });

    expect(result.condensed).toBe(true);
    expect(result.text).toBe("condensed summary");
    expect(result.fullPath).not.toBeNull();
    expect(result.fullPath).toMatch(/\.txt$/);
  });

  test("uses custom filename for full output", async () => {
    const longContent = "y".repeat(20_000);
    const provider = stubProvider("summary");

    const result = await condense({
      content: longContent,
      intent: "test",
      threshold: 1_000,
      filename: "scraped-page.html",
      provider,
    });

    expect(result.condensed).toBe(true);
    expect(result.fullPath).toMatch(/\.html$/);
  });

  test("respects exact threshold boundary", async () => {
    // 12_000 chars ≈ 3000 tokens with the /4 heuristic — exactly at default threshold
    const borderContent = "a".repeat(12_000);

    const result = await condense({
      content: borderContent,
      intent: "test",
      // default threshold = 3000 tokens
    });

    // 12000/4 = 3000, which is <= 3000, so should NOT condense
    expect(result.condensed).toBe(false);
  });

  test("condenses at threshold + 1", async () => {
    // 12_001 chars → ceil(12001/4) = 3001 tokens, above default 3000
    const borderContent = "a".repeat(12_001);
    const provider = stubProvider("condensed");

    const result = await condense({
      content: borderContent,
      intent: "test",
      provider,
    });

    expect(result.condensed).toBe(true);
  });
});