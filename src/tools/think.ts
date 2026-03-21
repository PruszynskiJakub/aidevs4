import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { llm } from "../services/ai/llm.ts";
import { promptService } from "../services/ai/prompt.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createDocument } from "../services/common/document-store.ts";
import { getSessionId } from "../utils/session-context.ts";

async function think(args: Record<string, unknown>): Promise<Document> {
  const { thought } = args as { thought: string };
  assertMaxLength(thought, "question", 5_000);

  const prompt = await promptService.load("think");

  const result = await llm.completion({
    model: prompt.model ?? "gpt-4.1",
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
