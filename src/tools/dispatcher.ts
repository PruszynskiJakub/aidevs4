import { join } from "path";
import { files } from "../services/file.ts";
import type { LLMTool } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const TOOLS_DIR = import.meta.dir;

async function loadToolDefinitions(): Promise<Map<string, ToolDefinition>> {
  const map = new Map<string, ToolDefinition>();
  const entries = await files.readdir(TOOLS_DIR);

  for (const entry of entries) {
    if (entry === "dispatcher.ts" || !entry.endsWith(".ts")) continue;
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
    const schema = await files.readJson<{ name: string; description: string; parameters: Record<string, unknown> }>(join(SCHEMAS_DIR, entry));
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
  const tool = handlers.get(name);

  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    const args = JSON.parse(argsJson);
    const result = await tool.handler(args);
    return JSON.stringify(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}
