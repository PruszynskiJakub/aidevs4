import type { ToolResult } from "../types/tool-result.ts";

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

function createResultStore() {
  const records = new Map<string, ToolCallRecord>();

  return {
    create(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
      records.set(toolCallId, {
        toolCallId,
        toolName,
        args,
        result: null,
        tokens: 0,
        status: "pending",
        createdAt: Date.now(),
        completedAt: null,
      });
    },

    complete(toolCallId: string, result: ToolResult, tokens: number): void {
      const record = records.get(toolCallId);
      if (!record) {
        // Create on the fly if not pre-registered
        records.set(toolCallId, {
          toolCallId,
          toolName: "unknown",
          args: {},
          result,
          tokens,
          status: result.isError ? "error" : "ok",
          createdAt: Date.now(),
          completedAt: Date.now(),
        });
        return;
      }
      record.result = result;
      record.tokens = tokens;
      record.status = result.isError ? "error" : "ok";
      record.completedAt = Date.now();
    },

    get(toolCallId: string): ToolCallRecord | undefined {
      return records.get(toolCallId);
    },

    list(): ToolCallRecord[] {
      return [...records.values()];
    },

    clear(): void {
      records.clear();
    },
  };
}

export const resultStore = createResultStore();
export { createResultStore };
