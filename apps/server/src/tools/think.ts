import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { llm } from "../llm/llm.ts";
import { promptService } from "../llm/prompt.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";

async function think(args: Record<string, unknown>): Promise<ToolResult> {
  const { thought } = args as { thought: string };
  assertMaxLength(thought, "question", 5_000);

  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? config.models.agent,
    systemPrompt: prompt.content,
    userPrompt: `## Thought \n${thought}\n\n`,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });

  return text(result);
}

export default {
  name: "think",
  schema: {
    name: "think",
    description: "Pause and reason step-by-step before acting. Use when you need to plan a multi-step approach, weigh alternatives, or synthesize information from previous tool results. Returns the reasoning as text. No side effects — does not fetch data or modify files.",
    schema: z.object({
      thought: z.string().describe("The problem or question to reason through. Include relevant facts from prior tool results."),
    }),
  },
  handler: think,
} satisfies ToolDefinition;
