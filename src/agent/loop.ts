import type { LLMProvider, LLMMessage, LLMChatResponse, LLMToolCall } from "../types/llm.ts";
import type { Logger } from "../types/logger.ts";
import type { PromptResult } from "../llm/prompt.ts";
import type { AgentState } from "../types/agent-state.ts";
import { llm as defaultLLM } from "../llm/llm.ts";
import { config } from "../config/index.ts";
import { dispatch } from "../tools/index.ts";
import { promptService } from "../llm/prompt.ts";
import { agentsService } from "./agents.ts";
import { MarkdownLogger } from "../infra/log/markdown.ts";
import { ConsoleLogger } from "../infra/log/console.ts";
import { createCompositeLogger } from "../infra/log/composite.ts";
import { runWithContext, requireState } from "./context.ts";
import { processMemory, flushMemory } from "./memory/processor.ts";
import { saveState } from "./memory/persistence.ts";
import { bus } from "../infra/events.ts";
import { createJsonlWriter } from "../infra/log/jsonl.ts";
import { attachLoggerListener } from "../infra/log/bridge.ts";

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
  const detachLogger = attachLoggerListener(bus, log);

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

async function executePlanPhase(
  planPrompt: PromptResult,
  provider: LLMProvider,
): Promise<string> {
  const state = requireState();
  const planMessages: LLMMessage[] = [
    { role: "system", content: planPrompt.content },
    ...state.messages,
  ];

  const planStart = performance.now();
  const planResponse = await provider.chatCompletion({
    model: planPrompt.model!,
    messages: planMessages,
    ...(planPrompt.temperature !== undefined && {
      temperature: planPrompt.temperature,
    }),
  });
  const durationMs = performance.now() - planStart;
  const planText = planResponse.content ?? "";

  state.tokens.plan.promptTokens += planResponse.usage?.promptTokens ?? 0;
  state.tokens.plan.completionTokens += planResponse.usage?.completionTokens ?? 0;

  bus.emit("plan.produced", {
    model: planPrompt.model!,
    durationMs,
    tokensIn: planResponse.usage?.promptTokens ?? 0,
    tokensOut: planResponse.usage?.completionTokens ?? 0,
    summary: planText.slice(0, 200),
    fullText: planText,
  });

  return planText;
}

async function executeActPhase(
  planText: string,
  actSystemPrompt: string,
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const state = requireState();
  const actMessages: LLMMessage[] = [
    { role: "system", content: actSystemPrompt },
    ...state.messages,
    { role: "assistant", content: `## Current Plan\n\n${planText}` },
  ];

  const actStart = performance.now();
  const response = await provider.chatCompletion({
    model: state.model,
    messages: actMessages,
    tools: state.tools,
  });
  const durationMs = performance.now() - actStart;

  state.tokens.act.promptTokens += response.usage?.promptTokens ?? 0;
  state.tokens.act.completionTokens += response.usage?.completionTokens ?? 0;

  bus.emit("turn.acted", {
    toolCount: response.toolCalls.length,
    durationMs,
    tokensIn: response.usage?.promptTokens ?? 0,
    tokensOut: response.usage?.completionTokens ?? 0,
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

  for (let idx = 0; idx < functionCalls.length; idx++) {
    const tc = functionCalls[idx];
    bus.emit("tool.dispatched", {
      callId: tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
      batchIndex: idx,
      batchSize: functionCalls.length,
    });
  }

  const batchStart = performance.now();
  let succeeded = 0;
  let failed = 0;

  const settled = await Promise.allSettled(
    functionCalls.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments, tc.id);
      return { ...result, durationMs: performance.now() - start };
    })
  );

  for (let j = 0; j < functionCalls.length; j++) {
    const tc = functionCalls[j];
    const outcome = settled[j];

    if (outcome.status === "fulfilled") {
      const { content, isError, durationMs } = outcome.value;
      if (isError) {
        failed++;
        bus.emit("tool.completed", {
          callId: tc.id,
          name: tc.function.name,
          ok: false,
          durationMs,
          error: content,
        });
      } else {
        succeeded++;
        bus.emit("tool.completed", {
          callId: tc.id,
          name: tc.function.name,
          ok: true,
          durationMs,
          result: content,
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
      bus.emit("tool.completed", {
        callId: tc.id,
        name: tc.function.name,
        ok: false,
        durationMs: 0,
        error: errorMsg,
      });
      state.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: `Error: ${errorMsg}`,
      });
    }
  }

  if (functionCalls.length > 1) {
    bus.emit("batch.completed", {
      count: functionCalls.length,
      durationMs: performance.now() - batchStart,
      succeeded,
      failed,
    });
  }
}

