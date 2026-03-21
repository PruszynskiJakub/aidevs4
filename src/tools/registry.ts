import type { LLMTool } from "../types/llm.ts";
import type { Document } from "../types/document.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolFilter } from "../types/tool.ts";
import { safeParse } from "../utils/parse.ts";
import { createErrorDocument, formatDocumentsXml } from "../utils/document.ts";
import { getState } from "../services/agent/session-context.ts";

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

function storeDocuments(docs: Document | Document[]): void {
  const state = getState();
  if (!state) return;
  const arr = Array.isArray(docs) ? docs : [docs];
  state.documents.push(...arr);
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
    storeDocuments(result);
    return { xml: formatDocumentsXml(result), isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const doc = createErrorDocument(name, message);
    storeDocuments(doc);
    return { xml: formatDocumentsXml(doc), isError: true };
  }
}

export async function dispatch(name: string, argsJson: string, filter?: ToolFilter): Promise<DispatchResult> {
  if (!matchesFilter(name, filter)) {
    const doc = createErrorDocument(name, `Tool not allowed: ${name}`);
    storeDocuments(doc);
    return { xml: formatDocumentsXml(doc), isError: true };
  }

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

  const doc = createErrorDocument(name, `Unknown tool: ${name}`);
  storeDocuments(doc);
  return { xml: formatDocumentsXml(doc), isError: true };
}

export function reset(): void {
  handlers.clear();
  expandedTools.length = 0;
}
