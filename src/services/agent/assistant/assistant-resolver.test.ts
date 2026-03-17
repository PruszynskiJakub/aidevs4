import { describe, it, expect, beforeEach } from "bun:test";
import { resolveAssistant, clearPromptCache } from "./assistant-resolver.ts";

beforeEach(() => {
  clearPromptCache();
});

describe("resolveAssistant", () => {
  it("resolves the default assistant with prompt, model, and toolFilter", async () => {
    const result = await resolveAssistant("default");
    expect(result.prompt).toBeDefined();
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(typeof result.model).toBe("string");
    // toolFilter may be undefined for default
  });

  it("throws for unknown assistant name", async () => {
    await expect(resolveAssistant("nonexistent")).rejects.toThrow(/Unknown assistant/);
  });

  it("caches prompts — second call returns same content", async () => {
    const first = await resolveAssistant("default");
    const second = await resolveAssistant("default");
    expect(first.prompt).toBe(second.prompt);
  });
});
