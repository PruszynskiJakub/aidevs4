import { z } from "zod";
import { describe, it, expect, beforeEach } from "bun:test";
import { register, getTools, getToolsByName, dispatch, reset, serializeContent } from "./registry.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { text } from "../types/tool-result.ts";

beforeEach(() => {
  reset();
});

describe("registry", () => {
  describe("register + getTools", () => {
    it("registers a simple tool and returns it via getTools", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        schema: {
          name: "echo",
          description: "Echoes text back",
          schema: z.object({ text: z.string() }),
        },
        handler: async (args: Record<string, unknown>) =>
          text((args as { text: string }).text),
      };

      register(tool);
      const tools = await getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].type).toBe("function");
      expect(tools[0].function.name).toBe("echo");
      expect(tools[0].function.description).toBe("Echoes text back");
      expect(tools[0].function.strict).toBe(true);
      // Verify Zod schema was converted to JSON Schema
      expect(tools[0].function.parameters).toEqual({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      });
    });

    it("expands multi-action schemas with __ separator", async () => {
      const tool: ToolDefinition = {
        name: "multi",
        schema: {
          name: "multi",
          description: "Multi-action tool",
          actions: {
            create: {
              description: "Create a thing",
              schema: z.object({ name: z.string() }),
            },
            delete: {
              description: "Delete a thing",
              schema: z.object({ id: z.string() }),
            },
          },
        },
        handler: async (args: Record<string, unknown>) =>
          text(`${(args as { action: string }).action}`),
      };

      register(tool);
      const tools = await getTools();

      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("multi__create");
      expect(names).toContain("multi__delete");

      const createTool = tools.find((t) => t.function.name === "multi__create")!;
      expect(createTool.function.description).toBe("Multi-action tool — Create a thing");
      expect(createTool.function.strict).toBe(true);
    });

    it("rejects duplicate registration", () => {
      const tool: ToolDefinition = {
        name: "dup",
        schema: {
          name: "dup",
          description: "A tool",
          schema: z.object({}),
        },
        handler: async () => text("ok"),
      };

      register(tool);
      expect(() => register(tool)).toThrow('Duplicate tool registration: "dup"');
    });
  });

  describe("dispatch (simple)", () => {
    it("dispatches to registered handler and returns plain text content", async () => {
      const tool: ToolDefinition = {
        name: "greet",
        schema: {
          name: "greet",
          description: "Greets someone",
          schema: z.object({ name: z.string() }),
        },
        handler: async (args: Record<string, unknown>) =>
          text(`Hello, ${(args as { name: string }).name}!`),
      };

      register(tool);
      const result = await dispatch("greet", '{"name":"World"}', "call-1");

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Hello, World!");
    });

    it("returns error for unknown tool", async () => {
      const result = await dispatch("nonexistent", "{}", "call-2");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Error: Unknown tool: nonexistent");
    });
  });

  describe("dispatch (multi-action)", () => {
    it("routes tool__action to handler with { action, payload }", async () => {
      let received: unknown = null;
      const tool: ToolDefinition = {
        name: "ma",
        schema: {
          name: "ma",
          description: "Multi",
          actions: {
            run: {
              description: "Run it",
              schema: z.object({ x: z.number() }),
            },
          },
        },
        handler: async (args: Record<string, unknown>) => {
          received = args;
          return text("done");
        },
      };

      register(tool);
      const result = await dispatch("ma__run", '{"x":42}', "call-3");

      expect(result.content).toBe("done");
      expect(received).toEqual({ action: "run", payload: { x: 42 } });
    });
  });

  describe("dispatch error handling", () => {
    it("wraps handler errors as error result", async () => {
      const tool: ToolDefinition = {
        name: "fail",
        schema: {
          name: "fail",
          description: "Fails",
          schema: z.object({}),
        },
        handler: async () => { throw new Error("boom"); },
      };

      register(tool);
      const result = await dispatch("fail", "{}", "call-4");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Error: boom");
    });
  });

  describe("getToolsByName", () => {
    function registerEchoAndMulti() {
      const echo: ToolDefinition = {
        name: "echo",
        schema: {
          name: "echo",
          description: "Echoes text back",
          schema: z.object({ text: z.string() }),
        },
        handler: async (args: Record<string, unknown>) =>
          text((args as { text: string }).text),
      };

      const multi: ToolDefinition = {
        name: "multi",
        schema: {
          name: "multi",
          description: "Multi-action tool",
          actions: {
            create: {
              description: "Create a thing",
              schema: z.object({ name: z.string() }),
            },
            delete: {
              description: "Delete a thing",
              schema: z.object({ id: z.string() }),
            },
          },
        },
        handler: async (args: Record<string, unknown>) =>
          text(`${(args as { action: string }).action}`),
      };

      register(echo);
      register(multi);
    }

    it("returns simple tool by name", () => {
      registerEchoAndMulti();
      const tools = getToolsByName("echo");
      expect(tools).toHaveLength(1);
      expect(tools![0].function.name).toBe("echo");
    });

    it("returns multi-action expanded tools by base name", () => {
      registerEchoAndMulti();
      const tools = getToolsByName("multi");
      expect(tools).toHaveLength(2);
      const names = tools!.map((t) => t.function.name);
      expect(names).toContain("multi__create");
      expect(names).toContain("multi__delete");
    });

    it("returns undefined for unknown tool name", () => {
      registerEchoAndMulti();
      const tools = getToolsByName("nonexistent");
      expect(tools).toBeUndefined();
    });

    it("getTools returns all tools without filtering", async () => {
      registerEchoAndMulti();
      const tools = await getTools();
      expect(tools).toHaveLength(3);
    });
  });

  describe("serializeContent", () => {
    it("serializes text part as-is", () => {
      expect(serializeContent([{ type: "text", text: "hello" }])).toBe("hello");
    });

    it("serializes resource ref with description and uri", () => {
      const result = serializeContent([{ type: "resource", uri: "file:///tmp/f.txt", description: "Full content" }]);
      expect(result).toBe("Full content (ref: file:///tmp/f.txt)");
    });

    it("serializes image with placeholder", () => {
      const data = "AAAA"; // 3 bytes
      const result = serializeContent([{ type: "image", data, mimeType: "image/png" }]);
      expect(result).toContain("[Image: image/png,");
    });

    it("joins multiple parts with double newline", () => {
      const result = serializeContent([
        { type: "text", text: "Summary" },
        { type: "resource", uri: "file:///tmp/f.txt", description: "Full file" },
      ]);
      expect(result).toBe("Summary\n\nFull file (ref: file:///tmp/f.txt)");
    });
  });

  describe("reset", () => {
    it("clears all registered tools", async () => {
      const tool: ToolDefinition = {
        name: "temp",
        schema: {
          name: "temp",
          description: "Temporary",
          schema: z.object({}),
        },
        handler: async () => text("ok"),
      };

      register(tool);
      expect((await getTools()).length).toBe(1);

      reset();
      expect((await getTools()).length).toBe(0);
    });
  });
});
