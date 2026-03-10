import type { LLMProvider, LLMMessage } from "./types/llm.ts";
import { llm as defaultLLM } from "./services/llm.ts";
import { AGENT_MODEL, MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/dispatcher.ts";
import { SYSTEM_PROMPT } from "./prompts/system.ts";

export async function runAgent(userPrompt: string, provider: LLMProvider = defaultLLM) {
  const tools = await getTools();

  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await provider.chatCompletion({
      model: AGENT_MODEL,
      messages,
      tools,
    });

    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
    });

    if (response.finishReason === "stop" || !response.toolCalls.length) {
      console.log("\n" + (response.content ?? "(no response)"));
      return;
    }

    for (const toolCall of response.toolCalls) {
      if (toolCall.type !== "function") continue;
      const { name, arguments: argsJson } = toolCall.function;
      console.log(`→ ${name}(${argsJson})`);

      const result = await dispatch(name, argsJson);
      console.log(`  ✓ done`);

      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: result,
      });
    }
  }

  console.log("Agent reached maximum iterations.");
}

// CLI entry point
const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: bun run src/agent.ts \"your prompt here\"");
  process.exit(1);
}

void runAgent(prompt);
