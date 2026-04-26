import type { LLMProvider, LLMMessage, LLMChatResponse, LLMToolCall } from "../types/llm.ts";
import type { Logger } from "../types/logger.ts";
import type { RunState } from "../types/run-state.ts";
import { llm as defaultLLM } from "../llm/llm.ts";
import { config } from "../config/index.ts";
import { dispatch } from "../tools/registry.ts";
import { confirmBatch } from "./confirmation.ts";
import { agentsService } from "./agents.ts";
import { MarkdownLogger } from "../infra/log/markdown.ts";
import { ConsoleLogger } from "../infra/log/console.ts";
import { createCompositeLogger } from "../infra/log/composite.ts";
import { runWithContext, requireState } from "./context.ts";
import { processMemory, flushMemory } from "./memory/processor.ts";
import { saveState } from "./memory/persistence.ts";
import { randomUUID } from "node:crypto";
import { bus } from "../infra/events.ts";
import { createJsonlWriter } from "../infra/log/jsonl.ts";
import { attachLoggerListener } from "../infra/log/bridge.ts";
import { buildWorkspaceContext } from "./workspace.ts";
import { WaitRequested, type WaitDescriptor } from "./wait-descriptor.ts";
import type { RunExit } from "./run-exit.ts";
import { getErrorMessage } from "../utils/errors.ts";
import * as dbOps from "../infra/db/index.ts";
import {
  emitRunStarted, emitAgentStarted, emitTurnStarted, emitTurnCompleted,
  emitGenerationStarted, emitGenerationCompleted,
  emitToolCalled, emitToolSucceeded, emitToolFailed,
  emitBatchStarted, emitBatchCompleted,
  emitAnswerTerminal, emitMaxIterationsTerminal, emitFailureTerminal,
} from "./run-telemetry.ts";

interface SessionResources {
  log: Logger;
  dispose: () => Promise<void>;
}

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

interface RunContext {
  systemPrompt: string;
  memoryEnabled: boolean;
}

async function resolveAgentForRun(state: RunState): Promise<RunContext> {
  const resolved = await agentsService.resolve(state.assistant);
  if (!state.model) state.model = resolved.model;
  state.tools = resolved.tools;

  const workspaceContext = await buildWorkspaceContext();
  return {
    systemPrompt: `${workspaceContext}\n\n${resolved.prompt}`,
    memoryEnabled: resolved.memory !== false,
  };
}

async function executeActPhase(
  actSystemPrompt: string,
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const state = requireState();
  const actMessages: LLMMessage[] = [{ role: "system", content: actSystemPrompt }, ...state.messages];

  const startTime = Date.now();
  emitGenerationStarted({ name: "act", model: state.model, startTime });

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

  emitGenerationCompleted({
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

type SettledOutcome =
  | { status: "fulfilled"; value: { content: string; isError: boolean; durationMs: number } }
  | { status: "rejected"; reason: unknown };

function recordDeniedToolCalls(state: RunState, denied: { call: LLMToolCall }[]): void {
  for (const { call } of denied) {
    state.messages.push({
      role: "tool",
      toolCallId: call.id,
      content: "Error: Tool call denied by operator.",
    });
  }
}

async function executeApprovedToolCalls(approved: LLMToolCall[]): Promise<SettledOutcome[]> {
  return Promise.allSettled(
    approved.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments, tc.id);
      return { ...result, durationMs: performance.now() - start };
    }),
  ) as Promise<SettledOutcome[]>;
}

function recordToolOutcome(
  state: RunState,
  call: LLMToolCall,
  outcome: SettledOutcome,
  dispatchTime: number,
): "succeeded" | "failed" {
  const base = {
    toolCallId: call.id,
    name: call.function.name,
    args: call.function.arguments,
    startTime: dispatchTime,
  };

  if (outcome.status === "fulfilled") {
    const { content, isError, durationMs } = outcome.value;
    if (isError) emitToolFailed({ ...base, durationMs, error: content });
    else emitToolSucceeded({ ...base, durationMs, result: content });
    state.messages.push({ role: "tool", toolCallId: call.id, content });
    return isError ? "failed" : "succeeded";
  }

  const errorMsg = getErrorMessage(outcome.reason);
  emitToolFailed({ ...base, durationMs: 0, error: errorMsg });
  state.messages.push({
    role: "tool",
    toolCallId: call.id,
    content: `Error: ${errorMsg}`,
  });
  return "failed";
}

