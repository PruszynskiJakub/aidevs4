import { bus } from "../infra/events.ts";
import type { TokenPair } from "../types/events.ts";

// ── Run lifecycle ───────────────────────────────────────────

export function emitRunStarted(args: {
  assistant: string;
  model: string;
  userInput?: string;
}): void {
  bus.emit("run.started", args);
}

export function emitRunCompleted(args: {
  reason: "answer" | "max_iterations";
  iterations: number;
  tokens: TokenPair;
}): void {
  bus.emit("run.completed", { ...args, tokens: { ...args.tokens } });
}

export function emitRunFailed(args: {
  iterations: number;
  tokens: TokenPair;
  error: string;
}): void {
  bus.emit("run.failed", { ...args, tokens: { ...args.tokens } });
}

// ── Agent lifecycle ─────────────────────────────────────────

export function emitAgentStarted(args: {
  agentName: string;
  model: string;
  task: string;
  depth: number;
}): void {
  bus.emit("agent.started", args);
}

export function emitAgentAnswered(text: string | null): void {
  bus.emit("agent.answered", { text });
}

export function emitAgentCompleted(args: {
  agentName: string;
  durationMs: number;
  iterations: number;
  tokens: TokenPair;
  result: string | null;
}): void {
  bus.emit("agent.completed", { ...args, tokens: { ...args.tokens } });
}

export function emitAgentFailed(args: {
  agentName: string;
  durationMs: number;
  iterations: number;
  error: string;
}): void {
  bus.emit("agent.failed", args);
}

// ── Turn ────────────────────────────────────────────────────

export function emitTurnStarted(args: {
  index: number;
  maxTurns: number;
  model: string;
  messageCount: number;
}): void {
  bus.emit("turn.started", args);
}

export function emitTurnCompleted(args: {
  index: number;
  outcome: "answer" | "continue" | "max_iterations";
  durationMs: number;
  tokens: TokenPair;
}): void {
  bus.emit("turn.completed", { ...args, tokens: { ...args.tokens } });
}

// ── LLM generation ──────────────────────────────────────────

export function emitGenerationStarted(args: {
  name: string;
  model: string;
  startTime: number;
}): void {
  bus.emit("generation.started", args);
}

export function emitGenerationCompleted(args: {
  name: string;
  model: string;
  input: unknown[];
  output: { content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
}): void {
  bus.emit("generation.completed", args);
}

// ── Tool dispatch ───────────────────────────────────────────

export function emitToolCalled(args: {
  toolCallId: string;
  name: string;
  args: string;
  batchIndex: number;
  batchSize: number;
  startTime: number;
}): void {
  bus.emit("tool.called", args);
}

export function emitToolSucceeded(args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  result: string;
  args: string;
  startTime: number;
}): void {
  bus.emit("tool.succeeded", args);
}

export function emitToolFailed(args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  error: string;
  args: string;
  startTime: number;
}): void {
  bus.emit("tool.failed", args);
}

export function emitBatchStarted(args: {
  batchId: string;
  toolCallIds: string[];
  count: number;
}): void {
  bus.emit("batch.started", args);
}

export function emitBatchCompleted(args: {
  batchId: string;
  count: number;
  durationMs: number;
  succeeded: number;
  failed: number;
}): void {
  bus.emit("batch.completed", args);
}

// ── Composite terminal transitions ──────────────────────────
// These wrap the triple/quad-emit patterns so the loop body
// expresses intent, not bookkeeping. All token snapshots are
// taken synchronously inside these helpers.

export function emitAnswerTerminal(args: {
  agentName: string;
  iterationIndex: number;
  iterationCount: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
  answerText: string | null;
}): void {
  const tokens = { ...args.tokens };
  bus.emit("turn.completed", {
    index: args.iterationIndex,
    outcome: "answer",
    durationMs: args.turnDurationMs,
    tokens: { ...tokens },
  });
  bus.emit("agent.answered", { text: args.answerText });
  bus.emit("agent.completed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.iterationCount,
    tokens: { ...tokens },
    result: args.answerText,
  });
  bus.emit("run.completed", {
    reason: "answer",
    iterations: args.iterationCount,
    tokens: { ...tokens },
  });
}

export function emitMaxIterationsTerminal(args: {
  agentName: string;
  maxIterations: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
}): void {
  const tokens = { ...args.tokens };
  bus.emit("turn.completed", {
    index: args.maxIterations - 1,
    outcome: "max_iterations",
    durationMs: args.turnDurationMs,
    tokens: { ...tokens },
  });
  bus.emit("agent.completed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.maxIterations,
    tokens: { ...tokens },
    result: null,
  });
  bus.emit("run.completed", {
    reason: "max_iterations",
    iterations: args.maxIterations,
    tokens: { ...tokens },
  });
}

export function emitFailureTerminal(args: {
  agentName: string;
  iterations: number;
  runDurationMs: number;
  tokens: TokenPair;
  error: string;
}): void {
  const tokens = { ...args.tokens };
  bus.emit("agent.failed", {
    agentName: args.agentName,
    durationMs: args.runDurationMs,
    iterations: args.iterations,
    error: args.error,
  });
  bus.emit("run.failed", {
    iterations: args.iterations,
    tokens: { ...tokens },
    error: args.error,
  });
}