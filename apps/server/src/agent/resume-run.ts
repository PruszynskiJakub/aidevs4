import type { LLMMessage, LLMAssistantMessage } from "../types/llm.ts";
import type { RunState } from "../types/run-state.ts";
import type { WaitDescriptor, WaitResolution } from "../types/wait.ts";
import type { ExecuteRunResult } from "./orchestrator.ts";
import type { RunExit } from "./run-exit.ts";
import type { Decision } from "../types/tool.ts";
import type { DbRun } from "../types/db.ts";
import { emptyMemoryState } from "../types/memory.ts";
import { loadState } from "./memory/persistence.ts";
import { dispatch } from "../tools/registry.ts";
import { runAndPersist } from "./orchestrator.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import * as dbOps from "../infra/db/index.ts";
import { randomUUID } from "node:crypto";
import { DomainError } from "../types/errors.ts";

// ── Helpers ────────────────────────────────────────────────

function findPendingToolCalls(messages: LLMMessage[]) {
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

// ── Public API ─────────────────────────────────────────────

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
  runtime: Runtime = createRuntime(),
): Promise<ExecuteRunResult> {
  const run = dbOps.getRun(runId);
  if (!run) {
    throw new DomainError({
      type: "not_found",
      message: "Run not found",
      internalMessage: `Unknown run: ${runId}`,
    });
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
    throw new DomainError({
      type: "conflict",
      message: "Run is not in a resumable state",
      internalMessage: `Run ${runId} has no waitingOn descriptor`,
    });
  }

  const waitingOn = JSON.parse(run.waitingOn) as WaitDescriptor;
  if (waitingOn.kind !== resolution.kind) {
    throw new DomainError({
      type: "validation",
      message: "Resolution does not match the run's waiting state",
      internalMessage: `Resolution kind '${resolution.kind}' does not match waitingOn.kind '${waitingOn.kind}'`,
    });
  }

  // Load the persisted transcript for this run
  const messages = runtime.sessions.getMessages(run.sessionId, runId);

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
    for (const call of pending) {
      newMessages.push({
        role: "tool",
        toolCallId: call.id,
        content: resolution.result,
      });
    }
  }

  // Atomic resume: optimistic-lock the status flip FIRST, then persist the
  // synthetic tool-result messages inside the same transaction. If the lock
  // check fails (another process resumed concurrently) the UPDATE matches no
  // rows, we skip the items insert, and return idempotently below.
  let lockWon = false;
  dbOps.withTransaction((tx) => {
    const updated = dbOps.updateRunStatus(runId, {
      status: "running",
      waitingOn: null,
      expectedVersion: run.version,
    }, tx);
    if (!updated) return;
    lockWon = true;
    runtime.sessions.appendRun(run.sessionId, runId, newMessages, tx);
  });
  if (!lockWon) {
    const current = dbOps.getRun(runId);
    return {
      exit: dbRunToExit(current ?? run),
      sessionId: run.sessionId,
      runId,
    };
  }

  runtime.bus.emit("run.resumed", { resolution }, {
    sessionId: run.sessionId,
    runId,
    rootRunId: run.rootRunId ?? runId,
    parentRunId: run.parentId ?? undefined,
  });

  // Rebuild run state from DB for the next attempt
  const fullMessages = runtime.sessions.getMessages(run.sessionId, runId);
  const persisted = await loadState(run.sessionId);
  const assistantName = run.template;
  const resolved = await runtime.agents.resolve(assistantName);

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

  return runAndPersist(state, runtime);
}
