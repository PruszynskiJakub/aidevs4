import type { LLMProvider, LLMMessage } from "./types/llm.ts";
import { llm as defaultLLM } from "./services/llm.ts";
import { MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/index.ts";
import { promptService } from "./services/prompt.ts";
import { createLogger, duration } from "./services/logger.ts";
import { MarkdownLogger } from "./services/markdown-logger.ts";
import { getPersona } from "./config/personas.ts";

function parseToolResponse(raw: string): { data: unknown; hints?: string[] } {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "status" in parsed &&
      "data" in parsed &&
      (parsed.status === "ok" || parsed.status === "error")
    ) {
      return { data: parsed.data, hints: parsed.hints };
    }
  } catch { /* not JSON — return raw */ }
  return { data: raw };
}

export async function runAgent(
  messages: LLMMessage[],
  provider: LLMProvider = defaultLLM,
  options?: { model?: string; sessionId?: string },
): Promise<string> {
  const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
  const md = new MarkdownLogger({ sessionId: options?.sessionId });
  md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");
  const log = createLogger(md);

  log.info(`Session: ${md.sessionId}`);
  log.info(`Log: ${md.filePath}`);

  const tools = await getTools();

  // Load plan prompt (independent of persona)
  const planPrompt = await promptService.load("plan");
  const planModel = planPrompt.model!;

  // Resolve act model
  let actModel: string;
  if (options?.model) {
    actModel = options.model;
  } else {
    const persona = getPersona();
    const act = await promptService.load("act", {
      objective: persona.objective,
      tone: persona.tone,
    });
    actModel = act.model!;
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log.step(i + 1, MAX_ITERATIONS, actModel, messages.length);

    // --- PLAN PHASE ---
    // Build plan messages: plan system prompt + conversation history (without act system prompt)
    const planMessages: LLMMessage[] = [
      { role: "system", content: planPrompt.content },
      ...messages.filter((m) => m.role !== "system"),
    ];

    const planStart = performance.now();
    const planResponse = await provider.chatCompletion({
      model: planModel,
      messages: planMessages,
      ...(planPrompt.temperature !== undefined && {
        temperature: planPrompt.temperature,
      }),
    });
    const planTime = duration(planStart);
    const planText = planResponse.content ?? "";

    log.plan(
      planText,
      planModel,
      planTime,
      planResponse.usage?.promptTokens,
      planResponse.usage?.completionTokens,
    );

    // --- ACT PHASE ---
    // Inject plan as assistant message — only for the act call, not persisted in main history
    const actMessages: LLMMessage[] = [
      ...messages,
      { role: "assistant", content: `## Current Plan\n\n${planText}` },
    ];

    const actStart = performance.now();
    const response = await provider.chatCompletion({
      model: actModel,
      messages: actMessages,
      tools,
    });
    const actTime = duration(actStart);

    log.llm(
      actTime,
      response.usage?.promptTokens,
      response.usage?.completionTokens,
    );

    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
    });

    if (response.finishReason === "stop" || !response.toolCalls.length) {
      log.answer(response.content);
      await md.flush();
      return response.content ?? "";
    }

    const functionCalls = response.toolCalls.filter(tc => tc.type === "function");

    // Announce all tool calls upfront
    log.toolHeader(functionCalls.length);
    for (const tc of functionCalls) {
      log.toolCall(tc.function.name, tc.function.arguments);
    }

    // Execute tools
    const batchStart = performance.now();

    const settled = await Promise.allSettled(
      functionCalls.map(async (tc) => {
        const start = performance.now();
        const result = await dispatch(tc.function.name, tc.function.arguments);
        return { result, elapsed: duration(start) };
      })
    );

    // Report results — parse ToolResponse, extract data for LLM, surface hints in log
    for (let j = 0; j < functionCalls.length; j++) {
      const tc = functionCalls[j];
      const outcome = settled[j];

      if (outcome.status === "fulfilled") {
        const { result, elapsed } = outcome.value;
        const parsed = parseToolResponse(result);
        const llmContent = JSON.stringify(parsed.data);
        log.toolOk(tc.function.name, elapsed, llmContent, parsed.hints);
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: llmContent,
        });
      } else {
        const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        const errorResult = JSON.stringify({ error: errorMsg });
        log.toolErr(tc.function.name, errorMsg);
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: errorResult,
        });
      }
    }

    if (functionCalls.length > 1) {
      log.batchDone(functionCalls.length, duration(batchStart));
    }
  }

  log.maxIter(MAX_ITERATIONS);
  await md.flush();
  return "";
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  let sessionId: string | undefined;

  // Extract --session flag
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1) {
    sessionId = args[sessionIdx + 1];
    if (!sessionId) {
      console.error("--session requires a value");
      process.exit(1);
    }
    args.splice(sessionIdx, 2);
  }

  const prompt = args[0];
  if (!prompt) {
    console.error('Usage: bun run agent "your prompt" [--session <id>]');
    process.exit(1);
  }

  const persona = getPersona(process.env.PERSONA);
  const act = await promptService.load("act", {
    objective: persona.objective,
    tone: persona.tone,
  });
  const agentModel = persona.model ?? act.model!;
  const messages: LLMMessage[] = [
    { role: "system", content: act.content },
    { role: "user", content: prompt },
  ];

  void runAgent(messages, undefined, { model: agentModel, sessionId });
}
