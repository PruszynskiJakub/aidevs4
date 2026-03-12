import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResponse } from "../types/tool.ts";
import { llm } from "../services/llm.ts";
import { promptService } from "../services/prompt.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { toolOk } from "../utils/tool-response.ts";

async function think(args: { thought: string }): Promise<ToolResponse> {
  assertMaxLength(args.thought, "question", 5_000);

  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? "gpt-4.1",
    systemPrompt: prompt.content,
    userPrompt: `## Thought \n${args.thought}\n\n`,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });

  return toolOk({ reasoning: result });
}

export default {
  name: "think",
  handler: think,
} satisfies ToolDefinition;
