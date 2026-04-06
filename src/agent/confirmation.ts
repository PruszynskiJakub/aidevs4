import type { LLMToolCall } from "../types/llm.ts";
import type { Decision } from "../types/tool.ts";
import { getToolMeta, SEPARATOR } from "../tools/registry.ts";
import { bus } from "../infra/events.ts";
import { safeParse } from "../utils/parse.ts";

export interface ConfirmationRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ConfirmationProvider {
  confirm(requests: ConfirmationRequest[]): Promise<Map<string, Decision>>;
}

export interface GateResult {
  approved: LLMToolCall[];
  denied: Array<{ call: LLMToolCall; reason: string }>;
}

let provider: ConfirmationProvider | null = null;

export function setConfirmationProvider(p: ConfirmationProvider): void {
  provider = p;
}

export function clearConfirmationProvider(): void {
  provider = null;
}

function extractAction(expandedName: string): string {
  const idx = expandedName.indexOf(SEPARATOR);
  return idx === -1 ? expandedName : expandedName.slice(idx + SEPARATOR.length);
}

export async function confirmBatch(calls: LLMToolCall[]): Promise<GateResult> {
  if (!provider) {
    return { approved: calls, denied: [] };
  }

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

  bus.emit("confirmation.requested", {
    calls: requests.map((r) => ({ toolCallId: r.toolCallId, toolName: r.toolName })),
  });

  let decisions: Map<string, Decision>;
  try {
    decisions = await provider.confirm(requests);
  } catch (err) {
    console.error("[confirmation] Provider error, denying all pending calls:", err);
    decisions = new Map(requests.map((r) => [r.toolCallId, "deny" as const]));
  }

  const approved = [...autoApproved];
  const denied: GateResult["denied"] = [];
  const operatorApprovedIds: string[] = [];

  for (const { call } of needsApproval) {
    const decision = decisions.get(call.id) ?? "deny";
    if (decision === "approve") {
      approved.push(call);
      operatorApprovedIds.push(call.id);
    } else {
      denied.push({ call, reason: "Denied by operator" });
    }
  }

  bus.emit("confirmation.resolved", {
    approved: operatorApprovedIds,
    denied: denied.map((d) => d.call.id),
  });

  return { approved, denied };
}
