import { describe, it, expect, beforeEach } from "bun:test";
import { agentsService } from "./agents.ts";

beforeEach(() => {
  agentsService.resetCache();
});

describe("agentsService", () => {
  describe("get", () => {
    it("loads default agent with expected fields", async () => {
      const config = await agentsService.get("default");
      expect(config.name).toBe("default");
      expect(config.prompt).toContain("autonomous agent");
      expect(config.prompt).toContain("AG3NTS hub");
      expect(config.model).toBe("gpt-5-2025-08-07");
      expect(config.tools).toBeUndefined();
    });

    it("loads proxy agent with model and tools", async () => {
      const config = await agentsService.get("proxy");
      expect(config.name).toBe("proxy");
      expect(config.prompt).toContain("logistics");
      expect(config.model).toBe("gpt-4.1");
      expect(config.tools).toEqual(["shipping", "think"]);
    });

    it("loads agent with capabilities", async () => {
      const config = await agentsService.get("default");
      expect(config.capabilities).toBeDefined();
      expect(config.capabilities).toContain("task solving");
    });

    it("returns full system prompt from markdown body", async () => {
      const config = await agentsService.get("default");
      expect(config.prompt).toContain("Reasoning Protocol");
      expect(config.prompt).toContain("Error Recovery");
      expect(config.prompt).not.toContain("{{");
    });

    it("throws on unknown agent with available names", async () => {
      await expect(agentsService.get("nonexistent")).rejects.toThrow(
        /Unknown agent: "nonexistent". Available:/,
      );
    });

    it("caches results across multiple get calls", async () => {
      const first = await agentsService.get("default");
      const second = await agentsService.get("default");
      expect(first).toBe(second);
    });
  });

  describe("resolve", () => {
    it("resolves default agent with prompt and model", async () => {
      const result = await agentsService.resolve("default");
      expect(result.prompt).toContain("autonomous agent");
      expect(result.model).toBe("gpt-5-2025-08-07");
      expect(result.toolFilter).toBeUndefined();
    });

    it("wraps tools array as toolFilter include", async () => {
      const result = await agentsService.resolve("proxy");
      expect(result.model).toBe("gpt-4.1");
      expect(result.toolFilter).toEqual({ include: ["shipping", "think"] });
    });

    it("returns prompt directly without template composition", async () => {
      const result = await agentsService.resolve("default");
      expect(result.prompt).toContain("Reasoning Protocol");
      expect(result.prompt).not.toContain("{{");
    });

    it("throws for unknown agent", async () => {
      await expect(agentsService.resolve("nonexistent")).rejects.toThrow(/Unknown agent/);
    });

    it("returns consistent results across calls", async () => {
      const first = await agentsService.resolve("default");
      const second = await agentsService.resolve("default");
      expect(first).toEqual(second);
    });
  });
});
