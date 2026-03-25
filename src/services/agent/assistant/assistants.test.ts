import { describe, it, expect, beforeEach } from "bun:test";
import { assistantsService } from "./assistants.ts";

beforeEach(() => {
  assistantsService.resetCache();
});

describe("assistants service", () => {
  describe("get", () => {
    it("loads default agent with expected fields", async () => {
      const config = await assistantsService.get("default");
      expect(config.name).toBe("default");
      expect(config.prompt).toContain("autonomous agent");
      expect(config.prompt).toContain("AG3NTS hub");
      expect(config.model).toBe("gpt-5-2025-08-07");
      expect(config.tools).toBeUndefined();
    });

    it("loads proxy agent with model and tool filter", async () => {
      const config = await assistantsService.get("proxy");
      expect(config.name).toBe("proxy");
      expect(config.prompt).toContain("logistics");
      expect(config.prompt).toContain("colleague");
      expect(config.model).toBe("gpt-4.1");
      expect(config.tools).toBeDefined();
      expect(config.tools!.include).toEqual(["shipping", "think"]);
      expect(config.tools!.exclude).toBeUndefined();
    });

    it("loads agent with capabilities", async () => {
      const config = await assistantsService.get("default");
      expect(config.capabilities).toBeDefined();
      expect(config.capabilities).toContain("task solving");
    });

    it("returns full system prompt from markdown body", async () => {
      const config = await assistantsService.get("default");
      expect(config.prompt).toContain("Reasoning Protocol");
      expect(config.prompt).toContain("Error Recovery");
      expect(config.prompt).not.toContain("{{");
    });

    it("throws on unknown assistant with available names", async () => {
      await expect(assistantsService.get("nonexistent")).rejects.toThrow(
        /Unknown assistant: "nonexistent". Available:/,
      );
    });

    it("caches results across multiple get calls", async () => {
      const first = await assistantsService.get("default");
      const second = await assistantsService.get("default");
      expect(first).toBe(second);
    });
  });
});
