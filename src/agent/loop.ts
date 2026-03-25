import type { LLMProvider, LLMMessage, LLMChatResponse, LLMToolCall } from "../types/llm.ts";
import type { Logger } from "../types/logger.ts";
import type { PromptResult } from "../llm/prompt.ts";
import type { AgentState } from "../types/agent-state.ts";
import { llm as defaultLLM } from "../llm/llm.ts";
import { config } from "../config/index.ts";
import { getTools, dispatch } from "../tools/index.ts";
import { promptService } from "../llm/prompt.ts";
import { agentsService } from "./agents.ts";
import { elapsed } from "../utils/timing.ts";
import { MarkdownLogger } from "../infra/log/markdown.ts";
import { ConsoleLogger } from "../infra/log/console.ts";
import { createCompositeLogger } from "../infra/log/composite.ts";
import { runWithContext, requireState, requireLogger } from "./context.ts";
import { createErrorDocument, formatDocumentsXml } from "../infra/document.ts";
import { processMemory, flushMemory } from "./memory/processor.ts";
import { saveState } from "./memory/persistence.ts";

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

async function executePlanPhase(
  planPrompt: PromptResult,
  provider: LLMProvider,
): Promise<string> {
  const state = requireState();
  const log = requireLogger();
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
  actSystemPrompt: string,
  provider: LLMProvider,
): Promise<LLMChatResponse> {
  const state = requireState();
  const log = requireLogger();
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
): Promise<void> {
  const log = requireLogger();
  const state = requireState();
  log.toolHeader(functionCalls.length);
  for (const tc of functionCalls) {
    log.toolCall(tc.function.name, tc.function.arguments);
  }

  const batchStart = performance.now();

  const settled = await Promise.allSettled(
    functionCalls.map(async (tc) => {
      const start = performance.now();
      const result = await dispatch(tc.function.name, tc.function.arguments);
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
        content: formatDocumentsXml(createErrorDocument(tc.function.name, errorMsg)),
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
  state: AgentState,
  provider: LLMProvider = defaultLLM,
): Promise<AgentResult> {
  const userPrompt = state.messages.find((m) => m.role === "user")?.content ?? "";
  const { log, md } = createLogger(userPrompt, state.sessionId);

  const inputLength = state.messages.length;

  return runWithContext(state, log, async () => {
    try {
      // Resolve agent config, tools, and prompts
      const [resolved, planPrompt] = await Promise.all([
        agentsService.resolve(state.assistant),
        promptService.load("plan"),
      ]);

      // Set model from assistant if not overridden
      if (!state.model) {
        state.model = resolved.model;
      }

      // Populate tools from registry (filtered by assistant config)
      state.tools = await getTools(resolved.toolFilter);

      const actSystemPrompt = resolved.prompt;

      for (let i = 0; i < config.limits.maxIterations; i++) {
        state.iteration = i;
        log.step(i + 1, config.limits.maxIterations, state.model, state.messages.length);

        // Process memory — compress old messages into observations if needed
        const { context, state: updatedMemory } = await processMemory(
          actSystemPrompt,
          state.messages,
          state.memory,
          provider,
          log,
          state.sessionId,
        );
        state.memory = updatedMemory;

        // Use processed messages for LLM calls (observations baked into system prompt)
        const originalMessages = state.messages;
        state.messages = context.messages;

        const planText = await executePlanPhase(planPrompt, provider);
        const response = await executeActPhase(planText, context.systemPrompt, provider);

        // Restore full message history (act phase already appended the assistant message to state.messages)
        // We need to merge: keep original observed messages + new tail messages + newly appended messages
        const newMessages = state.messages.slice(context.messages.length);
        state.messages = [...originalMessages, ...newMessages];

        // Persist memory state after each iteration
        await saveState(state.sessionId, state.memory);

        if (response.finishReason === "stop" || !response.toolCalls.length) {
          // Flush remaining unprocessed messages
          state.memory = await flushMemory(state.messages, state.memory, provider, log, state.sessionId);
          await saveState(state.sessionId, state.memory);
          log.answer(response.content);
          return { answer: response.content ?? "", messages: state.messages.slice(inputLength) };
        }

        const functionCalls = response.toolCalls.filter(tc => tc.type === "function");
        await dispatchTools(functionCalls);
      }

      // Flush memory on max iterations too
      state.memory = await flushMemory(state.messages, state.memory, provider, log, state.sessionId);
      await saveState(state.sessionId, state.memory);

      log.maxIter(config.limits.maxIterations);
      return { answer: "", messages: state.messages.slice(inputLength) };
    } finally {
      await md.flush();
      md.dispose();
    }
  });
}
