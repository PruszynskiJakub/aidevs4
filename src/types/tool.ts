import type { z } from "zod";
import type { ToolResult } from "./tool-result.ts";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type Decision = "approve" | "deny";

export interface ConfirmableToolCall {
  action: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

export interface SimpleToolSchema {
  name: string;
  description: string;
  schema: z.ZodObject;
}

export interface ActionDef {
  description: string;
  schema: z.ZodObject;
}

export interface MultiActionToolSchema {
  name: string;
  description: string;
  actions: Record<string, ActionDef>;
}

export type ToolSchema = SimpleToolSchema | MultiActionToolSchema;

export interface ToolDefinition {
  name: string;
  schema: ToolSchema;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
  confirmIf?: (call: ConfirmableToolCall) => boolean;
}
