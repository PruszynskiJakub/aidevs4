import { runAgent } from "./loop.ts";
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
import { resumeRun } from "./resume-run.ts";
import { errorMessage } from "../utils/parse.ts";
import * as dbOps from "../infra/db/index.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import { DomainError } from "../types/errors.ts";

// ── Types ──────────────────────────────────────────────────

export interface ExecuteRunOpts {
  sessionId?: string;
  prompt: string;
  assistant?: string;
  model?: string;
  parentRunId?: string;
  rootRunId?: string;
  parentTraceId?: string;
  parentDepth?: number;
  sourceCallId?: string;
}

export interface ExecuteRunResult {
  exit: RunExit;
  sessionId: string;
  runId: string;
}

export interface CreateChildRunOpts {
  prompt: string;
  assistant: string;
  parentRunId: string;
  rootRunId: string;
  parentTraceId?: string;
  parentDepth?: number;
  sourceCallId?: string;
}

interface RunRowOpts {
  runId: string;
  sessionId: string;
  parentRunId?: string;
  rootRunId: string;
  sourceCallId?: string;
  assistantName: string;
  prompt: string;
}

interface HydrateOpts {
  runId: string;
  sessionId: string;
  assistantName: string;
  rootRunId: string;
  parentRunId?: string;
  traceId: string;
  depth: number;
  model: string;
  tools: RunState["tools"];
}

// ── Helpers ────────────────────────────────────────────────

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

function insertRunRow(opts: RunRowOpts, tx?: dbOps.DbOrTx): void {
  dbOps.createRun({
    id: opts.runId,
    sessionId: opts.sessionId,
    parentId: opts.parentRunId,
    rootRunId: opts.rootRunId,
    sourceCallId: opts.sourceCallId,
    template: opts.assistantName,
    task: opts.prompt,
  }, tx);
}

async function hydrateRunState(opts: HydrateOpts, runtime: Runtime): Promise<RunState> {
  const messages: LLMMessage[] = runtime.sessions.getMessages(opts.sessionId, opts.runId);
  const persisted = await loadState(opts.sessionId);
  return {
    sessionId: opts.sessionId,
    agentName: opts.assistantName,
    runId: opts.runId,
    rootRunId: opts.rootRunId,
    parentRunId: opts.parentRunId,
    traceId: opts.traceId,
    depth: opts.depth,
    messages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: opts.assistantName,
    model: opts.model,
    tools: opts.tools,
    memory: persisted ?? emptyMemoryState(),
  };
}

async function moderateAndAssert(prompt: string): Promise<void> {
  const moderationStart = Date.now();
  const moderation = await moderateInput(prompt);
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
}

function persistRunExit(runId: string, exit: RunExit, tx?: dbOps.DbOrTx): void {
  switch (exit.kind) {
    case "completed":
      dbOps.updateRunStatus(runId, { status: "completed", result: exit.result, exitKind: "completed" }, tx);
      return;
    case "failed":
      dbOps.updateRunStatus(runId, { status: "failed", error: exit.error.message, exitKind: "failed" }, tx);
      return;
    case "cancelled":
      dbOps.updateRunStatus(runId, { status: "cancelled", error: exit.reason, exitKind: "cancelled" }, tx);
      return;
    case "exhausted":
      dbOps.updateRunStatus(runId, { status: "exhausted", exitKind: "exhausted" }, tx);
      return;
    case "waiting":
      dbOps.updateRunStatus(runId, {
        status: "waiting",
        waitingOn: JSON.stringify(exit.waitingOn),
      }, tx);
      bus.emit("run.waiting", { waitingOn: exit.waitingOn });
      return;
  }
}

function kickChildRunAsync(parentRunId: string, childRunId: string, runtime: Runtime): void {
  startChildRun(childRunId, runtime).catch((err) => {
    const errMsg = errorMessage(err);
    log.error(`[orchestrator] Child run ${childRunId} failed to start: ${errMsg}`);
    resumeRun(parentRunId, {
      kind: "child_run",
      childRunId,
      result: `Child run failed to start: ${errMsg}`,
    }).catch((resumeErr) => {
      log.error(
        `[orchestrator] Failed to resume parent ${parentRunId} after child start failure: ${errorMessage(resumeErr)}`,
      );
    });
  });
}

// ── Public API ─────────────────────────────────────────────