async function dispatchTools(functionCalls: LLMToolCall[]): Promise<void> {
  const state = requireState();
  const batchId = randomUUID();
  const dispatchTime = Date.now();

  // May throw WaitRequested to pause the run.
  const { approved, denied } = await confirmBatch(functionCalls);
  recordDeniedToolCalls(state, denied);
  if (approved.length === 0) return;

  if (approved.length > 1) {
    emitBatchStarted({ batchId, toolCallIds: approved.map((tc) => tc.id), count: approved.length });
  }
  for (let idx = 0; idx < approved.length; idx++) {
    const tc = approved[idx];
    emitToolCalled({
      toolCallId: tc.id, name: tc.function.name, args: tc.function.arguments,
      batchIndex: idx, batchSize: approved.length, startTime: dispatchTime,
    });
  }

  const batchStart = performance.now();
  const settled = await executeApprovedToolCalls(approved);

  // Propagate WaitRequested before processing other outcomes.
  for (const outcome of settled) {
    if (outcome.status === "rejected" && outcome.reason instanceof WaitRequested) {
      throw outcome.reason;
    }
  }

  let succeeded = 0, failed = 0;
  for (let j = 0; j < approved.length; j++) {
    const result = recordToolOutcome(state, approved[j], settled[j], dispatchTime);
    if (result === "succeeded") succeeded++; else failed++;
  }

  if (approved.length > 1) {
    emitBatchCompleted({
      batchId, count: approved.length,
      durationMs: performance.now() - batchStart,
      succeeded, failed,
    });
  }
}

interface MemoryContext {
  systemPrompt: string;
  messagesSnapshot: LLMMessage[];
  contextLength: number;
}

