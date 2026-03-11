import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "path";
import { files } from "../services/file.ts";
import type { LLMTool } from "../types/llm.ts";

// Avoid importing getTools/dispatch directly — agent.test.ts uses mock.module
// to replace the dispatcher module, and bun shares module mocks across files.
// Instead, replicate the loading logic here to test it in isolation.

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const SEPARATOR = "__";

interface ActionSchema {
  description: string;
  parameters: Record<string, unknown>;
}

interface MultiActionSchema {
  name: string;
  description: string;
  actions: Record<string, ActionSchema>;
}

interface SimpleSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

async function loadSchemasForTest(): Promise<LLMTool[]> {
  const entries = await files.readdir(SCHEMAS_DIR);
  const tools: LLMTool[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await files.readJson<MultiActionSchema | SimpleSchema>(join(SCHEMAS_DIR, entry));

    if ("actions" in raw && raw.actions) {
      const schema = raw as MultiActionSchema;
      for (const [actionName, actionDef] of Object.entries(schema.actions)) {
        tools.push({
          type: "function",
          function: {
            name: `${schema.name}${SEPARATOR}${actionName}`,
            description: `${schema.description} — ${actionDef.description}`,
            parameters: actionDef.parameters,
            strict: true,
          },
        });
      }
    } else {
      const schema = raw as SimpleSchema;
      tools.push({
        type: "function",
        function: {
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
          strict: true,
        },
      });
    }
  }

  return tools;
}

describe("dispatcher", () => {
  describe("getTools (schema expansion)", () => {
    let tools: LLMTool[];

    beforeAll(async () => {
      tools = await loadSchemasForTest();
    });

    it("returns all expanded tools", () => {
      // agents_hub: 5 actions + filesystem: 1 action + data_transformer: 4 actions + geo_distance: 2 actions = 12
      expect(tools.length).toBe(12);
    });

    it("expands multi-action schemas with __ separator", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("agents_hub__download");
      expect(names).toContain("agents_hub__verify");
      expect(names).toContain("agents_hub__api_request_body");
      expect(names).toContain("agents_hub__api_request_file");
      expect(names).toContain("agents_hub__api_batch");
      expect(names).toContain("filesystem__inspect");
      expect(names).toContain("data_transformer__filter");
      expect(names).toContain("data_transformer__sort");
      expect(names).toContain("data_transformer__add_field");
      expect(names).toContain("data_transformer__convert");
      expect(names).toContain("geo_distance__find_nearby");
      expect(names).toContain("geo_distance__distance");
    });

    it("sets strict: true on all tools", () => {
      for (const tool of tools) {
        expect(tool.function.strict).toBe(true);
      }
    });

    it("combines tool + action descriptions for multi-action tools", () => {
      const inspect = tools.find((t) => t.function.name === "filesystem__inspect");
      expect(inspect?.function.description).toContain("Inspect files and directories");
      expect(inspect?.function.description).toContain("Inspect a file or directory");
    });

    it("uses action-specific parameters for expanded tools", () => {
      const filter = tools.find((t) => t.function.name === "data_transformer__filter");
      const params = filter?.function.parameters as any;
      expect(params.properties.path).toBeDefined();
      expect(params.properties.conditions).toBeDefined();
      expect(params.properties.logic).toBeDefined();
      // filter should NOT have sort_by or field_name
      expect(params.properties.sort_by).toBeUndefined();
      expect(params.properties.field_name).toBeUndefined();

      const sort = tools.find((t) => t.function.name === "data_transformer__sort");
      const sortParams = sort?.function.parameters as any;
      expect(sortParams.properties.sort_by).toBeDefined();
      expect(sortParams.properties.conditions).toBeUndefined();
    });
  });

  describe("dispatch routing", () => {
    it("routes multi-action name to handler with { action, payload }", async () => {
      const filesystem = (await import("./filesystem.ts")).default;
      try {
        await filesystem.handler({ action: "inspect", payload: { path: "/nonexistent/file.csv" } });
      } catch (e: any) {
        // File access error = handler was called correctly with { action, payload }
        expect(e.message).not.toContain("Unknown action");
      }
    });

    it("handler rejects unknown actions", async () => {
      const filesystem = (await import("./filesystem.ts")).default;
      try {
        await filesystem.handler({ action: "bogus", payload: {} });
        expect(true).toBe(false); // should not reach
      } catch (e: any) {
        expect(e.message).toContain('Unknown action "bogus"');
      }
    });
  });
});