export async function executeRun(
  opts: ExecuteRunOpts,
  runtime: Runtime = createRuntime(),
): Promise<ExecuteRunResult> {
  const sessionId = opts.sessionId ?? randomSessionId();
  const session = runtime.sessions.getOrCreate(sessionId);
  const assistantName = pickAssistantName(session, sessionId, opts.assistant);

  await runtime.agents.get(assistantName);
  await moderateAndAssert(opts.prompt);

  if (!session.assistant) runtime.sessions.setAssistant(sessionId, assistantName);

  const runId = randomUUID();
  const traceId = opts.parentTraceId ?? randomUUID();
  const depth = opts.parentRunId ? (opts.parentDepth ?? 0) + 1 : 0;
  const rootRunId = opts.rootRunId ?? runId;

  // Atomic setup: every write must land or none, so a crash here cannot
  // leave a half-born `pending` run that no reconciliation sweep catches.
  dbOps.withTransaction((tx) => {
    insertRunRow({ runId, sessionId, parentRunId: opts.parentRunId, rootRunId,
      sourceCallId: opts.sourceCallId, assistantName, prompt: opts.prompt }, tx);
    if (!opts.parentRunId) dbOps.setRootRun(sessionId, runId, tx);
    dbOps.updateRunStatus(runId, { status: "running" }, tx);
    runtime.sessions.appendMessage(sessionId, runId, { role: "user", content: opts.prompt }, tx);
  });

  const state = await hydrateRunState({
    runId, sessionId, assistantName, rootRunId,
    parentRunId: opts.parentRunId, traceId, depth,
    model: opts.model ?? "", tools: [],
  }, runtime);

  return runAndPersist(state, runtime);
}

/**
 * Run the loop and convert its result into a persisted `RunExit`.
 * Shared by `executeRun` and `resumeRun` so both entry points apply
 * the same terminal-exit persistence rules.
 */
export async function runAndPersist(
  state: RunState,
  runtime: Runtime = createRuntime(),
): Promise<ExecuteRunResult> {
  const runId = state.runId!;
  const sessionId = state.sessionId;

  try {
    const { exit, messages } = await runAgent(state, undefined, runtime);

    // Atomic terminal write: items batch + run status update land together.
    // Crash between them would otherwise leave a `running` row whose work has
    // actually finished — a silent freeze on the next request for this session.
    dbOps.withTransaction((tx) => {
      runtime.sessions.appendRun(sessionId, runId, messages, tx);
      persistRunExit(runId, exit, tx);
    });

    if (exit.kind === "waiting" && exit.waitingOn.kind === "child_run") {
      kickChildRunAsync(runId, exit.waitingOn.childRunId, runtime);
    }

    return { exit, sessionId, runId };
  } catch (err) {
    const errorMsg = errorMessage(err);
    dbOps.updateRunStatus(runId, { status: "failed", error: errorMsg, exitKind: "failed" });
    return {
      exit: { kind: "failed", error: { message: errorMsg, cause: err } },
      sessionId,
      runId,
    };
  }
}

/**
 * Create a child run row and append the user message, but do NOT enter
 * the loop. Returns the child runId. The caller is responsible for
 * starting execution (typically via startChildRun after the parent parks).
 */
export async function createChildRun(
  opts: CreateChildRunOpts,
  runtime: Runtime = createRuntime(),
): Promise<{ runId: string; sessionId: string }> {
  const sessionId = randomSessionId();
  runtime.sessions.getOrCreate(sessionId);

  await runtime.agents.get(opts.assistant);
  await moderateAndAssert(opts.prompt);

  const runId = randomUUID();
  insertRunRow({
    runId, sessionId,
    parentRunId: opts.parentRunId, rootRunId: opts.rootRunId,
    sourceCallId: opts.sourceCallId,
    assistantName: opts.assistant, prompt: opts.prompt,
  });
  runtime.sessions.appendMessage(sessionId, runId, { role: "user", content: opts.prompt });

  return { runId, sessionId };
}

/**
 * Load a pending run from DB and enter the loop. Used to start
 * child runs after the parent has parked, and by the reconciliation sweep.
 */
export async function startChildRun(
  runId: string,
  runtime: Runtime = createRuntime(),
): Promise<ExecuteRunResult> {
  const run = dbOps.getRun(runId);
  if (!run) throw new DomainError({
    type: "not_found",
    message: "Run not found",
    internalMessage: `Unknown run: ${runId}`,
  });

  dbOps.updateRunStatus(runId, { status: "running" });

  const resolved = await runtime.agents.resolve(run.template);
  const state = await hydrateRunState({
    runId,
    sessionId: run.sessionId,
    assistantName: run.template,
    rootRunId: run.rootRunId ?? runId,
    parentRunId: run.parentId ?? undefined,
    traceId: randomUUID(),
    depth: run.parentId ? 1 : 0,
    model: resolved.model,
    tools: resolved.tools,
  }, runtime);

  return runAndPersist(state, runtime);
}
