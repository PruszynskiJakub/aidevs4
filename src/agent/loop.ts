import type { LLMProvider, LLMMessage, LLMChatResponse, LLMToolCall } from "../types/llm.ts";
import type { Logger } from "../types/logger.ts";
import type { RunState } from "../types/run-state.ts";
import { config } from "../config/index.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import { dispatch } from "../tools/registry.ts";
import { confirmBatch } from "./confirmation.ts";
import { MarkdownLogger } from "../infra/log/markdown.ts";
import { ConsoleLogger } from "../infra/log/console.ts";
import { createCompositeLogger } from "../infra/log/composite.ts";
import { runWithContext } from "./context.ts";
import { buildRunCtx, type RunCtx } from "./run-ctx.ts";
import { processMemory, flushMemory } from "./memory/processor.ts";
import { saveState } from "./memory/persistence.ts";
import { randomUUID } from "node:crypto";
import { bus } from "../infra/events.ts";
import { createJsonlWriter } from "../infra/log/jsonl.ts";
import { attachLoggerListener } from "../infra/log/bridge.ts";
import { buildWorkspaceContext } from "./workspace.ts";
import type { WaitDescriptor } from "../types/wait.ts";
import type { RunExit } from "./run-exit.ts";
import { errorMessage } from "../utils/parse.ts";
import * as dbOps from "../infra/db/index.ts";
import {
  emitRunStarted, emitAgentStarted, emitTurnStarted, emitTurnCompleted,
  emitGenerationStarted, emitGenerationCompleted,
  emitToolCalled, emitToolSucceeded, emitToolFailed,
  emitBatchStarted, emitBatchCompleted,
  emitAnswerTerminal, emitMaxIterationsTerminal, emitFailureTerminal,
} from "./run-telemetry.ts";

// ── Types ──────────────────────────────────────────────────

interface SessionResources {
  log: Logger;
  dispose: () => Promise<void>;
}

interface AgentBindings {
  systemPrompt: string;
  memoryEnabled: boolean;
}

type SettledOutcome =
  | { status: "fulfilled"; value: { content: string; isError: boolean; durationMs: number; wait?: WaitDescriptor } }
  | { status: "rejected"; reason: unknown };

interface MemoryContext {
  systemPrompt: string;
  messagesSnapshot: LLMMessage[];
  contextLength: number;
}

type CycleOutcome =
  | { kind: "continue" }
  | { kind: "completed"; text: string | null }
  | { kind: "waiting"; waitingOn: WaitDescriptor };

interface IterationDeps {
  runCtx: RunCtx;
  bindings: AgentBindings;
  provider: LLMProvider;
  saveMemoryIfChanged: () => Promise<void>;
  sliceMessages: () => LLMMessage[];
  runStartTime: number;
}

export interface LoopResult {
  exit: RunExit;
  messages: LLMMessage[];
}

// ── Session setup ──────────────────────────────────────────

function setupSession(userPrompt: string | unknown, sessionId?: string): SessionResources {
  const md = new MarkdownLogger({ sessionId });
  md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");

  const log = createCompositeLogger([new ConsoleLogger(), md]);
  const detachLogger = attachLoggerListener(bus, log, sessionId);
  const jsonl = createJsonlWriter();
  const detachJsonl = bus.onAny(jsonl.listener);

  log.info(`Session: ${md.sessionId}`);
  log.info(`Log: ${md.filePath}`);

  return {
    log,
    dispose: async () => {
      detachLogger();
      detachJsonl();
      await Promise.all([md.flush(), jsonl.flush()]);
      md.dispose();
    },
  };
}

// ── Agent resolution ───────────────────────────────────────

async function resolveAgentForRun(state: RunState, runtime: Runtime): Promise<AgentBindings> {
  const resolved = await runtime.agents.resolve(state.assistant);
  if (!state.model) state.model = resolved.model;
  state.tools = resolved.tools;

  const workspaceContext = await buildWorkspaceContext();
  return {
    systemPrompt: `${workspaceContext}\n\n${resolved.prompt}`,
    memoryEnabled: resolved.memory !== false,
  };
}