async function buildCycleContext(
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
    actSystemPrompt, state.messages, state.memory, provider, state.sessionId,
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

type CycleOutcome =
  | { kind: "continue" }
  | { kind: "completed"; text: string | null }
  | { kind: "waiting"; waitingOn: WaitDescriptor };

async function runCycle(
  state: RunState,
  ctx: RunContext,
  provider: LLMProvider,
  saveMemoryIfChanged: () => Promise<void>,
): Promise<CycleOutcome> {
  const cycleCtx = await buildCycleContext(ctx.systemPrompt, state, ctx.memoryEnabled, provider);
  const response = await executeActPhase(cycleCtx.systemPrompt, provider);

  const newMessages = state.messages.slice(cycleCtx.contextLength);
  state.messages = cycleCtx.messagesSnapshot.concat(newMessages);

  await saveMemoryIfChanged();

  if (response.finishReason === "stop" || !response.toolCalls.length) {
    return { kind: "completed", text: response.content };
  }

  const functionCalls = response.toolCalls.filter((tc) => tc.type === "function");
  try {
    await dispatchTools(functionCalls);
  } catch (err) {
    if (err instanceof WaitRequested) return { kind: "waiting", waitingOn: err.waitingOn };
    throw err;
  }
  return { kind: "continue" };
}

async function finalizeTerminal(
  state: RunState,
  exit: RunExit,
  ctx: RunContext,
  provider: LLMProvider,
  saveMemoryIfChanged: () => Promise<void>,
  timing: { runStartTime: number; turnStartTime: number; iterationsRun: number },
  answerText?: string | null,
): Promise<void> {
  if (ctx.memoryEnabled && (exit.kind === "completed" || exit.kind === "exhausted")) {
    state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
    await saveMemoryIfChanged();
  }

  const agentName = state.agentName ?? state.assistant;
  const runDurationMs = performance.now() - timing.runStartTime;
  const turnDurationMs = performance.now() - timing.turnStartTime;

  if (exit.kind === "completed") {
    emitAnswerTerminal({
      agentName,
      iterationIndex: timing.iterationsRun - 1,
      iterationCount: timing.iterationsRun,
      turnDurationMs, runDurationMs, tokens: state.tokens,
      answerText: answerText ?? null,
    });
  } else if (exit.kind === "exhausted") {
    emitMaxIterationsTerminal({
      agentName, maxIterations: config.limits.maxIterations,
      turnDurationMs, runDurationMs, tokens: state.tokens,
    });
  }
}

function emitRunStartEvents(state: RunState, userPrompt: string | unknown): void {
  emitRunStarted({
    assistant: state.assistant,
    model: state.model,
    userInput: typeof userPrompt === "string" ? userPrompt : undefined,
  });
  emitAgentStarted({
    agentName: state.agentName ?? state.assistant,
    model: state.model,
    task: typeof userPrompt === "string" ? userPrompt : "(structured)",
    depth: state.depth ?? 0,
  });
}

interface IterationDeps {
  state: RunState;
  ctx: RunContext;
  provider: LLMProvider;
  saveMemoryIfChanged: () => Promise<void>;
  sliceMessages: () => LLMMessage[];
  runStartTime: number;
}

async function runIteration(
  deps: IterationDeps,
  i: number,
): Promise<LoopResult | { continue: true; turnStartTime: number }> {
  const { state, ctx, provider, saveMemoryIfChanged, sliceMessages, runStartTime } = deps;
  state.iteration = i;
  const turnStartTime = performance.now();
  const iterationsRun = i + 1;
  if (state.runId) dbOps.incrementCycleCount(state.runId);

  emitTurnStarted({
    index: i,
    maxTurns: config.limits.maxIterations,
    model: state.model,
    messageCount: state.messages.length,
  });

  const outcome = await runCycle(state, ctx, provider, saveMemoryIfChanged);

  if (outcome.kind === "completed") {
    const exit: RunExit = { kind: "completed", result: outcome.text ?? "" };
    await finalizeTerminal(state, exit, ctx, provider, saveMemoryIfChanged,
      { runStartTime, turnStartTime, iterationsRun }, outcome.text);
    return { exit, messages: sliceMessages() };
  }

  emitTurnCompleted({
    index: i, outcome: "continue",
    durationMs: performance.now() - turnStartTime,
    tokens: state.tokens,
  });

  if (outcome.kind === "waiting") {
    return { exit: { kind: "waiting", waitingOn: outcome.waitingOn }, messages: sliceMessages() };
  }
  return { continue: true, turnStartTime };
}

export interface LoopResult {
  exit: RunExit;
  messages: LLMMessage[];
}

export async function runAgent(
  state: RunState,
  provider: LLMProvider = defaultLLM,
): Promise<LoopResult> {
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, dispose } = setupSession(userPrompt, state.sessionId);
  const inputLength = state.messages.length;
  const sliceMessages = () => state.messages.slice(inputLength);

  return runWithContext(state, log, async () => {
    const saveMemoryIfChanged = createMemorySaver(state);
    const runStartTime = performance.now();

    try {
      const ctx = await resolveAgentForRun(state);
      emitRunStartEvents(state, userPrompt);
      const deps: IterationDeps = { state, ctx, provider, saveMemoryIfChanged, sliceMessages, runStartTime };

      let lastTurnStartTime = performance.now();
      for (let i = 0; i < config.limits.maxIterations; i++) {
        const result = await runIteration(deps, i);
        if (!("continue" in result)) return result;
        lastTurnStartTime = result.turnStartTime;
      }

      const exit: RunExit = { kind: "exhausted", cycleCount: config.limits.maxIterations };
      await finalizeTerminal(state, exit, ctx, provider, saveMemoryIfChanged,
        { runStartTime, turnStartTime: lastTurnStartTime, iterationsRun: config.limits.maxIterations });
      return { exit, messages: sliceMessages() };
    } catch (err) {
      if (err instanceof WaitRequested) {
        return { exit: { kind: "waiting", waitingOn: err.waitingOn }, messages: sliceMessages() };
      }
      emitFailureTerminal({
        agentName: state.agentName ?? state.assistant,
        iterations: state.iteration + 1,
        runDurationMs: performance.now() - runStartTime,
        tokens: state.tokens,
        error: getErrorMessage(err),
      });
      throw err;
    } finally {
      await dispose();
    }
  });
}
