import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AGENT_MODEL, MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/dispatcher.ts";
import { SYSTEM_PROMPT } from "./prompts/system.ts";

export async function runAgent(userPrompt: string, openai: OpenAI = new OpenAI()) {
  const tools = await getTools();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await openai.chat.completions.create({
      model: AGENT_MODEL,
      messages,
      tools,
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (choice.finish_reason === "stop" || !assistantMessage.tool_calls?.length) {
      console.log("\n" + (assistantMessage.content ?? "(no response)"));
      return;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      const { name, arguments: argsJson } = toolCall.function;
      console.log(`→ ${name}(${argsJson})`);

      const result = await dispatch(name, argsJson);
      console.log(`  ✓ done`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
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
