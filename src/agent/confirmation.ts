import type { LLMToolCall } from "../types/llm.ts";
import { getToolMeta } from "../tools/registry.ts";
import { bus } from "../infra/events.ts";
import { safeParse } from "../utils/parse.ts";

// ── Types ──────────────────────────────────────────────────

export interface ConfirmationRequest {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ConfirmationProvider {
  confirm(requests: ConfirmationRequest[]): Promise<Map<string, "approve" | "deny">>;
}

export interface GateResult {
  approved: LLMToolCall[];
  denied: Array<{ call: LLMToolCall; reason: string }>;
}

// ── Global provider slot ───────────────────────────────────

let provider: ConfirmationProvider | null = null;

export function setConfirmationProvider(p: ConfirmationProvider): void {
  provider = p;
}

export function clearConfirmationProvider(): void {
  provider = null;
}

// ── Classification ─────────────────────────────────────────

const SEPARATOR = "__";

function extractAction(expandedName: string): string {
  const idx = expandedName.indexOf(SEPARATOR);
  return idx === -1 ? expandedName : expandedName.slice(idx + SEPARATOR.length);
}

function needsConfirmation(toolCall: LLMToolCall): boolean {
  const name = toolCall.function.name;
  const meta = getToolMeta(name);
  if (!meta?.confirmIf) return false;

  const parsed = safeParse<Record<string, unknown>>(toolCall.function.arguments, name);
  return meta.confirmIf({
    action: extractAction(name),
    args: parsed,
    callId: toolCall.id,
  });
}

// ── Batch gate ─────────────────────────────────────────────

export async function confirmBatch(calls: LLMToolCall[]): Promise<GateResult> {
  if (!provider) {
    return { approved: calls, denied: [] };
  }

  const needsApproval: LLMToolCall[] = [];
  const autoApproved: LLMToolCall[] = [];

  for (const call of calls) {
    if (needsConfirmation(call)) {
      needsApproval.push(call);
    } else {
      autoApproved.push(call);
    }
  }

  if (needsApproval.length === 0) {
    return { approved: calls, denied: [] };
  }

  const requests: ConfirmationRequest[] = needsApproval.map((tc) => ({
    callId: tc.id,
    toolName: tc.function.name,
    args: safeParse<Record<string, unknown>>(tc.function.arguments, tc.function.name),
  }));

  bus.emit("confirmation.requested", {
    calls: requests.map((r) => ({ callId: r.callId, toolName: r.toolName })),
  });

  let decisions: Map<string, "approve" | "deny">;
  try {
    decisions = await provider.confirm(requests);
  } catch (err) {
    console.error("[confirmation] Provider error, denying all pending calls:", err);
    decisions = new Map(requests.map((r) => [r.callId, "deny" as const]));
  }

  const approved = [...autoApproved];
  const denied: GateResult["denied"] = [];

  for (const tc of needsApproval) {
    const decision = decisions.get(tc.id) ?? "deny";
    if (decision === "approve") {
      approved.push(tc);
    } else {
      denied.push({ call: tc, reason: "Denied by operator" });
    }
  }

  bus.emit("confirmation.resolved", {
    approved: approved.filter((tc) => needsApproval.includes(tc)).map((tc) => tc.id),
    denied: denied.map((d) => d.call.id),
  });

  return { approved, denied };
}
