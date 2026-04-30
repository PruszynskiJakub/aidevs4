import type { ToolResult } from "./tool-result.ts";

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult | null;
  tokens: number;
  status: "pending" | "ok" | "error";
  createdAt: number;
  completedAt: number | null;
}
