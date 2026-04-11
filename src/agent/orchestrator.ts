import { runAgent } from "./loop.ts";
import { sessionService } from "./session.ts";
import { agentsService } from "./agents.ts";
import { log } from "../infra/log/logger.ts";
import { moderateInput, assertNotFlagged } from "../infra/guard.ts";
import { bus } from "../infra/events.ts";
import { randomUUID } from "node:crypto";
import { randomSessionId } from "../utils/id.ts";
import type { LLMMessage } from "../types/llm.ts";
import type { RunState } from "../types/run-state.ts";
import type { Session } from "../types/session.ts";
import type { RunExit } from "./run-exit.ts";
import { emptyMemoryState } from "../types/memory.ts";
import { loadState } from "./memory/persistence.ts";
import * as dbOps from "../infra/db/index.ts";

interface ExecuteRunOpts {
  sessionId?: string;
  prompt: string;
  assistant?: string;
  model?: string;
  parentRunId?: string;
  parentRootRunId?: string;
  parentTraceId?: string;
  parentDepth?: number;
  sourceCallId?: string;
}

export interface ExecuteRunResult {
  exit: RunExit;
  sessionId: string;
  runId: string;
}

function pickAssistantName(
  session: Session,
  sessionId: string,
  requestedAssistant?: string,
): string {
  if (session.assistant) {
    if (requestedAssistant && requestedAssistant !== session.assistant) {
      log.info(
        `[${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`,
      );
    }
    return session.assistant;
  }
  return requestedAssistant ?? "default";
}

export async function executeRun(opts: ExecuteRunOpts): Promise<ExecuteRunResult> {
  const sessionId = opts.sessionId ?? randomSessionId();
  const session = sessionService.getOrCreate(sessionId);
  const assistantName = pickAssistantName(session, sessionId, opts.assistant);

  // Validate agent exists before proceeding (throws "Unknown agent" if not found)
  await agentsService.get(assistantName);

  // Moderation guardrail — check user input before it enters the session
  const moderationStart = Date.now();
  const moderation = await moderateInput(opts.prompt);
  const moderationDurationMs = Date.now() - moderationStart;

  if (moderation.flagged) {
    const flaggedCategories = Object.entries(moderation.categories)
      .filter(([, v]) => v)
      .map(([k]) => k);
    bus.emit("input.flagged", {
      categories: flaggedCategories,
      categoryScores: moderation.categoryScores,
    });
  } else {
    bus.emit("input.clean", { durationMs: moderationDurationMs });
  }

  assertNotFlagged(moderation);

  if (!session.assistant) {
    sessionService.setAssistant(sessionId, assistantName);
  }

  const runId = randomUUID();
  const traceId = opts.parentTraceId ?? randomUUID();
  const depth = opts.parentRunId ? (opts.parentDepth ?? 0) + 1 : 0;

  // Persist run row
  dbOps.createRun({
    id: runId,
    sessionId,
    parentId: opts.parentRunId,
    sourceCallId: opts.sourceCallId,
    template: assistantName,
    task: opts.prompt,
  });

  // Set root run for the session if this is the root run
  if (!opts.parentRunId) {
    dbOps.setRootRun(sessionId, runId);
  }

  dbOps.updateRunStatus(runId, { status: "running" });

  // Append user message to DB
  sessionService.appendMessage(sessionId, runId, { role: "user", content: opts.prompt });

  // Load full conversation for this run
  const messages: LLMMessage[] = sessionService.getMessages(sessionId, runId);

  const persisted = await loadState(sessionId);

  const state: RunState = {
    sessionId,
    agentName: assistantName,
    runId,
    rootRunId: opts.parentRootRunId ?? runId,
    parentRunId: opts.parentRunId,
    traceId,
    depth,
    messages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: assistantName,
    model: opts.model ?? "",
    tools: [],
    memory: persisted ?? emptyMemoryState(),
  };

  return runAndPersist(state);
}

/**
 * Run the loop and convert its result into a persisted `RunExit`.
 * Shared by `executeRun` and `resumeRun` so both entry points apply
 * the same terminal-exit persistence rules.
 */
export async function runAndPersist(state: RunState): Promise<ExecuteRunResult> {
  const runId = state.runId!;
  const sessionId = state.sessionId;

  try {
    const { exit, messages } = await runAgent(state);

    // Persist any new messages produced by the loop
    sessionService.appendRun(sessionId, runId, messages);

    // Apply terminal/waiting persistence
    switch (exit.kind) {
      case "completed":
        dbOps.updateRunStatus(runId, {
          status: "completed",
          result: exit.result,
          exitKind: "completed",
        });
        break;
      case "failed":
        dbOps.updateRunStatus(runId, {
          status: "failed",
          error: exit.error.message,
          exitKind: "failed",
        });
        break;
      case "cancelled":
        dbOps.updateRunStatus(runId, {
          status: "cancelled",
          error: exit.reason,
          exitKind: "cancelled",
        });
        break;
      case "exhausted":
        dbOps.updateRunStatus(runId, {
          status: "exhausted",
          exitKind: "exhausted",
        });
        break;
      case "waiting":
        dbOps.updateRunStatus(runId, {
          status: "waiting",
          waitingOn: JSON.stringify(exit.waitingOn),
        });
        bus.emit("run.waiting", { waitingOn: exit.waitingOn });
        break;
    }

    return { exit, sessionId, runId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    dbOps.updateRunStatus(runId, {
      status: "failed",
      error: errorMsg,
      exitKind: "failed",
    });
    const exit: RunExit = {
      kind: "failed",
      error: { message: errorMsg, cause: err },
    };
    return { exit, sessionId, runId };
  }
}
