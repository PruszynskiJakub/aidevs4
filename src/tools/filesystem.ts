import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";

// --- read_file ---

async function readFile(payload: { path: string; max_lines?: number }) {
  const raw = await files.readText(payload.path);
  if (!payload.max_lines) {
    return { path: payload.path, content: raw };
  }
  const allLines = raw.split("\n");
  const lines = allLines.slice(0, payload.max_lines);
  return {
    path: payload.path,
    total_lines: allLines.length,
    returned_lines: lines.length,
    truncated: allLines.length > payload.max_lines,
    content: lines.join("\n"),
  };
}

// --- dispatcher ---

const VALID_ACTIONS = ["read_file"] as const;
type Action = (typeof VALID_ACTIONS)[number];

const actionHandlers: Record<Action, (payload: any) => Promise<unknown>> = {
  read_file: readFile,
};

async function filesystem({ action, payload }: { action: string; payload: unknown }): Promise<unknown> {
  if (!VALID_ACTIONS.includes(action as Action)) {
    throw new Error(`Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}`);
  }
  return actionHandlers[action as Action](payload);
}

export default {
  name: "filesystem",
  handler: filesystem,
} satisfies ToolDefinition;