// ── LLM execution ──────────────────────────────────────────

async function executeActPhase(
  ctx: RunCtx,
  actSystemPrompt: string,
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const { state } = ctx;
  const actMessages: LLMMessage[] = [{ role: "system", content: actSystemPrompt }, ...state.messages];

  const startTime = Date.now();
  emitGenerationStarted(ctx, { name: "act", model: state.model, startTime });

  const actStart = performance.now();
  const response = await provider.chatCompletion({
    model: state.model,
    messages: actMessages,
    tools: state.tools,
  });
  const durationMs = performance.now() - actStart;

  const tokensIn = response.usage?.promptTokens ?? 0;
  const tokensOut = response.usage?.completionTokens ?? 0;
  state.tokens.promptTokens += tokensIn;
  state.tokens.completionTokens += tokensOut;

  emitGenerationCompleted(ctx, {
    name: "act",
    model: state.model,
    input: actMessages,
    output: {
      content: response.content,
      ...(response.toolCalls.length && {
        toolCalls: response.toolCalls.map((tc) => ({
          id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
        })),
      }),
    },
    usage: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
    durationMs,
    startTime,
  });

  state.messages.push({
    role: "assistant",
    content: response.content,
    ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
  });

  return response;
}

// ── Tool dispatch ──────────────────────────────────────────

function recordDeniedToolCalls(state: RunState, denied: { call: LLMToolCall }[]): void {
  for (const { call } of denied) {
    state.messages.push({
      role: "tool",
      toolCallId: call.id,
      content: "Error: Tool call denied by operator.",
    });
  }
}

async function executeApprovedToolCalls(ctx: RunCtx, approved: LLMToolCall[]): Promise<SettledOutcome[]> {
  return Promise.allSettled(
    approved.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments, tc.id, ctx);
      return { ...result, durationMs: performance.now() - start };
    }),
  ) as Promise<SettledOutcome[]>;
}

function recordToolOutcome(
  ctx: RunCtx,
  call: LLMToolCall,
  outcome: SettledOutcome,
  dispatchTime: number,
): "succeeded" | "failed" {
  const { state } = ctx;
  const base = {
    toolCallId: call.id,
    name: call.function.name,
    args: call.function.arguments,
    startTime: dispatchTime,
  };

  if (outcome.status === "fulfilled") {
    const { content, isError, durationMs } = outcome.value;
    if (isError) emitToolFailed(ctx, { ...base, durationMs, error: content });
    else emitToolSucceeded(ctx, { ...base, durationMs, result: content });
    state.messages.push({ role: "tool", toolCallId: call.id, content });
    return isError ? "failed" : "succeeded";
  }

  const errorMsg = errorMessage(outcome.reason);
  emitToolFailed(ctx, { ...base, durationMs: 0, error: errorMsg });
  state.messages.push({
    role: "tool",
    toolCallId: call.id,
    content: `Error: ${errorMsg}`,
  });
  return "failed";
}

async function dispatchTools(ctx: RunCtx, functionCalls: LLMToolCall[]): Promise<WaitDescriptor | undefined> {
  const { state } = ctx;
  const batchId = randomUUID();
  const dispatchTime = Date.now();

  const { approved, denied, waitingOn } = await confirmBatch(functionCalls);
  recordDeniedToolCalls(state, denied);

  if (approved.length > 0) {
    if (approved.length > 1) {
      emitBatchStarted(ctx, { batchId, toolCallIds: approved.map((tc) => tc.id), count: approved.length });
    }
    for (let idx = 0; idx < approved.length; idx++) {
      const tc = approved[idx];
      emitToolCalled(ctx, {
        toolCallId: tc.id, name: tc.function.name, args: tc.function.arguments,
        batchIndex: idx, batchSize: approved.length, startTime: dispatchTime,
      });
    }

    const batchStart = performance.now();
    const settled = await executeApprovedToolCalls(ctx, approved);

    let succeeded = 0, failed = 0;
    for (let j = 0; j < approved.length; j++) {
      const result = recordToolOutcome(ctx, approved[j], settled[j], dispatchTime);
      if (result === "succeeded") succeeded++; else failed++;
    }

    if (approved.length > 1) {
      emitBatchCompleted(ctx, {
        batchId, count: approved.length,
        durationMs: performance.now() - batchStart,
        succeeded, failed,
      });
    }

    // Check for wait descriptors from tool outcomes (e.g. delegate).
    if (!waitingOn) {
      for (const outcome of settled) {
        if (outcome.status === "fulfilled" && outcome.value.wait) {
          return outcome.value.wait;
        }
      }
    }
  }

  return waitingOn;
}

