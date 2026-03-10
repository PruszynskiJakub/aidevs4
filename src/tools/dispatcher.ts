import { join } from "path";
import { files } from "../services/file.ts";
import type { LLMTool } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const TOOLS_DIR = import.meta.dir;

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

async function loadToolDefinitions(): Promise<Map<string, ToolDefinition>> {
  const map = new Map<string, ToolDefinition>();
  const entries = await files.readdir(TOOLS_DIR);

  for (const entry of entries) {
    if (entry === "dispatcher.ts" || entry.endsWith(".test.ts") || !entry.endsWith(".ts")) continue;
    const mod = await import(join(TOOLS_DIR, entry));
    const def: ToolDefinition = mod.default;
    if (def?.name && typeof def?.handler === "function") {
      map.set(def.name, def);
    }
  }

  return map;
}

async function loadSchemas(): Promise<LLMTool[]> {
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

let cachedTools: LLMTool[] | null = null;
let cachedHandlers: Map<string, ToolDefinition> | null = null;

export async function getTools(): Promise<LLMTool[]> {
  if (!cachedTools) {
    cachedTools = await loadSchemas();
  }
  return cachedTools;
}

async function getHandlers(): Promise<Map<string, ToolDefinition>> {
  if (!cachedHandlers) {
    cachedHandlers = await loadToolDefinitions();
  }
  return cachedHandlers;
}

export async function dispatch(name: string, argsJson: string): Promise<string> {
  const handlers = await getHandlers();
  let tool = handlers.get(name);

  if (tool) {
    try {
      const args = JSON.parse(argsJson);
      const result = await tool.handler(args);
      return JSON.stringify(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  }

  // Multi-action routing: tool_name__action_name → handler(tool_name) with { action, payload }
  const sepIdx = name.indexOf(SEPARATOR);
  if (sepIdx !== -1) {
    const toolName = name.slice(0, sepIdx);
    const actionName = name.slice(sepIdx + SEPARATOR.length);
    tool = handlers.get(toolName);

    if (tool) {
      try {
        const payload = JSON.parse(argsJson);
        const result = await tool.handler({ action: actionName, payload });
        return JSON.stringify(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}
