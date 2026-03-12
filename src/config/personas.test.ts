import { describe, it, expect } from "bun:test";
import { getPersona } from "./personas.ts";
import matter from "gray-matter";
import { join } from "path";

describe("getPersona", () => {
  it("returns default persona when no name given", () => {
    const persona = getPersona();
    expect(persona.objective).toContain("autonomous agent");
    expect(persona.tone).toBeDefined();
    expect(persona.model).toBeUndefined();
  });

  it("returns default persona for explicit 'default' name", () => {
    const persona = getPersona("default");
    expect(persona.objective).toContain("AG3NTS hub");
    expect(persona.tone).toContain("concisely");
  });

  it("returns proxy persona", () => {
    const persona = getPersona("proxy");
    expect(persona.objective).toContain("logistics");
    expect(persona.tone).toContain("colleague");
    expect(persona.model).toBe("gpt-4.1");
  });

  it("throws on unknown persona with available names listed", () => {
    expect(() => getPersona("nonexistent")).toThrow(
      /Unknown persona: "nonexistent". Available: default, proxy/,
    );
  });
});

describe("persona + prompt integration", () => {
  // Read the raw prompt file directly to avoid mock.module leakage from agent.test.ts
  const systemPath = join(import.meta.dir, "..", "prompts", "system.md");

  async function renderPrompt(vars: Record<string, string>) {
    const raw = await Bun.file(systemPath).text();
    const { data, content } = matter(raw);
    const rendered = content.trim().replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      if (!(key in vars)) throw new Error(`Missing variable: {{${key}}}`);
      return vars[key];
    });
    return { model: data.model as string, content: rendered };
  }

  it("default persona renders system prompt with objective and shared sections", async () => {
    const persona = getPersona();
    const result = await renderPrompt({
      objective: persona.objective,
      tone: persona.tone,
    });
    expect(result.model).toBe("gpt-5-2025-08-07");
    // Persona-specific objective injected
    expect(result.content).toContain("AG3NTS hub");
    expect(result.content).toContain("fewest possible steps");
    // Universal sections from template preserved
    expect(result.content).toContain("Reasoning Protocol");
    expect(result.content).toContain("Workflow");
    expect(result.content).toContain("Tool Usage");
    expect(result.content).toContain("Error Recovery");
    expect(result.content).toContain("Answer Submission");
    // Tone injected
    expect(result.content).toContain("concisely and precisely");
  });

  it("custom persona injects its objective and tone while keeping shared sections", async () => {
    const persona = getPersona("proxy");
    const result = await renderPrompt({
      objective: persona.objective,
      tone: persona.tone,
    });
    // Persona-specific content injected
    expect(result.content).toContain("logistics department");
    expect(result.content).toContain("colleague");
    // Universal sections still present (from template, not persona)
    expect(result.content).toContain("Reasoning Protocol");
    expect(result.content).toContain("Workflow");
    expect(result.content).toContain("Error Recovery");
    // Default objective NOT present
    expect(result.content).not.toContain("AG3NTS hub");
  });

  it("persona model overrides frontmatter model", () => {
    const persona = getPersona("proxy");
    const frontmatterModel = "gpt-5-2025-08-07";
    const effectiveModel = persona.model ?? frontmatterModel;
    expect(effectiveModel).toBe("gpt-4.1");
  });

  it("default persona uses frontmatter model (no override)", () => {
    const persona = getPersona("default");
    const frontmatterModel = "gpt-5-2025-08-07";
    const effectiveModel = persona.model ?? frontmatterModel;
    expect(effectiveModel).toBe("gpt-5-2025-08-07");
  });
});
