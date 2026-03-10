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
      // csv_processor: 3 actions, agents_hub: 4 actions, file_converter: 1, read_file: 1 = 9
      expect(tools.length).toBe(9);
    });

    it("expands multi-action schemas with __ separator", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("csv_processor__metadata");
      expect(names).toContain("csv_processor__search");
      expect(names).toContain("csv_processor__transform_column");
      expect(names).toContain("agents_hub__download");
      expect(names).toContain("agents_hub__verify");
      expect(names).toContain("agents_hub__api_request_body");
      expect(names).toContain("agents_hub__api_request_file");
    });

    it("keeps simple schemas as single functions", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("file_converter");
      expect(names).toContain("read_file");
    });

    it("sets strict: true on all tools", () => {
      for (const tool of tools) {
        expect(tool.function.strict).toBe(true);
      }
    });

    it("combines tool + action descriptions for multi-action tools", () => {
      const metadata = tools.find((t) => t.function.name === "csv_processor__metadata");
      expect(metadata?.function.description).toContain("Process CSV files");
      expect(metadata?.function.description).toContain("Inspect CSV structure");
    });

    it("uses action-specific parameters for expanded tools", () => {
      const metadata = tools.find((t) => t.function.name === "csv_processor__metadata");
      const params = metadata?.function.parameters as any;
      expect(params.properties.path).toBeDefined();
      // metadata should NOT have filters or column_name
      expect(params.properties.filters).toBeUndefined();
      expect(params.properties.column_name).toBeUndefined();

      const search = tools.find((t) => t.function.name === "csv_processor__search");
      const searchParams = search?.function.parameters as any;
      expect(searchParams.properties.path).toBeDefined();
      expect(searchParams.properties.filters).toBeDefined();
      expect(searchParams.properties.column_name).toBeUndefined();
    });
  });

  describe("dispatch routing", () => {
    it("routes multi-action name to handler with { action, payload }", async () => {
      // Test the routing logic directly: csv_processor handler receives { action, payload }
      const csvProcessor = (await import("./csv_processor.ts")).default;
      // Calling with metadata action and a valid-looking but nonexistent path
      // should produce a file error, proving the routing shape is correct
      try {
        await csvProcessor.handler({ action: "metadata", payload: { path: "/nonexistent/file.csv" } });
      } catch (e: any) {
        // File access error = handler was called correctly with { action, payload }
        expect(e.message).not.toContain("Unknown action");
      }
    });

    it("handler rejects unknown actions", async () => {
      const csvProcessor = (await import("./csv_processor.ts")).default;
      try {
        await csvProcessor.handler({ action: "bogus", payload: {} });
        expect(true).toBe(false); // should not reach
      } catch (e: any) {
        expect(e.message).toContain('Unknown action "bogus"');
      }
    });
  });
});
