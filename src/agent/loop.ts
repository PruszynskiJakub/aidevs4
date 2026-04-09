import type { LLMProvider, LLMMessage, LLMChatResponse, LLMToolCall } from "../types/llm.ts";
import type { Logger } from "../types/logger.ts";
import type { AgentState } from "../types/agent-state.ts";
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
import { WORKSPACE_NAV_INSTRUCTIONS } from "./workspace.ts";

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
  bus.emit("generation.started", { name: "act", model: state.model, startTime });

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

  bus.emit("generation.completed", {
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
    bus.emit("batch.started", {
      batchId,
      toolCallIds: approved.map((tc) => tc.id),
      count: approved.length,
    });
  }

  for (let idx = 0; idx < approved.length; idx++) {
    const tc = approved[idx];
    bus.emit("tool.called", {
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

  for (let j = 0; j < approved.length; j++) {
    const tc = approved[j];
    const outcome = settled[j];

    if (outcome.status === "fulfilled") {
      const { content, isError, durationMs } = outcome.value;
      if (isError) {
        failed++;
        bus.emit("tool.failed", {
          toolCallId: tc.id,
          name: tc.function.name,
          durationMs,
          error: content,
          args: tc.function.arguments,
          startTime: dispatchTime,
        });
      } else {
        succeeded++;
        bus.emit("tool.succeeded", {
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
      bus.emit("tool.failed", {
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
    bus.emit("batch.completed", {
      batchId,
      count: approved.length,
      durationMs: performance.now() - batchStart,
      succeeded,
      failed,
    });
  }
}

export type { AgentResult } from "../types/agent.ts";
import type { AgentResult } from "../types/agent.ts";

interface MemoryContext {
  systemPrompt: string;
  messagesSnapshot: LLMMessage[];
  contextLength: number;
}

async function buildTurnContext(
  actSystemPrompt: string,
  state: AgentState,
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

function createMemorySaver(state: AgentState) {
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
  state: AgentState,
  provider: LLMProvider = defaultLLM,
): Promise<AgentResult> {
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, md, detachLogger, detachJsonl, flushJsonl } = setupSession(userPrompt, state.sessionId);

  const inputLength = state.messages.length;

  return runWithContext(state, log, async () => {
    const saveMemoryIfChanged = createMemorySaver(state);
    const agentStartTime = performance.now();

    try {
      const resolved = await agentsService.resolve(state.assistant);

      if (!state.model) {
        state.model = resolved.model;
      }

      state.tools = resolved.tools;

      bus.emit("session.opened", {
        assistant: state.assistant,
        model: state.model,
        userInput: typeof userPrompt === "string" ? userPrompt : undefined,
      });

      bus.emit("agent.started", {
        agentName: state.agentName ?? state.assistant,
        model: state.model,
        task: typeof userPrompt === "string" ? userPrompt : "(structured)",
        parentAgentId: state.parentAgentId,
        depth: state.depth ?? 0,
      });

      const actSystemPrompt = `${WORKSPACE_NAV_INSTRUCTIONS}\n\n${resolved.prompt}`;
      const memoryEnabled = resolved.memory !== false;
      let turnStartTime = 0;

      for (let i = 0; i < config.limits.maxIterations; i++) {
        state.iteration = i;
        turnStartTime = performance.now();

        bus.emit("turn.started", {
          iteration: i + 1,
          maxIterations: config.limits.maxIterations,
          model: state.model,
          messageCount: state.messages.length,
        });

        const turnCtx = await buildTurnContext(actSystemPrompt, state, memoryEnabled, provider);
        const response = await executeActPhase(turnCtx.systemPrompt, provider);

        const newMessages = state.messages.slice(turnCtx.contextLength);
        state.messages = turnCtx.messagesSnapshot.concat(newMessages);

        await saveMemoryIfChanged();

        if (response.finishReason === "stop" || !response.toolCalls.length) {
          if (memoryEnabled) {
            state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
            await saveMemoryIfChanged();
          }

          bus.emit("turn.completed", {
            iteration: i + 1,
            outcome: "answer",
            durationMs: performance.now() - turnStartTime,
            tokens: { ...state.tokens },
          });
          bus.emit("agent.answered", { text: response.content });
          bus.emit("agent.completed", {
            agentName: state.agentName ?? state.assistant,
            durationMs: performance.now() - agentStartTime,
            iterations: i + 1,
            tokens: { ...state.tokens },
            result: response.content,
          });
          bus.emit("session.completed", {
            reason: "answer",
            iterations: i + 1,
            tokens: { ...state.tokens },
          });

          return { answer: response.content ?? "", messages: state.messages.slice(inputLength) };
        }

        const functionCalls = response.toolCalls.filter(tc => tc.type === "function");
        await dispatchTools(functionCalls);

        bus.emit("turn.completed", {
          iteration: i + 1,
          outcome: "continue",
          durationMs: performance.now() - turnStartTime,
          tokens: { ...state.tokens },
        });
      }

      if (memoryEnabled) {
        state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
        await saveMemoryIfChanged();
      }

      bus.emit("turn.completed", {
        iteration: config.limits.maxIterations,
        outcome: "max_iterations",
        durationMs: performance.now() - turnStartTime,
        tokens: { ...state.tokens },
      });
      bus.emit("agent.completed", {
        agentName: state.agentName ?? state.assistant,
        durationMs: performance.now() - agentStartTime,
        iterations: config.limits.maxIterations,
        tokens: { ...state.tokens },
        result: null,
      });
      bus.emit("session.completed", {
        reason: "max_iterations",
        iterations: config.limits.maxIterations,
        tokens: { ...state.tokens },
      });

      return { answer: "", messages: state.messages.slice(inputLength) };
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      bus.emit("agent.failed", {
        agentName: state.agentName ?? state.assistant,
        durationMs: performance.now() - agentStartTime,
        iterations: state.iteration + 1,
        error: errorMsg,
      });
      bus.emit("session.failed", {
        iterations: state.iteration + 1,
        tokens: { ...state.tokens },
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
