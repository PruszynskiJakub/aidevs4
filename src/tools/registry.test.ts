import { describe, it, expect, beforeEach } from "bun:test";
import { register, getTools, getToolsByName, dispatch, reset } from "./registry.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { createDocument } from "../infra/document.ts";

beforeEach(() => {
  reset();
});

describe("registry", () => {
  describe("register + getTools", () => {
    it("registers a simple tool and returns it via getTools", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        handler: async (args: Record<string, unknown>) =>
          createDocument((args as { text: string }).text, "echo result", { source: null, type: "document", mimeType: "text/plain" }),
      };
      const schema = {
        name: "echo",
        description: "Echoes text back",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      };

      register(tool, schema);
      const tools = await getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].type).toBe("function");
      expect(tools[0].function.name).toBe("echo");
      expect(tools[0].function.description).toBe("Echoes text back");
      expect(tools[0].function.strict).toBe(true);
    });

    it("expands multi-action schemas with __ separator", async () => {
      const tool: ToolDefinition = {
        name: "multi",
        handler: async (args: Record<string, unknown>) =>
          createDocument("ok", `${(args as { action: string }).action}`, { source: null, type: "document", mimeType: "text/plain" }),
      };
      const schema = {
        name: "multi",
        description: "Multi-action tool",
        actions: {
          create: {
            description: "Create a thing",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          delete: {
            description: "Delete a thing",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
      };

      register(tool, schema);
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
        handler: async () =>
          createDocument("ok", "dup", { source: null, type: "document", mimeType: "text/plain" }),
      };
      const schema = {
        name: "dup",
        description: "A tool",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      };

      register(tool, schema);
      expect(() => register(tool, schema)).toThrow('Duplicate tool registration: "dup"');
    });
  });

  describe("dispatch (simple)", () => {
    it("dispatches to registered handler and returns XML document", async () => {
      const tool: ToolDefinition = {
        name: "greet",
        handler: async (args: Record<string, unknown>) =>
          createDocument(`Hello, ${(args as { name: string }).name}!`, "greeting", { source: null, type: "document", mimeType: "text/plain" }),
      };
      const schema = {
        name: "greet",
        description: "Greets someone",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      };

      register(tool, schema);
      const result = await dispatch("greet", '{"name":"World"}');

      expect(result.isError).toBe(false);
      expect(result.xml).toContain("<document");
      expect(result.xml).toContain("Hello, World!");
      expect(result.xml).toContain("</document>");
    });

    it("returns error document for unknown tool", async () => {
      const result = await dispatch("nonexistent", "{}");

      expect(result.isError).toBe(true);
      expect(result.xml).toContain("<document");
      expect(result.xml).toContain("Error: Unknown tool: nonexistent");
    });
  });

  describe("dispatch (multi-action)", () => {
    it("routes tool__action to handler with { action, payload }", async () => {
      let received: unknown = null;
      const tool: ToolDefinition = {
        name: "ma",
        handler: async (args: Record<string, unknown>) => {
          received = args;
          return createDocument("done", "ma result", { source: null, type: "document", mimeType: "text/plain" });
        },
      };
      const schema = {
        name: "ma",
        description: "Multi",
        actions: {
          run: {
            description: "Run it",
            parameters: {
              type: "object",
              properties: { x: { type: "number" } },
              required: ["x"],
              additionalProperties: false,
            },
          },
        },
      };

      register(tool, schema);
      const result = await dispatch("ma__run", '{"x":42}');

      expect(result.xml).toContain("done");
      expect(received).toEqual({ action: "run", payload: { x: 42 } });
    });
  });

  describe("dispatch error handling", () => {
    it("wraps handler errors as error document", async () => {
      const tool: ToolDefinition = {
        name: "fail",
        handler: async () => { throw new Error("boom"); },
      };
      const schema = {
        name: "fail",
        description: "Fails",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      };

      register(tool, schema);
      const result = await dispatch("fail", "{}");

      expect(result.isError).toBe(true);
      expect(result.xml).toContain("<document");
      expect(result.xml).toContain("Error: boom");
      expect(result.xml).toContain("Error from fail");
    });
  });

  describe("getToolsByName", () => {
    function registerEchoAndMulti() {
      const echo: ToolDefinition = {
        name: "echo",
        handler: async (args: Record<string, unknown>) =>
          createDocument((args as { text: string }).text, "echo", { source: null, type: "document", mimeType: "text/plain" }),
      };
      const echoSchema = {
        name: "echo",
        description: "Echoes text back",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      };

      const multi: ToolDefinition = {
        name: "multi",
        handler: async (args: Record<string, unknown>) =>
          createDocument("ok", `${(args as { action: string }).action}`, { source: null, type: "document", mimeType: "text/plain" }),
      };
      const multiSchema = {
        name: "multi",
        description: "Multi-action tool",
        actions: {
          create: {
            description: "Create a thing",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          delete: {
            description: "Delete a thing",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
      };

      register(echo, echoSchema);
      register(multi, multiSchema);
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

  describe("reset", () => {
    it("clears all registered tools", async () => {
      const tool: ToolDefinition = {
        name: "temp",
        handler: async () =>
          createDocument("ok", "temp", { source: null, type: "document", mimeType: "text/plain" }),
      };
      const schema = {
        name: "temp",
        description: "Temporary",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      };

      register(tool, schema);
      expect((await getTools()).length).toBe(1);

      reset();
      expect((await getTools()).length).toBe(0);
    });
  });
});