export interface AgentResult {
  answer: string;
  messages: LLMMessage[];
}

export async function runAgent(
  state: AgentState,
  provider: LLMProvider = defaultLLM,
): Promise<AgentResult> {
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, md, detachLogger, detachJsonl, flushJsonl } = setupSession(userPrompt, state.sessionId);

  const inputLength = state.messages.length;

  return runWithContext(state, log, async () => {
    let lastSavedJson = "";

    async function saveIfChanged(): Promise<void> {
      const json = JSON.stringify(state.memory);
      if (json === lastSavedJson) return;
      await saveState(state.sessionId, state.memory);
      lastSavedJson = json;
    }

    try {
      const [resolved, planPrompt] = await Promise.all([
        agentsService.resolve(state.assistant),
        promptService.load("plan"),
      ]);

      if (!state.model) {
        state.model = resolved.model;
      }

      state.tools = resolved.tools;

      bus.emit("session.opened", {
        assistant: state.assistant,
        model: state.model,
      });

      const actSystemPrompt = resolved.prompt;

      for (let i = 0; i < config.limits.maxIterations; i++) {
        state.iteration = i;

        bus.emit("turn.began", {
          iteration: i + 1,
          maxIterations: config.limits.maxIterations,
          model: state.model,
          messageCount: state.messages.length,
        });

        const { context, state: updatedMemory } = await processMemory(
          actSystemPrompt,
          state.messages,
          state.memory,
          provider,
          state.sessionId,
        );
        state.memory = updatedMemory;

        const originalMessages = state.messages;
        state.messages = context.messages;

        const planText = await executePlanPhase(planPrompt, provider);
        const response = await executeActPhase(planText, context.systemPrompt, provider);

        const newMessages = state.messages.slice(context.messages.length);
        state.messages = originalMessages.concat(newMessages);

        await saveIfChanged();

        if (response.finishReason === "stop" || !response.toolCalls.length) {
          state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
          await saveIfChanged();

          bus.emit("turn.ended", { iteration: i + 1, outcome: "answer" });
          bus.emit("agent.answer", { text: response.content });
          bus.emit("session.closed", {
            reason: "answer",
            iterations: i + 1,
            tokens: { ...state.tokens },
          });

          return { answer: response.content ?? "", messages: state.messages.slice(inputLength) };
        }

        const functionCalls = response.toolCalls.filter(tc => tc.type === "function");
        await dispatchTools(functionCalls);

        bus.emit("turn.ended", { iteration: i + 1, outcome: "continue" });
      }

      state.memory = await flushMemory(state.messages, state.memory, provider, state.sessionId);
      await saveIfChanged();

      bus.emit("turn.ended", {
        iteration: config.limits.maxIterations,
        outcome: "max_iterations",
      });
      bus.emit("session.closed", {
        reason: "max_iterations",
        iterations: config.limits.maxIterations,
        tokens: { ...state.tokens },
      });

      return { answer: "", messages: state.messages.slice(inputLength) };
    } finally {
      detachLogger();
      detachJsonl();
      await Promise.all([md.flush(), flushJsonl()]);
      md.dispose();
    }
  });
}
