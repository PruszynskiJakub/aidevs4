import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { llm } from "../llm/llm.ts";
import { promptService } from "../llm/prompt.ts";
import { config } from "../config/index.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../infra/document.ts";
import { getSessionId } from "../agent/context.ts";

async function think(args: Record<string, unknown>): Promise<Document> {
  const { thought } = args as { thought: string };
  assertMaxLength(thought, "question", 5_000);

  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? config.models.agent,
    systemPrompt: prompt.content,
    userPrompt: `## Thought \n${thought}\n\n`,
    ...(prompt.temperature !== undefined && { temperature: prompt.temperature }),
  });

  const snippet = thought.slice(0, 80);
  return createDocument(result, `Reasoning about: ${snippet}`, {
    source: null,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "think",
  handler: think,
} satisfies ToolDefinition;
