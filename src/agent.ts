import type { LLMProvider, LLMMessage } from "./types/llm.ts";
import { llm as defaultLLM } from "./services/llm.ts";
import { MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/dispatcher.ts";
import { promptService } from "./services/prompt.ts";
import { log, duration } from "./services/logger.ts";

export async function runAgent(userPrompt: string, provider: LLMProvider = defaultLLM) {
  const tools = await getTools();
  const system = await promptService.load("system");

  const messages: LLMMessage[] = [
    { role: "system", content: system.content },
    { role: "user", content: userPrompt },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log.info(`[iter ${i + 1}/${MAX_ITERATIONS}]`);

    const llmStart = performance.now();
    const response = await provider.chatCompletion({
      model: system.model!,
      messages,
      tools,
    });
    const llmTime = duration(llmStart);

    log.debug(`LLM ← ${system.model} | ${messages.length} msgs | ${llmTime}`);
    if (response.usage) {
      log.debug(`tokens: ${response.usage.promptTokens} in / ${response.usage.completionTokens} out`);
    }

    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
    });

    if (response.finishReason === "stop" || !response.toolCalls.length) {
      log.success(`Agent response:\n${response.content ?? "(no response)"}`);
      return;
    }

    const functionCalls = response.toolCalls.filter(tc => tc.type === "function");

    for (const tc of functionCalls) {
      log.info(`→ ${tc.function.name}(${tc.function.arguments})`);
    }

    const batchStart = performance.now();

    const settled = await Promise.allSettled(
      functionCalls.map(async (tc) => {
        const start = performance.now();
        const result = await dispatch(tc.function.name, tc.function.arguments);
        return { result, elapsed: duration(start) };
      })
    );

    for (let j = 0; j < functionCalls.length; j++) {
      const tc = functionCalls[j];
      const outcome = settled[j];

      if (outcome.status === "fulfilled") {
        const { result, elapsed } = outcome.value;
        log.debug(`← ${tc.function.name}: ${result}`);
        log.success(`${tc.function.name} done ${elapsed}`);
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: result,
        });
      } else {
        const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        const errorResult = JSON.stringify({ error: errorMsg });
        log.error(`${tc.function.name}: ${errorMsg}`);
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: errorResult,
        });
      }
    }

    if (functionCalls.length > 1) {
      log.info(`Batch: ${functionCalls.length} tools ${duration(batchStart)}`);
    }
  }

  log.error(`Agent reached maximum iterations (${MAX_ITERATIONS}).`);
}

// CLI entry point
if (import.meta.main) {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error("Usage: bun run src/agent.ts \"your prompt here\"");
    process.exit(1);
  }
  void runAgent(prompt);
}
