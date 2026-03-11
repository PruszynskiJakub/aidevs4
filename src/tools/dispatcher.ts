import { join } from "path";
import { files } from "../services/file.ts";
import type { LLMTool } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { safeParse } from "../utils/parse.ts";
import { toolOk, toolError, isToolResponse } from "../utils/tool-response.ts";

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

function wrapResult(result: unknown): string {
  if (isToolResponse(result)) return JSON.stringify(result);
  return JSON.stringify(toolOk(result));
}

function wrapError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hints = buildErrorHints(message);
  return JSON.stringify(toolError(message, hints.length ? hints : undefined));
}

function buildErrorHints(message: string): string[] {
  const hints: string[] = [];
  const lower = message.toLowerCase();
  if (lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent")) {
    hints.push("Hint: check the path or download it first with agents_hub__download.");
  }
  if (lower.includes("json") && (lower.includes("parse") || lower.includes("invalid") || lower.includes("unexpected"))) {
    hints.push("Hint: the value must be valid JSON. Check for unescaped quotes.");
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("timeout")) {
    hints.push("Hint: the hub may be unreachable. Retry in a moment.");
  }
  return hints;
}

export async function dispatch(name: string, argsJson: string): Promise<string> {
  const handlers = await getHandlers();
  let tool = handlers.get(name);

  if (tool) {
    try {
      const args = safeParse(argsJson, name);
      const result = await tool.handler(args);
      return wrapResult(result);
    } catch (err: unknown) {
      return wrapError(err);
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
        const payload = safeParse(argsJson, name);
        const result = await tool.handler({ action: actionName, payload });
        return wrapResult(result);
      } catch (err: unknown) {
        return wrapError(err);
      }
    }
  }

  return JSON.stringify(toolError(`Unknown tool: ${name}`));
}
