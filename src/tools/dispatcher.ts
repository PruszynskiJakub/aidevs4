import { readdir } from "fs/promises";
import { join } from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolDefinition } from "../types/tool.ts";

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const TOOLS_DIR = import.meta.dir;

async function loadToolDefinitions(): Promise<Map<string, ToolDefinition>> {
  const map = new Map<string, ToolDefinition>();
  const entries = await readdir(TOOLS_DIR);

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

async function loadSchemas(): Promise<ChatCompletionTool[]> {
  const entries = await readdir(SCHEMAS_DIR);
  const tools: ChatCompletionTool[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const schema = await Bun.file(join(SCHEMAS_DIR, entry)).json();
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

let cachedTools: ChatCompletionTool[] | null = null;
let cachedHandlers: Map<string, ToolDefinition> | null = null;

export async function getTools(): Promise<ChatCompletionTool[]> {
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
