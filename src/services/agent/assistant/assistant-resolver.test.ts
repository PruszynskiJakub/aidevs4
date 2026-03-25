import { describe, it, expect, beforeEach } from "bun:test";
import { assistantResolverService } from "./assistant-resolver.ts";

beforeEach(() => {
  assistantResolverService.clearCache();
});

describe("assistantResolverService", () => {
  it("resolves the default agent with prompt, model, and toolFilter", async () => {
    const result = await assistantResolverService.resolve("default");
    expect(result.prompt).toBeDefined();
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.prompt).toContain("autonomous agent");
    expect(result.model).toBe("gpt-5-2025-08-07");
    // toolFilter may be undefined for default
  });

  it("returns prompt directly from agent file without template composition", async () => {
    const result = await assistantResolverService.resolve("default");
    // Prompt should contain the full scaffolding baked in
    expect(result.prompt).toContain("Reasoning Protocol");
    expect(result.prompt).toContain("Error Recovery");
    // No placeholders should remain
    expect(result.prompt).not.toContain("{{");
  });

  it("resolves proxy agent with correct model and tool filter", async () => {
    const result = await assistantResolverService.resolve("proxy");
    expect(result.model).toBe("gpt-4.1");
    expect(result.toolFilter).toBeDefined();
    expect(result.toolFilter!.include).toEqual(["shipping", "think"]);
  });

  it("throws for unknown assistant name", async () => {
    await expect(assistantResolverService.resolve("nonexistent")).rejects.toThrow(/Unknown assistant/);
  });

  it("caches prompts — second call returns same object", async () => {
    const first = await assistantResolverService.resolve("default");
    const second = await assistantResolverService.resolve("default");
    expect(first).toBe(second);
  });
});
