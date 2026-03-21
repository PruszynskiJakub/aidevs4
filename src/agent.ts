import type { LLMProvider, LLMMessage, LLMChatResponse, LLMTool, LLMToolCall } from "./types/llm.ts";
import type { Logger } from "./types/logger.ts";
import type { ToolFilter } from "./types/tool.ts";
import type { PromptResult } from "./services/ai/prompt.ts";
import type { AgentState } from "./types/agent-state.ts";
import { llm as defaultLLM } from "./services/ai/llm.ts";
import { config } from "./config/index.ts";
import { getTools, dispatch } from "./tools/index.ts";
import { promptService } from "./services/ai/prompt.ts";
import { elapsed } from "./utils/timing.ts";
import { MarkdownLogger } from "./services/common/logging/markdown-logger.ts";
import { ConsoleLogger } from "./services/common/logging/console-logger.ts";
import { createCompositeLogger } from "./services/common/logging/composite-logger.ts";
import { assistantResolverService } from "./services/agent/assistant/assistant-resolver.ts";
import { runWithContext, requireState, requireLogger } from "./utils/session-context.ts";

function createLogger(
  userPrompt: string | unknown,
  sessionId?: string,
): { log: Logger; md: MarkdownLogger } {
  const md = new MarkdownLogger({ sessionId });
  md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");
  const log = createCompositeLogger([new ConsoleLogger(), md]);
  log.info(`Session: ${md.sessionId}`);
  log.info(`Log: ${md.filePath}`);
  return { log, md };
}

async function resolveActModel(assistantName: string, modelOverride?: string): Promise<string> {
  if (modelOverride) return modelOverride;
  const resolved = await assistantResolverService.resolve(assistantName);
  return resolved.model;
}

async function executePlanPhase(
  planPrompt: PromptResult,
  provider: LLMProvider,
): Promise<string> {
  const state = requireState();
  const log = requireLogger();
  const planMessages: LLMMessage[] = [
    { role: "system", content: planPrompt.content },
    ...state.messages.filter((m) => m.role !== "system"),
  ];

  const planStart = performance.now();
  const planResponse = await provider.chatCompletion({
    model: planPrompt.model!,
    messages: planMessages,
    ...(planPrompt.temperature !== undefined && {
      temperature: planPrompt.temperature,
    }),
  });
  const planTime = elapsed(planStart);
  const planText = planResponse.content ?? "";

  state.tokens.plan.promptTokens += planResponse.usage?.promptTokens ?? 0;
  state.tokens.plan.completionTokens += planResponse.usage?.completionTokens ?? 0;

  log.plan(
    planText,
    planPrompt.model!,
    planTime,
    planResponse.usage?.promptTokens,
    planResponse.usage?.completionTokens,
  );

  return planText;
}

async function executeActPhase(
  planText: string,
  actModel: string,
  tools: LLMTool[],
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const state = requireState();
  const log = requireLogger();
  const actMessages: LLMMessage[] = [
    ...state.messages,
    { role: "assistant", content: `## Current Plan\n\n${planText}` },
  ];

  const actStart = performance.now();
  const response = await provider.chatCompletion({
    model: actModel,
    messages: actMessages,
    tools,
  });
  const actTime = elapsed(actStart);

  state.tokens.act.promptTokens += response.usage?.promptTokens ?? 0;
  state.tokens.act.completionTokens += response.usage?.completionTokens ?? 0;

  log.llm(
    actTime,
    response.usage?.promptTokens,
    response.usage?.completionTokens,
  );

  state.messages.push({
    role: "assistant",
    content: response.content,
    ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
  });

  return response;
}

async function dispatchTools(
  functionCalls: LLMToolCall[],
  toolFilter: ToolFilter | undefined,
): Promise<void> {
  const state = requireState();
  const log = requireLogger();
  log.toolHeader(functionCalls.length);
  for (const tc of functionCalls) {
    log.toolCall(tc.function.name, tc.function.arguments);
  }

  const batchStart = performance.now();

  const settled = await Promise.allSettled(
    functionCalls.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments, toolFilter);
      return { ...result, elapsed: elapsed(start) };
    })
  );

  for (let j = 0; j < functionCalls.length; j++) {
    const tc = functionCalls[j];
    const outcome = settled[j];

    if (outcome.status === "fulfilled") {
      const { xml, isError, elapsed } = outcome.value;
      if (isError) {
        log.toolErr(tc.function.name, xml);
      } else {
        log.toolOk(tc.function.name, elapsed, xml);
      }
      state.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: xml,
      });
    } else {
      // Promise.allSettled rejection — should not happen since dispatch catches errors,
      // but handle defensively
      const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log.toolErr(tc.function.name, errorMsg);
      state.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: `<document id="error" description="Error from ${tc.function.name}">Error: ${errorMsg}</document>`,
      });
    }
  }

  if (functionCalls.length > 1) {
    log.batchDone(functionCalls.length, elapsed(batchStart));
  }
}

export interface AgentResult {
  answer: string;
  messages: LLMMessage[];
}

export async function runAgent(
  messages: LLMMessage[],
  provider: LLMProvider = defaultLLM,
  options?: { model?: string; sessionId?: string; toolFilter?: ToolFilter; assistant?: string },
): Promise<AgentResult> {
  const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
  const { log, md } = createLogger(userPrompt, options?.sessionId);

  const internalMessages = [...messages];
  const inputLength = messages.length;

  const state: AgentState = {
    sessionId: md.sessionId,
    messages: internalMessages,
    tokens: {
      plan: { promptTokens: 0, completionTokens: 0 },
      act: { promptTokens: 0, completionTokens: 0 },
    },
    iteration: 0,
  };

  return runWithContext(state, log, async () => {
    try {
      const [tools, planPrompt] = await Promise.all([
        getTools(options?.toolFilter),
        promptService.load("plan"),
      ]);
      const actModel = await resolveActModel(options?.assistant ?? "default", options?.model);

      for (let i = 0; i < config.limits.maxIterations; i++) {
        state.iteration = i;
        log.step(i + 1, config.limits.maxIterations, actModel, state.messages.length);

        const planText = await executePlanPhase(planPrompt, provider);
        const response = await executeActPhase(planText, actModel, tools, provider);

        if (response.finishReason === "stop" || !response.toolCalls.length) {
          log.answer(response.content);
          return { answer: response.content ?? "", messages: internalMessages.slice(inputLength) };
        }

        const functionCalls = response.toolCalls.filter(tc => tc.type === "function");
        await dispatchTools(functionCalls, options?.toolFilter);
      }

      log.maxIter(config.limits.maxIterations);
      return { answer: "", messages: internalMessages.slice(inputLength) };
    } finally {
      await md.flush();
      md.dispose();
    }
  });
}
