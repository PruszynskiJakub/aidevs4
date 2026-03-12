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
      // agents_hub: 5 actions + geo_distance: 2 actions + shipping: 2 actions + think: 1 + bash: 1 = 11
      expect(tools.length).toBe(11);
    });

    it("expands multi-action schemas with __ separator", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("agents_hub__download");
      expect(names).toContain("agents_hub__verify");
      expect(names).toContain("agents_hub__api_request_body");
      expect(names).toContain("agents_hub__api_request_file");
      expect(names).toContain("agents_hub__api_batch");
      expect(names).toContain("geo_distance__find_nearby");
      expect(names).toContain("geo_distance__distance");
    });

    it("includes simple tools", () => {
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("think");
      expect(names).toContain("bash");
    });

    it("sets strict: true on all tools", () => {
      for (const tool of tools) {
        expect(tool.function.strict).toBe(true);
      }
    });
  });
});
