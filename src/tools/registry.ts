import { z } from "zod";
import type { LLMTool } from "../types/llm.ts";
import type { ContentPart } from "../types/llm.ts";
import type { ToolDefinition, ToolSchema, ToolAnnotations } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { safeParse } from "../utils/parse.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { resultStore } from "../infra/result-store.ts";

export const SEPARATOR = "__";

const handlers = new Map<string, ToolDefinition>();
const expandedTools: LLMTool[] = [];

function zodToParameters(schema: z.ZodObject): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  // Remove $schema key — not part of OpenAI function-calling format
  delete (jsonSchema as Record<string, unknown>)["$schema"];
  return jsonSchema as Record<string, unknown>;
}

export function register(tool: ToolDefinition): void {
  if (handlers.has(tool.name)) {
    throw new Error(`Duplicate tool registration: "${tool.name}"`);
  }

  handlers.set(tool.name, tool);
  const schema = tool.schema;

  if ("actions" in schema && schema.actions) {
    for (const [actionName, actionDef] of Object.entries(schema.actions)) {
      expandedTools.push({
        type: "function",
        function: {
          name: `${schema.name}${SEPARATOR}${actionName}`,
          description: `${schema.description} — ${actionDef.description}`,
          parameters: zodToParameters(actionDef.schema),
          strict: true,
        },
      });
    }
  } else {
    const simple = schema as { name: string; description: string; schema: z.ZodObject };
    expandedTools.push({
      type: "function",
      function: {
        name: simple.name,
        description: simple.description,
        parameters: zodToParameters(simple.schema),
        strict: true,
      },
    });
  }
}

/**
 * Register a tool with a pre-built JSON Schema, bypassing Zod conversion.
 * Used for MCP tools whose schemas are already JSON Schema from the server.
 * Registered with strict: false since MCP schemas may not satisfy OpenAI strict requirements.
 */
export function registerRaw(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  annotations?: ToolAnnotations,
): void {
  if (handlers.has(name)) {
    throw new Error(`Duplicate tool registration: "${name}"`);
  }

  handlers.set(name, {
    name,
    schema: { name, description, schema: {} as z.ZodObject },
    handler,
    annotations,
  });

  expandedTools.push({
    type: "function",
    function: {
      name,
      description,
      parameters,
      strict: false,
    },
  });
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

export type { ToolMeta, DispatchResult } from "../types/tool.ts";
import type { ToolMeta, DispatchResult } from "../types/tool.ts";

export function getToolMeta(expandedName: string): ToolMeta | undefined {
  const direct = handlers.get(expandedName);
  if (direct) return { annotations: direct.annotations, confirmIf: direct.confirmIf };

  const base = baseName(expandedName);
  if (base !== expandedName) {
    const tool = handlers.get(base);
    if (tool) return { annotations: tool.annotations, confirmIf: tool.confirmIf };
  }
  return undefined;
}

/** Serialize content parts to plain text. */
export function serializeContent(parts: ContentPart[]): string {
  return parts.map((part) => {
    switch (part.type) {
      case "text":
        return part.text;
      case "image": {
        const sizeKB = Math.ceil(part.data.length * 3 / 4 / 1024);
        return `[Image: ${part.mimeType}, ${sizeKB}KB]`;
      }
      case "resource":
        return `${part.description} (ref: ${part.uri})`;
    }
  }).join("\n\n");
}

async function tryDispatch(
  name: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  toolCallId: string,
): Promise<DispatchResult> {
  try {
    const result = await tool.handler(args, { toolCallId });
    const content = serializeContent(result.content);
    const tokens = estimateTokens(content);
    resultStore.complete(toolCallId, result, tokens);
    return { content, isError: result.isError ?? false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorResult: ToolResult = { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    const content = `Error: ${message}`;
    const tokens = estimateTokens(content);
    resultStore.complete(toolCallId, errorResult, tokens);
    return { content, isError: true };
  }
}

export async function dispatch(name: string, argsJson: string, toolCallId: string = ""): Promise<DispatchResult> {
  const parsed = safeParse<Record<string, unknown>>(argsJson, name);

  const tool = handlers.get(name);
  if (tool) {
    resultStore.create(toolCallId, name, parsed);
    return tryDispatch(name, tool, parsed, toolCallId);
  }

  // Multi-action routing: tool_name__action_name -> handler(tool_name) with { action, payload }
  const sepIdx = name.indexOf(SEPARATOR);
  if (sepIdx !== -1) {
    const toolName = name.slice(0, sepIdx);
    const actionName = name.slice(sepIdx + SEPARATOR.length);
    const multiTool = handlers.get(toolName);

    if (multiTool) {
      const multiArgs = { action: actionName, payload: parsed };
      resultStore.create(toolCallId, name, multiArgs);
      return tryDispatch(name, multiTool, multiArgs, toolCallId);
    }
  }

  const errorContent = `Error: Unknown tool: ${name}`;
  const errorResult: ToolResult = { content: [{ type: "text", text: errorContent }], isError: true };
  resultStore.create(toolCallId, name, parsed);
  resultStore.complete(toolCallId, errorResult, estimateTokens(errorContent));
  return { content: errorContent, isError: true };
}

export function reset(): void {
  handlers.clear();
  expandedTools.length = 0;
  resultStore.clear();
}
