import { z } from "zod";
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { agentsService } from "./agents.ts";
import { register, reset } from "../tools/registry.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { text } from "../types/tool-result.ts";

function registerTool(name: string) {
  const tool: ToolDefinition = {
    name,
    schema: {
      name,
      description: `${name} tool`,
      schema: z.object({}),
    },
    handler: async () => text("ok"),
  };
  register(tool);
}

beforeEach(() => {
  reset();
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

    it("throws on unknown agent", async () => {
      await expect(agentsService.get("nonexistent")).rejects.toThrow(
        /Unknown agent: "nonexistent"/,
      );
    });

    it("reads from disk each time (no caching)", async () => {
      const first = await agentsService.get("default");
      const second = await agentsService.get("default");
      expect(first).toEqual(second);
      expect(first).not.toBe(second); // different object references
    });
  });

  describe("resolve", () => {
    it("resolves default agent with all tools when no tools field", async () => {
      registerTool("think");
      registerTool("bash");

      const result = await agentsService.resolve("default");
      expect(result.prompt).toContain("autonomous agent");
      expect(result.model).toBe("gpt-5-2025-08-07");
      expect(result.tools).toHaveLength(2);
    });

    it("resolves agent with only declared tools", async () => {
      registerTool("shipping");
      registerTool("think");
      registerTool("bash");

      const result = await agentsService.resolve("proxy");
      expect(result.model).toBe("gpt-4.1");
      const names = result.tools.map((t) => t.function.name);
      expect(names).toContain("shipping");
      expect(names).toContain("think");
      expect(names).not.toContain("bash");
    });

    it("warns and skips tool not found in registry", async () => {
      registerTool("think");
      // "shipping" is NOT registered — should warn

      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        const result = await agentsService.resolve("proxy");
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].function.name).toBe("think");
        expect(warnSpy).toHaveBeenCalledWith(
          "Agent 'proxy': tool 'shipping' not found in registry, skipping",
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    it("returns empty tools array when all declared tools are invalid", async () => {
      // proxy declares ["shipping", "think"] — neither registered

      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        const result = await agentsService.resolve("proxy");
        expect(result.tools).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("throws for unknown agent", async () => {
      await expect(agentsService.resolve("nonexistent")).rejects.toThrow(/Unknown agent/);
    });
  });
});
