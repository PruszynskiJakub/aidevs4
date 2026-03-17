import type { LLMTool } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolFilter } from "../types/assistant.ts";
import { safeParse } from "../utils/parse.ts";
import { toolOk, toolError, isToolResponse } from "../utils/tool-response.ts";

const SEPARATOR = "__";

export interface ActionSchema {
  description: string;
  parameters: Record<string, unknown>;
}

export interface MultiActionSchema {
  name: string;
  description: string;
  actions: Record<string, ActionSchema>;
}

export interface SimpleSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const handlers = new Map<string, ToolDefinition>();
const expandedTools: LLMTool[] = [];

export function register(
  tool: ToolDefinition,
  schema: MultiActionSchema | SimpleSchema,
): void {
  if (handlers.has(tool.name)) {
    throw new Error(`Duplicate tool registration: "${tool.name}"`);
  }

  handlers.set(tool.name, tool);

  if ("actions" in schema && schema.actions) {
    const multi = schema as MultiActionSchema;
    for (const [actionName, actionDef] of Object.entries(multi.actions)) {
      expandedTools.push({
        type: "function",
        function: {
          name: `${multi.name}${SEPARATOR}${actionName}`,
          description: `${multi.description} — ${actionDef.description}`,
          parameters: actionDef.parameters,
          strict: true,
        },
      });
    }
  } else {
    const simple = schema as SimpleSchema;
    expandedTools.push({
      type: "function",
      function: {
        name: simple.name,
        description: simple.description,
        parameters: simple.parameters,
        strict: true,
      },
    });
  }
}

/** Extract base tool name (before `__` separator for multi-action tools). */
function baseName(expandedName: string): string {
  const idx = expandedName.indexOf(SEPARATOR);
  return idx === -1 ? expandedName : expandedName.slice(0, idx);
}

function matchesFilter(name: string, filter?: ToolFilter): boolean {
  if (!filter) return true;
  const base = baseName(name);
  if (filter.include) return filter.include.includes(base);
  if (filter.exclude) return !filter.exclude.includes(base);
  return true;
}

export async function getTools(filter?: ToolFilter): Promise<LLMTool[]> {
  if (!filter) return expandedTools;
  return expandedTools.filter((t) => matchesFilter(t.function.name, filter));
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

export async function dispatch(name: string, argsJson: string, filter?: ToolFilter): Promise<string> {
  if (!matchesFilter(name, filter)) {
    return JSON.stringify(toolError(`Tool not allowed: ${name}`));
  }

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

  // Multi-action routing: tool_name__action_name -> handler(tool_name) with { action, payload }
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

export function reset(): void {
  handlers.clear();
  expandedTools.length = 0;
}
