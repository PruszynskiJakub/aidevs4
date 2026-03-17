import type { LLMProvider, LLMMessage } from "./types/llm.ts";
import type { ToolFilter } from "./types/assistant.ts";
import { llm as defaultLLM } from "./services/llm.ts";
import { config } from "./config/index.ts";
import { getTools, dispatch } from "./tools/index.ts";
import { promptService } from "./services/prompt.ts";
import { elapsed } from "./services/logger.ts";
import { MarkdownLogger } from "./services/markdown-logger.ts";
import { ConsoleLogger } from "./services/console-logger.ts";
import { CompositeLogger } from "./services/composite-logger.ts";
import { assistants } from "./services/assistants.ts";
import { isToolResponse } from "./utils/tool-response.ts";
import { runWithSession } from "./services/session-context.ts";

function parseToolResponse(raw: string): { data: unknown; hints?: string[] } {
  try {
    const parsed = JSON.parse(raw);
    if (isToolResponse(parsed)) {
      return { data: parsed.data, hints: parsed.hints };
    }
  } catch { /* not JSON — return raw */ }
  return { data: raw };
}

export async function runAgent(
  messages: LLMMessage[],
  provider: LLMProvider = defaultLLM,
  options?: { model?: string; sessionId?: string; toolFilter?: ToolFilter },
): Promise<string> {
  const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
  const md = new MarkdownLogger({ sessionId: options?.sessionId });
  md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");
  const log = new CompositeLogger([new ConsoleLogger(), md]);

  log.info(`Session: ${md.sessionId}`);
  log.info(`Log: ${md.filePath}`);

  return runWithSession(md.sessionId, async () => {
    const toolFilter = options?.toolFilter;
    const [tools, planPrompt] = await Promise.all([
      getTools(toolFilter),
      promptService.load("plan"),
    ]);
    const planModel = planPrompt.model!;

    // Resolve act model
    let actModel: string;
    if (options?.model) {
      actModel = options.model;
    } else {
      const assistant = await assistants.get("default");
      const act = await promptService.load("act", {
        objective: assistant.objective,
        tone: assistant.tone,
      });
      actModel = act.model!;
    }

    for (let i = 0; i < config.limits.maxIterations; i++) {
      log.step(i + 1, config.limits.maxIterations, actModel, messages.length);

      // --- PLAN PHASE ---
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
      const planTime = elapsed(planStart);
      const planText = planResponse.content ?? "";

      log.plan(
        planText,
        planModel,
        planTime,
        planResponse.usage?.promptTokens,
        planResponse.usage?.completionTokens,
      );

      // --- ACT PHASE ---
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
      const actTime = elapsed(actStart);

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

      log.toolHeader(functionCalls.length);
      for (const tc of functionCalls) {
        log.toolCall(tc.function.name, tc.function.arguments);
      }

      const batchStart = performance.now();

      const settled = await Promise.allSettled(
        functionCalls.map(async (tc) => {
          const start = performance.now();
          const result = await dispatch(tc.function.name, tc.function.arguments, toolFilter);
          return { result, elapsed: elapsed(start) };
        })
      );

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
        log.batchDone(functionCalls.length, elapsed(batchStart));
      }
    }

    log.maxIter(config.limits.maxIterations);
    await md.flush();
    return "";
  });
}

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  args.splice(idx, 2);
  return value;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const sessionId = extractFlag(args, "--session");
  const modelOverride = extractFlag(args, "--model");

  // Remaining args: [assistant] "prompt" or just "prompt"
  let assistantName: string;
  let prompt: string;

  if (args.length >= 2) {
    assistantName = args[0];
    prompt = args[1];
  } else if (args.length === 1) {
    assistantName = config.assistant ?? "default";
    prompt = args[0];
  } else {
    console.error('Usage: bun run agent [assistant] "your prompt" [--session <id>] [--model <model>]');
    process.exit(1);
  }

  const assistant = await assistants.get(assistantName);
  const act = await promptService.load("act", {
    objective: assistant.objective,
    tone: assistant.tone,
  });
  const agentModel = modelOverride ?? assistant.model ?? act.model!;
  const messages: LLMMessage[] = [
    { role: "system", content: act.content },
    { role: "user", content: prompt },
  ];

  void runAgent(messages, undefined, {
    model: agentModel,
    sessionId,
    toolFilter: assistant.tools,
  });
}
