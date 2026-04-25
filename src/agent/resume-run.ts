import type { LLMMessage, LLMAssistantMessage } from "../types/llm.ts";
import type { RunState } from "../types/run-state.ts";
import type { WaitDescriptor, WaitResolution } from "./wait-descriptor.ts";
import type { ExecuteRunResult } from "./orchestrator.ts";
import type { RunExit } from "./run-exit.ts";
import type { Decision } from "../types/tool.ts";
import type { DbRun } from "../types/db.ts";
import { bus } from "../infra/events.ts";
import { sessionService } from "./session.ts";
import { agentsService } from "./agents.ts";
import { emptyMemoryState } from "../types/memory.ts";
import { loadState } from "./memory/persistence.ts";
import { dispatch } from "../tools/registry.ts";
import { runAndPersist } from "./orchestrator.ts";
import * as dbOps from "../infra/db/index.ts";
import { randomUUID } from "node:crypto";

/**
 * Resume a run that is in `status='waiting'`. Validates state,
 * appends synthetic tool-result messages for the previously pending
 * tool calls, clears `waitingOn`, sets `status='running'`, emits
 * `run.resumed`, and re-enters the loop via `runAndPersist`.
 *
 * Returns the new `RunExit` for the resumed attempt.
 */
export async function resumeRun(
  runId: string,
  resolution: WaitResolution,
): Promise<ExecuteRunResult> {
  const run = dbOps.getRun(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  if (run.status !== "waiting") {
    // Already resumed (idempotent) — return current state as no-op
    return {
      exit: dbRunToExit(run),
      sessionId: run.sessionId,
      runId,
    };
  }
  if (!run.waitingOn) {
    throw new Error(`Run ${runId} has no waitingOn descriptor`);
  }

  const waitingOn = JSON.parse(run.waitingOn) as WaitDescriptor;
  if (waitingOn.kind !== resolution.kind) {
    throw new Error(
      `Resolution kind '${resolution.kind}' does not match waitingOn.kind '${waitingOn.kind}'`,
    );
  }

  // Load the persisted transcript for this run
  const messages = sessionService.getMessages(run.sessionId, runId);

  // Find the most recent assistant message with tool calls that still
  // lack function_call_output responses. Those are what we must answer.
  const pending = findPendingToolCalls(messages);

  const newMessages: LLMMessage[] = [];

  if (waitingOn.kind === "user_approval" && resolution.kind === "user_approval") {
    const decisions = normalizeDecisions(resolution.decisions);
    for (const call of pending) {
      const decision = decisions.get(call.id) ?? "deny";
      if (decision === "approve") {
        try {
          const result = await dispatch(
            call.function.name,
            call.function.arguments,
            call.id,
          );
          newMessages.push({
            role: "tool",
            toolCallId: call.id,
            content: result.content,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          newMessages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Error: ${msg}`,
          });
        }
      } else {
        newMessages.push({
          role: "tool",
          toolCallId: call.id,
          content: "Error: Tool call denied by operator.",
        });
      }
    }
  } else if (waitingOn.kind === "child_run" && resolution.kind === "child_run") {
    // Reserved path — currently no code emits a child_run waiting state.
    for (const call of pending) {
      newMessages.push({
        role: "tool",
        toolCallId: call.id,
        content: resolution.result,
      });
    }
  }

  // Persist synthetic tool-result messages
  sessionService.appendRun(run.sessionId, runId, newMessages);

  // Clear waitingOn, transition back to running (with optimistic lock)
  const updated = dbOps.updateRunStatus(runId, {
    status: "running",
    waitingOn: null,
    expectedVersion: run.version,
  });
  if (!updated) {
    // Another process already resumed this run — idempotent return
    const current = dbOps.getRun(runId);
    return {
      exit: dbRunToExit(current ?? run),
      sessionId: run.sessionId,
      runId,
    };
  }

  bus.emit("run.resumed", {
    resolution,
  });

  // Rebuild run state from DB for the next attempt
  const fullMessages = sessionService.getMessages(run.sessionId, runId);
  const persisted = await loadState(run.sessionId);
  const assistantName = run.template;
  const resolved = await agentsService.resolve(assistantName);

  const parentDepth = run.parentId ? 1 : 0;

  const state: RunState = {
    sessionId: run.sessionId,
    agentName: assistantName,
    runId,
    rootRunId: run.rootRunId ?? runId,
    parentRunId: run.parentId ?? undefined,
    traceId: randomUUID(),
    depth: parentDepth,
    messages: fullMessages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: assistantName,
    model: resolved.model,
    tools: resolved.tools,
    memory: persisted ?? emptyMemoryState(),
  };

  return runAndPersist(state);
}

function findPendingToolCalls(messages: LLMMessage[]) {
  // Collect all toolCall ids that already have a response
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      answered.add(m.toolCallId);
    }
  }

  // Walk backwards; the most recent assistant message with unanswered
  // toolCalls is the one we are resuming from.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const asst = m as LLMAssistantMessage;
    if (!asst.toolCalls || asst.toolCalls.length === 0) continue;
    const pending = asst.toolCalls.filter((tc) => !answered.has(tc.id));
    if (pending.length > 0) return pending;
  }
  return [];
}

function normalizeDecisions(
  raw: Record<string, "approve" | "deny">,
): Map<string, Decision> {
  return new Map(Object.entries(raw));
}

/** Convert a DB run row to a RunExit for idempotent resume returns. */
function dbRunToExit(run: DbRun): RunExit {
  switch (run.status) {
    case "completed":
      return { kind: "completed", result: run.result ?? "" };
    case "failed":
      return { kind: "failed", error: { message: run.error ?? "unknown" } };
    case "cancelled":
      return { kind: "cancelled", reason: run.error ?? "unknown" };
    case "exhausted":
      return { kind: "exhausted", cycleCount: run.cycleCount };
    case "waiting":
      return { kind: "waiting", waitingOn: JSON.parse(run.waitingOn!) };
    default:
      return { kind: "failed", error: { message: `Unexpected status: ${run.status}` } };
  }
}
