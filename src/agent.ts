import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AGENT_MODEL, MAX_ITERATIONS } from "./config.ts";
import { getTools, dispatch } from "./tools/dispatcher.ts";

const SYSTEM_PROMPT = `You are a data-processing agent with access to the following tools:

- **download_file** — Download files from hub.ag3nts.org. Always use the URL format: https://hub.ag3nts.org/data/APIKEY/filename.ext
- **read_csv_structure** — Inspect a CSV file or directory to see column names and row counts.
- **search_csv** — Filter CSV rows using column filters (eq, neq, contains, startsWith, endsWith, gt, lt, gte, lte). Multiple filters use AND logic.
- **transform_csv** — Transform values in a CSV column using an LLM (e.g., translate, categorize, extract).

## Workflow guidelines
1. When asked to work with a hub file, first download it, then inspect its structure.
2. Use search_csv to filter data based on user criteria.
3. Use transform_csv when values need to be derived, translated, or categorized by an LLM.
4. After each tool call, summarize what you found before deciding the next step.
5. When done, provide a clear final answer to the user.`;

const openai = new OpenAI();

async function run(userPrompt: string) {
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

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: bun run src/agent.ts \"your prompt here\"");
  process.exit(1);
}

run(prompt);
