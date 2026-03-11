import type { LLMProvider, LLMMessage } from "./types/llm.ts";
import { llm as defaultLLM } from "./services/llm.ts";
import { MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/dispatcher.ts";
import { promptService } from "./services/prompt.ts";
import { createLogger, duration } from "./services/logger.ts";
import { MarkdownLogger } from "./services/markdown-logger.ts";

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
): Promise<string> {
  const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
  const md = new MarkdownLogger();
  md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");
  const log = createLogger(md);

  const tools = await getTools();
  const system = await promptService.load("system");

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log.step(i + 1, MAX_ITERATIONS, system.model!, messages.length);

    const llmStart = performance.now();
    const response = await provider.chatCompletion({
      model: system.model!,
      messages,
      tools,
    });
    const llmTime = duration(llmStart);

    log.llm(
      llmTime,
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
  const prompt = process.argv[2];
  if (!prompt) {
    console.error("Usage: bun run src/agent.ts \"your prompt here\"");
    process.exit(1);
  }

  const system = await promptService.load("system");
  const messages: LLMMessage[] = [
    { role: "system", content: system.content },
    { role: "user", content: prompt },
  ];

  void runAgent(messages);
}
