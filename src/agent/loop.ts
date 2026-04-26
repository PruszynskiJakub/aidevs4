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
import { WaitRequested } from "./wait-descriptor.ts";
import type { RunExit } from "./run-exit.ts";
import * as dbOps from "../infra/db/index.ts";
import {
  emitRunStarted,
  emitAgentStarted,
  emitTurnStarted,
  emitTurnCompleted,
  emitGenerationStarted,
  emitGenerationCompleted,
  emitToolCalled,
  emitToolSucceeded,
  emitToolFailed,
  emitBatchStarted,
  emitBatchCompleted,
  emitAnswerTerminal,
  emitMaxIterationsTerminal,
  emitFailureTerminal,
} from "./run-telemetry.ts";

interface SessionResources {
  log: Logger;
  md: MarkdownLogger;
  detachLogger: () => void;
  detachJsonl: () => void;
  flushJsonl: () => Promise<void>;
}

function setupSession(
  userPrompt: string | unknown,
  sessionId?: string,
): SessionResources {
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
    md,
    detachLogger,
    detachJsonl,
    flushJsonl: () => jsonl.flush(),
  };
}

async function executeActPhase(
  actSystemPrompt: string,
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const state = requireState();
  const actMessages: LLMMessage[] = [
    { role: "system", content: actSystemPrompt },
    ...state.messages,
  ];

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
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
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

async function dispatchTools(
  functionCalls: LLMToolCall[],
): Promise<void> {
  const state = requireState();

  const batchId = randomUUID();
  const dispatchTime = Date.now();

  // ── Confirmation gate ──────────────────────────────────────
  // May throw WaitRequested to pause the run.
  const { approved, denied } = await confirmBatch(functionCalls);

  for (const { call } of denied) {
    state.messages.push({
      role: "tool",
      toolCallId: call.id,
      content: "Error: Tool call denied by operator.",
    });
  }

  if (approved.length === 0) return;

  // ── Emit tool.called only for approved calls ──────────────
  if (approved.length > 1) {
    emitBatchStarted({
      batchId,
      toolCallIds: approved.map((tc) => tc.id),
      count: approved.length,
    });
  }

  for (let idx = 0; idx < approved.length; idx++) {
    const tc = approved[idx];
    emitToolCalled({
      toolCallId: tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
      batchIndex: idx,
      batchSize: approved.length,
      startTime: dispatchTime,
    });
  }

  // ── Dispatch approved calls ───────────────────────────────
  const batchStart = performance.now();
  let succeeded = 0;
  let failed = 0;

  const settled = await Promise.allSettled(
    approved.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments, tc.id);
      return { ...result, durationMs: performance.now() - start };
    })
  );

  // Check if any tool threw WaitRequested — propagate it before processing results
  for (const outcome of settled) {
    if (outcome.status === "rejected" && outcome.reason instanceof WaitRequested) {
      throw outcome.reason;
    }
  }

  for (let j = 0; j < approved.length; j++) {
    const tc = approved[j];
    const outcome = settled[j];

    if (outcome.status === "fulfilled") {
      const { content, isError, durationMs } = outcome.value;
      if (isError) {
        failed++;
        emitToolFailed({
          toolCallId: tc.id,
          name: tc.function.name,
          durationMs,
          error: content,
          args: tc.function.arguments,
          startTime: dispatchTime,
        });
      } else {
        succeeded++;
        emitToolSucceeded({
          toolCallId: tc.id,
          name: tc.function.name,
          durationMs,
          result: content,
          args: tc.function.arguments,
          startTime: dispatchTime,
        });
      }
      state.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content,
      });
    } else {
      failed++;
      const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      emitToolFailed({
        toolCallId: tc.id,
        name: tc.function.name,
        durationMs: 0,
        error: errorMsg,
        args: tc.function.arguments,
        startTime: dispatchTime,
      });
      state.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: `Error: ${errorMsg}`,
      });
    }
  }

  if (approved.length > 1) {
    emitBatchCompleted({
      batchId,
      count: approved.length,
      durationMs: performance.now() - batchStart,
      succeeded,
      failed,
    });
  }
}

