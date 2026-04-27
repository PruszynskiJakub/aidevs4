import type { z } from "zod";
import type { ToolResult } from "./tool-result.ts";
import type { WaitDescriptor } from "../agent/wait-descriptor.ts";

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

export interface ToolCallContext {
  toolCallId: string;
}

export interface ToolDefinition {
  name: string;
  schema: ToolSchema;
  handler: (args: Record<string, unknown>, ctx?: ToolCallContext) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
  confirmIf?: (call: ConfirmableToolCall) => boolean;
}

export type ToolMeta = Pick<ToolDefinition, "annotations" | "confirmIf">;

export interface DispatchResult {
  content: string;
  isError: boolean;
  /** When set, the dispatch layer treats this as a park signal. */
  wait?: WaitDescriptor;
}
