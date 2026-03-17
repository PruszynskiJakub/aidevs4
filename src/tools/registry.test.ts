import { describe, it, expect, beforeEach } from "bun:test";
import { register, getTools, dispatch, reset } from "./registry.ts";
import type { ToolDefinition } from "../types/tool.ts";

beforeEach(() => {
  reset();
});

describe("registry", () => {
  describe("register + getTools", () => {
    it("registers a simple tool and returns it via getTools", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        handler: async (args: { text: string }) => args.text,
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
        handler: async ({ action, payload }: { action: string; payload: unknown }) => ({ action, payload }),
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
        handler: async () => "ok",
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
    it("dispatches to registered handler and wraps result", async () => {
      const tool: ToolDefinition = {
        name: "greet",
        handler: async (args: { name: string }) => `Hello, ${args.name}!`,
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
      const result = JSON.parse(await dispatch("greet", '{"name":"World"}'));

      expect(result.status).toBe("ok");
      expect(result.data).toBe("Hello, World!");
    });

    it("returns error for unknown tool", async () => {
      const result = JSON.parse(await dispatch("nonexistent", "{}"));

      expect(result.status).toBe("error");
      expect(result.data.error).toContain("Unknown tool");
    });
  });

  describe("dispatch (multi-action)", () => {
    it("routes tool__action to handler with { action, payload }", async () => {
      let received: unknown = null;
      const tool: ToolDefinition = {
        name: "ma",
        handler: async (args: { action: string; payload: unknown }) => {
          received = args;
          return "done";
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
      const result = JSON.parse(await dispatch("ma__run", '{"x":42}'));

      expect(result.status).toBe("ok");
      expect(result.data).toBe("done");
      expect(received).toEqual({ action: "run", payload: { x: 42 } });
    });
  });

  describe("dispatch error handling", () => {
    it("wraps handler errors as error response", async () => {
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
      const result = JSON.parse(await dispatch("fail", "{}"));

      expect(result.status).toBe("error");
      expect(result.data.error).toBe("boom");
    });
  });

  describe("getTools with ToolFilter", () => {
    function registerEchoAndMulti() {
      const echo: ToolDefinition = {
        name: "echo",
        handler: async (args: { text: string }) => args.text,
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
        handler: async ({ action, payload }: { action: string; payload: unknown }) => ({ action, payload }),
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

    it("include filter returns only matching simple tools", async () => {
      registerEchoAndMulti();
      const tools = await getTools({ include: ["echo"] });
      expect(tools).toHaveLength(1);
      expect(tools[0].function.name).toBe("echo");
    });

    it("include filter returns multi-action expanded tools by base name", async () => {
      registerEchoAndMulti();
      const tools = await getTools({ include: ["multi"] });
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("multi__create");
      expect(names).toContain("multi__delete");
    });

    it("exclude filter removes matching tools", async () => {
      registerEchoAndMulti();
      const tools = await getTools({ exclude: ["echo"] });
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("multi__create");
      expect(names).toContain("multi__delete");
    });

    it("no filter returns all tools (backward compat)", async () => {
      registerEchoAndMulti();
      const tools = await getTools();
      expect(tools).toHaveLength(3);
    });
  });

  describe("dispatch with ToolFilter", () => {
    it("rejects tool not in include list", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        handler: async (args: { text: string }) => args.text,
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
      const result = JSON.parse(await dispatch("echo", '{"text":"hi"}', { include: ["other"] }));
      expect(result.status).toBe("error");
      expect(result.data.error).toContain("Tool not allowed");
    });

    it("allows tool in include list", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        handler: async (args: { text: string }) => args.text,
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
      const result = JSON.parse(await dispatch("echo", '{"text":"hi"}', { include: ["echo"] }));
      expect(result.status).toBe("ok");
      expect(result.data).toBe("hi");
    });

    it("rejects multi-action tool not in include list", async () => {
      const tool: ToolDefinition = {
        name: "ma",
        handler: async (args: { action: string; payload: unknown }) => "done",
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
      const result = JSON.parse(await dispatch("ma__run", '{"x":1}', { include: ["other"] }));
      expect(result.status).toBe("error");
      expect(result.data.error).toContain("Tool not allowed");
    });

    it("dispatch without filter works (backward compat)", async () => {
      const tool: ToolDefinition = {
        name: "echo",
        handler: async (args: { text: string }) => args.text,
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
      const result = JSON.parse(await dispatch("echo", '{"text":"hi"}'));
      expect(result.status).toBe("ok");
    });
  });

  describe("reset", () => {
    it("clears all registered tools", async () => {
      const tool: ToolDefinition = {
        name: "temp",
        handler: async () => "ok",
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
