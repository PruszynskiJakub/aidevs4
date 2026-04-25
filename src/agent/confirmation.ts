import { randomUUID } from "node:crypto";
import type { LLMToolCall } from "../types/llm.ts";
import type { Decision } from "../types/tool.ts";
import type { ConfirmationRequest, ConfirmationProvider, GateResult } from "../types/confirmation.ts";
import { getToolMeta, SEPARATOR } from "../tools/registry.ts";
import { bus } from "../infra/events.ts";
import { safeParse } from "../utils/parse.ts";
import { WaitRequested } from "./wait-descriptor.ts";

export type { ConfirmationRequest, ConfirmationProvider, GateResult } from "../types/confirmation.ts";

let provider: ConfirmationProvider | null = null;

export function setConfirmationProvider(p: ConfirmationProvider): void {
  provider = p;
}

export function clearConfirmationProvider(): void {
  provider = null;
}

/**
 * In-memory cache of pending confirmations by `confirmationId`. The
 * durable record is the run row (status='waiting', waitingOn JSON).
 * This cache is optional — a synchronous in-process resume (e.g. CLI
 * provider) reads from here to avoid a DB round-trip.
 */
interface PendingConfirmation {
  requests: ConfirmationRequest[];
  toolCalls: LLMToolCall[];
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

export function takePendingConfirmation(id: string): PendingConfirmation | undefined {
  const p = pendingConfirmations.get(id);
  if (p) pendingConfirmations.delete(id);
  return p;
}

export function peekPendingConfirmation(id: string): PendingConfirmation | undefined {
  return pendingConfirmations.get(id);
}

export function clearPendingConfirmations(): void {
  pendingConfirmations.clear();
}

function extractAction(expandedName: string): string {
  const idx = expandedName.indexOf(SEPARATOR);
  return idx === -1 ? expandedName : expandedName.slice(idx + SEPARATOR.length);
}

/**
 * Inspect a batch of tool calls for any that need operator approval.
 * Calls not requiring approval are returned as `approved`. If any
 * call requires approval, this function does NOT block — instead it
 * persists a pending-confirmation record and throws `WaitRequested`,
 * which the loop converts into a `waiting` run exit.
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

  throw new WaitRequested({
    kind: "user_approval",
    confirmationId,
    prompt,
  });
}

/**
 * For callers that want in-process, synchronous approval (e.g. the CLI
 * provider loop). Reads decisions from the configured provider and
 * returns them, bypassing the durable pause path entirely.
 */
export async function readDecisionsFromProvider(
  requests: ConfirmationRequest[],
): Promise<Map<string, Decision>> {
  if (!provider) {
    return new Map(requests.map((r) => [r.toolCallId, "approve" as const]));
  }
  try {
    return await provider.confirm(requests);
  } catch (err) {
    console.error("[confirmation] Provider error, denying all pending calls:", err);
    return new Map(requests.map((r) => [r.toolCallId, "deny" as const]));
  }
}