// ── Memory management ──────────────────────────────────────

async function buildCycleContext(
  ctx: RunCtx,
  actSystemPrompt: string,
  state: RunState,
  memoryEnabled: boolean,
  provider: LLMProvider,
): Promise<MemoryContext> {
  if (!memoryEnabled) {
    return {
      systemPrompt: actSystemPrompt,
      messagesSnapshot: [...state.messages],
      contextLength: state.messages.length,
    };
  }

  const { context, state: updatedMemory } = await processMemory(
    actSystemPrompt, state.messages, state.memory, provider, state.sessionId, ctx,
  );
  state.memory = updatedMemory;

  const messagesSnapshot = [...state.messages];
  state.messages = [...context.messages];
  return {
    systemPrompt: context.systemPrompt,
    messagesSnapshot,
    contextLength: context.messages.length,
  };
}

function createMemorySaver(state: RunState) {
  let lastSavedJson = "";
  return async (): Promise<void> => {
    const json = JSON.stringify(state.memory);
    if (json === lastSavedJson) return;
    await saveState(state.sessionId, state.memory);
    lastSavedJson = json;
  };
}

// ── Cycle & iteration ──────────────────────────────────────

async function runCycle(
  runCtx: RunCtx,
  bindings: AgentBindings,
  provider: LLMProvider,
  saveMemoryIfChanged: () => Promise<void>,
): Promise<CycleOutcome> {
  const { state } = runCtx;
  const cycleCtx = await buildCycleContext(runCtx, bindings.systemPrompt, state, bindings.memoryEnabled, provider);
  const response = await executeActPhase(runCtx, cycleCtx.systemPrompt, provider);

  const newMessages = state.messages.slice(cycleCtx.contextLength);
  state.messages = cycleCtx.messagesSnapshot.concat(newMessages);

  await saveMemoryIfChanged();

  if (response.finishReason === "stop" || !response.toolCalls.length) {
    return { kind: "completed", text: response.content };
  }

  const functionCalls = response.toolCalls.filter((tc) => tc.type === "function");
  const waitingOn = await dispatchTools(runCtx, functionCalls);
  if (waitingOn) return { kind: "waiting", waitingOn };
  return { kind: "continue" };
}

async function runIteration(
  deps: IterationDeps,
  i: number,
): Promise<LoopResult | { continue: true; turnStartTime: number }> {
  const { runCtx, bindings, provider, saveMemoryIfChanged, sliceMessages, runStartTime } = deps;
  const { state } = runCtx;
  state.iteration = i;
  const turnStartTime = performance.now();
  const iterationsRun = i + 1;
  if (state.runId) dbOps.incrementCycleCount(state.runId);

  emitTurnStarted(runCtx, {
    index: i,
    maxTurns: config.limits.maxIterations,
    model: state.model,
    messageCount: state.messages.length,
  });

  const outcome = await runCycle(runCtx, bindings, provider, saveMemoryIfChanged);

  if (outcome.kind === "completed") {
    const exit: RunExit = { kind: "completed", result: outcome.text ?? "" };
    await finalizeTerminal(runCtx, exit, bindings, provider, saveMemoryIfChanged,
      { runStartTime, turnStartTime, iterationsRun }, outcome.text);
    return { exit, messages: sliceMessages() };
  }

  emitTurnCompleted(runCtx, {
    index: i, outcome: "continue",
    durationMs: performance.now() - turnStartTime,
    tokens: state.tokens,
  });

  if (outcome.kind === "waiting") {
    return { exit: { kind: "waiting", waitingOn: outcome.waitingOn }, messages: sliceMessages() };
  }
  return { continue: true, turnStartTime };
}

