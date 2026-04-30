import { describe, test, expect, beforeEach } from "bun:test";
import { registerRaw, getTools, getToolsByName, dispatch, reset } from "../../apps/server/src/tools/registry.ts";

beforeEach(() => {
  reset();
});

describe("registerRaw", () => {
  test("registers a tool with pre-built JSON Schema and strict: false", () => {
    registerRaw(
      "mcp_test_search",
      "Search for things",
      { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async () => ({ content: [{ type: "text", text: "result" }] }),
    );

    const tools = getToolsByName("mcp_test_search");
    expect(tools).toBeDefined();
    expect(tools!.length).toBe(1);

    const tool = tools![0];
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("mcp_test_search");
    expect(tool.function.description).toBe("Search for things");
    expect(tool.function.strict).toBe(false);
    expect(tool.function.parameters).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  test("throws on duplicate registration", () => {
    const handler = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
    registerRaw("mcp_dup", "desc", { type: "object", properties: {} }, handler);

    expect(() =>
      registerRaw("mcp_dup", "desc", { type: "object", properties: {} }, handler),
    ).toThrow('Duplicate tool registration: "mcp_dup"');
  });

  test("tool appears in getTools()", async () => {
    registerRaw(
      "mcp_foo_bar",
      "Foo bar",
      { type: "object", properties: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const allTools = await getTools();
    const found = allTools.find((t) => t.function.name === "mcp_foo_bar");
    expect(found).toBeDefined();
  });

  test("dispatch routes to the raw handler", async () => {
    registerRaw(
      "mcp_echo",
      "Echo input",
      { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      async (args) => ({
        content: [{ type: "text", text: `echo: ${args.msg}` }],
      }),
    );

    const result = await dispatch("mcp_echo", JSON.stringify({ msg: "hello" }), "tc-1");
    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo: hello");
  });

  test("dispatch returns error when handler throws", async () => {
    registerRaw(
      "mcp_fail",
      "Always fails",
      { type: "object", properties: {} },
      async () => {
        throw new Error("boom");
      },
    );

    const result = await dispatch("mcp_fail", "{}", "tc-2");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  test("passes schema through without modification", () => {
    const complexSchema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
          // No additionalProperties: false — wouldn't be strict-compatible
        },
        optional_field: { type: "number" },
      },
      required: ["nested"],
      // Note: optional_field is not in required — not strict-compatible
    };

    registerRaw(
      "mcp_complex",
      "Complex schema",
      complexSchema,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const tools = getToolsByName("mcp_complex");
    expect(tools![0].function.parameters).toEqual(complexSchema);
    expect(tools![0].function.strict).toBe(false);
  });
});