export interface LoopResult {
  exit: RunExit;
  messages: LLMMessage[];
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
    actSystemPrompt,
    state.messages,
    state.memory,
    provider,
    state.sessionId,
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
  return async function saveMemoryIfChanged(): Promise<void> {
    const json = JSON.stringify(state.memory);
    if (json === lastSavedJson) return;
    await saveState(state.sessionId, state.memory);
    lastSavedJson = json;
  };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runAgent(
  state: RunState,
  provider: LLMProvider = defaultLLM,
): Promise<LoopResult> {
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, md, detachLogger, detachJsonl, flushJsonl } = setupSession(userPrompt, state.sessionId);

  const inputLength = state.messages.length;

  return runWithContext(state, log, async () => {
    const saveMemoryIfChanged = createMemorySaver(state);
    const runStartTime = performance.now();

    try {
      const resolved = await agentsService.resolve(state.assistant);

      if (!state.model) {
        state.model = resolved.model;
      }

      state.tools = resolved.tools;

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

      const workspaceContext = await buildWorkspaceContext();
      const actSystemPrompt = `${workspaceContext}\n\n${resolved.prompt}`;
      const memoryEnabled = resolved.memory !== false;
      let turnStartTime = 0;

      for (let i = 0; i < config.limits.maxIterations; i++) {
        state.iteration = i;
        turnStartTime = performance.now();

        if (state.runId) dbOps.incrementCycleCount(state.runId);

        emitTurnStarted({
          index: i,
          maxTurns: config.limits.maxIterations,
          model: state.model,
          messageCount: state.messages.length,
        });

        const cycleCtx = await buildCycleContext(actSystemPrompt, state, memoryEnabled, provider);
        const response = await executeActPhase(cycleCtx.systemPrompt, provider);

        const newMessages = state.messages.slice(cycleCtx.contextLength);
        state.messages = cycleCtx.messagesSnapshot.concat(newMessages);

        await saveMemoryIfChanged();

        if (response.finishReason === "stop" || !response.toolCalls.length) {
          if (memoryEnabled) {
            state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
            await saveMemoryIfChanged();
          }

          emitAnswerTerminal({
            agentName: state.agentName ?? state.assistant,
            iterationIndex: i,
            iterationCount: i + 1,
            turnDurationMs: performance.now() - turnStartTime,
            runDurationMs: performance.now() - runStartTime,
            tokens: state.tokens,
            answerText: response.content,
          });

          return {
            exit: { kind: "completed", result: response.content ?? "" },
            messages: state.messages.slice(inputLength),
          };
        }

        const functionCalls = response.toolCalls.filter(tc => tc.type === "function");

        try {
          await dispatchTools(functionCalls);
        } catch (err) {
          if (err instanceof WaitRequested) {
            emitTurnCompleted({
              index: i,
              outcome: "continue",
              durationMs: performance.now() - turnStartTime,
              tokens: state.tokens,
            });
            return {
              exit: { kind: "waiting", waitingOn: err.waitingOn },
              messages: state.messages.slice(inputLength),
            };
          }
          throw err;
        }

        emitTurnCompleted({
          index: i,
          outcome: "continue",
          durationMs: performance.now() - turnStartTime,
          tokens: state.tokens,
        });
      }

      if (memoryEnabled) {
        state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
        await saveMemoryIfChanged();
      }

      emitMaxIterationsTerminal({
        agentName: state.agentName ?? state.assistant,
        maxIterations: config.limits.maxIterations,
        turnDurationMs: performance.now() - turnStartTime,
        runDurationMs: performance.now() - runStartTime,
        tokens: state.tokens,
      });

      return {
        exit: { kind: "exhausted", cycleCount: config.limits.maxIterations },
        messages: state.messages.slice(inputLength),
      };
    } catch (err) {
      if (err instanceof WaitRequested) {
        return {
          exit: { kind: "waiting", waitingOn: err.waitingOn },
          messages: state.messages.slice(inputLength),
        };
      }
      const errorMsg = getErrorMessage(err);
      emitFailureTerminal({
        agentName: state.agentName ?? state.assistant,
        iterations: state.iteration + 1,
        runDurationMs: performance.now() - runStartTime,
        tokens: state.tokens,
        error: errorMsg,
      });
      throw err;
    } finally {
      detachLogger();
      detachJsonl();
      await Promise.all([md.flush(), flushJsonl()]);
      md.dispose();
    }
  });
}