// ── Terminal finalization ──────────────────────────────────

function emitRunStartEvents(ctx: RunCtx, userPrompt: string | unknown): void {
  const { state } = ctx;
  emitRunStarted(ctx, {
    assistant: state.assistant,
    model: state.model,
    userInput: typeof userPrompt === "string" ? userPrompt : undefined,
  });
  emitAgentStarted(ctx, {
    agentName: state.agentName ?? state.assistant,
    model: state.model,
    task: typeof userPrompt === "string" ? userPrompt : "(structured)",
    depth: state.depth ?? 0,
  });
}

async function finalizeTerminal(
  ctx: RunCtx,
  exit: RunExit,
  bindings: AgentBindings,
  provider: LLMProvider,
  saveMemoryIfChanged: () => Promise<void>,
  timing: { runStartTime: number; turnStartTime: number; iterationsRun: number },
  answerText?: string | null,
): Promise<void> {
  const { state } = ctx;
  if (bindings.memoryEnabled && (exit.kind === "completed" || exit.kind === "exhausted")) {
    state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId, ctx);
    await saveMemoryIfChanged();
  }

  const agentName = state.agentName ?? state.assistant;
  const runDurationMs = performance.now() - timing.runStartTime;
  const turnDurationMs = performance.now() - timing.turnStartTime;

  if (exit.kind === "completed") {
    emitAnswerTerminal(ctx, {
      agentName,
      iterationIndex: timing.iterationsRun - 1,
      iterationCount: timing.iterationsRun,
      turnDurationMs, runDurationMs, tokens: state.tokens,
      answerText: answerText ?? null,
    });
  } else if (exit.kind === "exhausted") {
    emitMaxIterationsTerminal(ctx, {
      agentName, maxIterations: config.limits.maxIterations,
      turnDurationMs, runDurationMs, tokens: state.tokens,
    });
  }
}

// ── Public API ─────────────────────────────────────────────

export async function runAgent(
  state: RunState,
  providerOrUndefined?: LLMProvider,
  runtime: Runtime = createRuntime(),
): Promise<LoopResult> {
  const provider: LLMProvider = providerOrUndefined ?? runtime.llm;
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, dispose } = setupSession(userPrompt, state.sessionId);
  const inputLength = state.messages.length;
  const sliceMessages = () => state.messages.slice(inputLength);

  return runWithContext(state, log, async () => {
    const saveMemoryIfChanged = createMemorySaver(state);
    const runStartTime = performance.now();
    // Build runCtx eagerly so the failure path also has an envelope.
    // Fields read off `state` here are stable for the run; later
    // `resolveAgentForRun` may set state.model/state.tools but those
    // aren't part of the envelope.
    const runCtx = buildRunCtx(runtime, state, log);

    try {
      const bindings = await resolveAgentForRun(state, runtime);
      emitRunStartEvents(runCtx, userPrompt);
      const deps: IterationDeps = { runCtx, bindings, provider, saveMemoryIfChanged, sliceMessages, runStartTime };

      let lastTurnStartTime = performance.now();
      for (let i = 0; i < config.limits.maxIterations; i++) {
        const result = await runIteration(deps, i);
        if (!("continue" in result)) return result;
        lastTurnStartTime = result.turnStartTime;
      }

      const exit: RunExit = { kind: "exhausted", cycleCount: config.limits.maxIterations };
      await finalizeTerminal(runCtx, exit, bindings, provider, saveMemoryIfChanged,
        { runStartTime, turnStartTime: lastTurnStartTime, iterationsRun: config.limits.maxIterations });
      return { exit, messages: sliceMessages() };
    } catch (err) {
      emitFailureTerminal(runCtx, {
        agentName: state.agentName ?? state.assistant,
        iterations: state.iteration + 1,
        runDurationMs: performance.now() - runStartTime,
        tokens: state.tokens,
        error: errorMessage(err),
      });
      throw err;
    } finally {
      await dispose();
    }
  });
}
