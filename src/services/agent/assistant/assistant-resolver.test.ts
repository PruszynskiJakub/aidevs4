import { describe, it, expect, beforeEach } from "bun:test";
import { assistantResolverService } from "./assistant-resolver.ts";

beforeEach(() => {
  assistantResolverService.clearCache();
});

describe("assistantResolverService", () => {
  it("resolves the default assistant with prompt, model, and toolFilter", async () => {
    const result = await assistantResolverService.resolve("default");
    expect(result.prompt).toBeDefined();
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(typeof result.model).toBe("string");
    // toolFilter may be undefined for default
  });

  it("throws for unknown assistant name", async () => {
    await expect(assistantResolverService.resolve("nonexistent")).rejects.toThrow(/Unknown assistant/);
  });

  it("caches prompts — second call returns same content", async () => {
    const first = await assistantResolverService.resolve("default");
    const second = await assistantResolverService.resolve("default");
    expect(first.prompt).toBe(second.prompt);
  });
});
