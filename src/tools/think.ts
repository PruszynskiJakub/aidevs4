import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { llm } from "../services/ai/llm.ts";
import { promptService } from "../services/ai/prompt.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../utils/document.ts";

async function think(args: { thought: string }): Promise<Document> {
  assertMaxLength(args.thought, "question", 5_000);

  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? "gpt-4.1",
    systemPrompt: prompt.content,
    userPrompt: `## Thought \n${args.thought}\n\n`,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });

  const snippet = args.thought.slice(0, 80);
  return createDocument(result, `Reasoning about: ${snippet}`, {
    source: null,
    type: "document",
    mime_type: "text/plain",
  });
}

export default {
  name: "think",
  handler: think,
} satisfies ToolDefinition;
