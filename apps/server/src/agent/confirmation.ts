import { randomUUID } from "node:crypto";
import type { LLMToolCall } from "../types/llm.ts";
import type { ConfirmationRequest, GateResult } from "../types/confirmation.ts";
import { getToolMeta, SEPARATOR } from "../tools/registry.ts";
import { safeParse } from "../utils/parse.ts";

export type { ConfirmationRequest } from "../types/confirmation.ts";

// ── Types ──────────────────────────────────────────────────

interface PendingConfirmation {
  requests: ConfirmationRequest[];
  toolCalls: LLMToolCall[];
}

// ── Module state ───────────────────────────────────────────

/**
 * In-memory cache of pending confirmations by `confirmationId`. The
 * durable record is the run row (status='waiting', waitingOn JSON).
 * This cache is optional — a synchronous in-process resume (e.g. CLI
 * provider) reads from here to avoid a DB round-trip.
 */
const pendingConfirmations = new Map<string, PendingConfirmation>();

// ── Helpers ────────────────────────────────────────────────

function extractAction(expandedName: string): string {
  const idx = expandedName.indexOf(SEPARATOR);
  return idx === -1 ? expandedName : expandedName.slice(idx + SEPARATOR.length);
}

// ── Public API ─────────────────────────────────────────────

export function takePendingConfirmation(id: string): PendingConfirmation | undefined {
  const p = pendingConfirmations.get(id);
  if (p) pendingConfirmations.delete(id);
  return p;
}

export function setConfirmationProvider(p: import("../types/confirmation.ts").ConfirmationProvider): void {
  // Reserved for future use by eval harness / Slack provider.
  // Currently a no-op — the CLI reads from pendingConfirmations directly.
  void p;
}

/**
 * Inspect a batch of tool calls for any that need operator approval.
 * Calls not requiring approval are returned as `approved`. If any
 * call requires approval, this function does NOT block — instead it
 * persists a pending-confirmation record and returns `waitingOn`,
 * which the loop converts into a `waiting` run exit.
 *
 * When gated calls exist, `approved` contains only auto-approved calls;
 * gated calls remain pending in `pendingConfirmations`.
 */
export async function confirmBatch(calls: LLMToolCall[]): Promise<GateResult> {
  const needsApproval: Array<{ call: LLMToolCall; request: ConfirmationRequest }> = [];
  const autoApproved: LLMToolCall[] = [];

  for (const call of calls) {
    const name = call.function.name;
    const meta = getToolMeta(name);
    if (!meta?.confirmIf) {
      autoApproved.push(call);
      continue;
    }

    const parsed = safeParse<Record<string, unknown>>(call.function.arguments, name);
    const shouldConfirm = meta.confirmIf({
      action: extractAction(name),
      args: parsed,
      toolCallId: call.id,
    });

    if (shouldConfirm) {
      needsApproval.push({ call, request: { toolCallId: call.id, toolName: name, args: parsed } });
    } else {
      autoApproved.push(call);
    }
  }

  if (needsApproval.length === 0) {
    return { approved: calls, denied: [] };
  }

  const requests = needsApproval.map((e) => e.request);
  const toolCalls = needsApproval.map((e) => e.call);

  const confirmationId = randomUUID();
  pendingConfirmations.set(confirmationId, { requests, toolCalls });

  const prompt = requests
    .map((r) => `${r.toolName}(${JSON.stringify(r.args)})`)
    .join("\n");

  return {
    approved: autoApproved,
    denied: [],
    waitingOn: {
      kind: "user_approval",
      confirmationId,
      prompt,
    },
  };
}
