import type { ToolDefinition } from "../types/tool.ts";
import { llm } from "../services/llm.ts";
import { promptService } from "../services/prompt.ts";

async function think(args: { question: string; context: string }): Promise<string> {
  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? "gpt-4.1",
    systemPrompt: prompt.content,
    userPrompt: `## Question\n${args.question}\n\n## Context\n${args.context}`,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });

  return result;
}

export default {
  name: "think",
  handler: think,
} satisfies ToolDefinition;
