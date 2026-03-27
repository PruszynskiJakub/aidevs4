import type { LLMTool } from "../types/llm.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { safeParse } from "../utils/parse.ts";
import { createErrorDocument, documentService, formatDocumentsXml } from "../infra/document.ts";

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

/** Return all tools (no filtering). */
export async function getTools(): Promise<LLMTool[]> {
  return expandedTools;
}

/** Return all expanded tools for a base name, or undefined if not registered. */
export function getToolsByName(name: string): LLMTool[] | undefined {
  const matched = expandedTools.filter((t) => baseName(t.function.name) === name);
  return matched.length > 0 ? matched : undefined;
}

export interface DispatchResult {
  xml: string;
  isError: boolean;
}

async function tryDispatch(
  name: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  try {
    const result = await tool.handler(args);
    const docs = Array.isArray(result) ? result : [result];
    for (const doc of docs) documentService.add(doc);
    return { xml: formatDocumentsXml(result), isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { xml: formatDocumentsXml(createErrorDocument(name, message)), isError: true };
  }
}

export async function dispatch(name: string, argsJson: string): Promise<DispatchResult> {
  const parsed = safeParse<Record<string, unknown>>(argsJson, name);

  const tool = handlers.get(name);
  if (tool) return tryDispatch(name, tool, parsed);

  // Multi-action routing: tool_name__action_name -> handler(tool_name) with { action, payload }
  const sepIdx = name.indexOf(SEPARATOR);
  if (sepIdx !== -1) {
    const toolName = name.slice(0, sepIdx);
    const actionName = name.slice(sepIdx + SEPARATOR.length);
    const multiTool = handlers.get(toolName);

    if (multiTool) return tryDispatch(name, multiTool, { action: actionName, payload: parsed });
  }

  return { xml: formatDocumentsXml(createErrorDocument(name, `Unknown tool: ${name}`)), isError: true };
}

export function reset(): void {
  handlers.clear();
  expandedTools.length = 0;
}
