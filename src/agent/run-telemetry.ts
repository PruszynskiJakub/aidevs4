import { bus } from "../infra/events.ts";
import type { TokenPair, EventEnvelope } from "../types/events.ts";
import type { RunCtx } from "./run-ctx.ts";

// ── Envelope helper ────────────────────────────────────────

function envelopeOf(ctx: RunCtx): EventEnvelope {
  return {
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    rootRunId: ctx.rootRunId,
    parentRunId: ctx.parentRunId,
    traceId: ctx.traceId,
    depth: ctx.depth,
  };
}

// ── Run lifecycle ───────────────────────────────────────────

export function emitRunStarted(ctx: RunCtx, args: {
  assistant: string;
  model: string;
  userInput?: string;
}): void {
  bus.emit("run.started", args, envelopeOf(ctx));
}

// ── Agent lifecycle ─────────────────────────────────────────

export function emitAgentStarted(ctx: RunCtx, args: {
  agentName: string;
  model: string;
  task: string;
  depth: number;
}): void {
  bus.emit("agent.started", args, envelopeOf(ctx));
}

// ── Turn ────────────────────────────────────────────────────

export function emitTurnStarted(ctx: RunCtx, args: {
  index: number;
  maxTurns: number;
  model: string;
  messageCount: number;
}): void {
  bus.emit("turn.started", args, envelopeOf(ctx));
}

export function emitTurnCompleted(ctx: RunCtx, args: {
  index: number;
  outcome: "answer" | "continue" | "max_iterations";
  durationMs: number;
  tokens: TokenPair;
}): void {
  bus.emit("turn.completed", { ...args, tokens: { ...args.tokens } }, envelopeOf(ctx));
}

// ── LLM generation ──────────────────────────────────────────

export function emitGenerationStarted(ctx: RunCtx, args: {
  name: string;
  model: string;
  startTime: number;
}): void {
  bus.emit("generation.started", args, envelopeOf(ctx));
}

export function emitGenerationCompleted(ctx: RunCtx, args: {
  name: string;
  model: string;
  input: unknown[];
  output: { content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
}): void {
  bus.emit("generation.completed", args, envelopeOf(ctx));
}

// ── Tool dispatch ───────────────────────────────────────────

export function emitToolCalled(ctx: RunCtx, args: {
  toolCallId: string;
  name: string;
  args: string;
  batchIndex: number;
  batchSize: number;
  startTime: number;
}): void {
  bus.emit("tool.called", args, envelopeOf(ctx));
}

export function emitToolSucceeded(ctx: RunCtx, args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  result: string;
  args: string;
  startTime: number;
}): void {
  bus.emit("tool.succeeded", args, envelopeOf(ctx));
}

export function emitToolFailed(ctx: RunCtx, args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  error: string;
  args: string;
  startTime: number;
}): void {
  bus.emit("tool.failed", args, envelopeOf(ctx));
}

export function emitBatchStarted(ctx: RunCtx, args: {
  batchId: string;
  toolCallIds: string[];
  count: number;
}): void {
  bus.emit("batch.started", args, envelopeOf(ctx));
}

export function emitBatchCompleted(ctx: RunCtx, args: {
  batchId: string;
  count: number;
  durationMs: number;
  succeeded: number;
  failed: number;
}): void {
  bus.emit("batch.completed", args, envelopeOf(ctx));
}

// ── Composite terminal transitions ──────────────────────────
// These wrap the triple/quad-emit patterns so the loop body
// expresses intent, not bookkeeping. All token snapshots are
// taken synchronously inside these helpers.

export function emitAnswerTerminal(ctx: RunCtx, args: {
  agentName: string;
  iterationIndex: number;
  iterationCount: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
  answerText: string | null;
}): void {
  const env = envelopeOf(ctx);
  const tokens = { ...args.tokens };
  bus.emit("turn.completed", {
    index: args.iterationIndex,
    outcome: "answer",
    durationMs: args.turnDurationMs,
    tokens: { ...tokens },
  }, env);
  bus.emit("agent.answered", { text: args.answerText }, env);
  bus.emit("agent.completed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.iterationCount,
    tokens: { ...tokens },
    result: args.answerText,
  }, env);
  bus.emit("run.completed", {
    reason: "answer",
    iterations: args.iterationCount,
    tokens: { ...tokens },
  }, env);
}

export function emitMaxIterationsTerminal(ctx: RunCtx, args: {
  agentName: string;
  maxIterations: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
}): void {
  const env = envelopeOf(ctx);
  const tokens = { ...args.tokens };
  bus.emit("turn.completed", {
    index: args.maxIterations - 1,
    outcome: "max_iterations",
    durationMs: args.turnDurationMs,
    tokens: { ...tokens },
  }, env);
  bus.emit("agent.completed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.maxIterations,
    tokens: { ...tokens },
    result: null,
  }, env);
  bus.emit("run.completed", {
    reason: "max_iterations",
    iterations: args.maxIterations,
    tokens: { ...tokens },
  }, env);
}

export function emitFailureTerminal(ctx: RunCtx, args: {
  agentName: string;
  iterations: number;
  runDurationMs: number;
  tokens: TokenPair;
  error: string;
}): void {
  const env = envelopeOf(ctx);
  const tokens = { ...args.tokens };
  bus.emit("agent.failed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.iterations,
    error: args.error,
  }, env);
  bus.emit("run.failed", {
    iterations: args.iterations,
    tokens: { ...tokens },
    error: args.error,
  }, env);
  // Reference tokens snapshot to keep the local; token-loss bug
  // tracker uses runFailedSize which is computed elsewhere.
  void tokens;
}
