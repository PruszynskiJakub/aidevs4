import { describe, it, expect, beforeEach } from "bun:test";
import { assistantsService } from "./assistants.ts";

beforeEach(() => {
  assistantsService.resetCache();
});

describe("assistants service", () => {
  describe("get", () => {
    it("loads default assistant with expected fields", async () => {
      const config = await assistantsService.get("default");
      expect(config.name).toBe("default");
      expect(config.objective).toContain("autonomous agent");
      expect(config.objective).toContain("AG3NTS hub");
      expect(config.tone).toContain("concisely");
      expect(config.model).toBeUndefined();
      expect(config.tools).toBeUndefined();
    });

    it("loads proxy assistant with model and tool filter", async () => {
      const config = await assistantsService.get("proxy");
      expect(config.name).toBe("proxy");
      expect(config.objective).toContain("logistics");
      expect(config.tone).toContain("colleague");
      expect(config.model).toBe("gpt-4.1");
      expect(config.tools).toBeDefined();
      expect(config.tools!.include).toEqual(["shipping", "think"]);
      expect(config.tools!.exclude).toBeUndefined();
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
