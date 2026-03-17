import { assistants } from "./assistants.ts";
import { promptService } from "../../ai/prompt.ts";
import type { ToolFilter } from "../../../types/assistant.ts";

interface ResolvedAssistant {
  prompt: string;
  model: string;
  toolFilter?: ToolFilter;
}

const promptCache = new Map<string, ResolvedAssistant>();

export async function resolveAssistant(name: string): Promise<ResolvedAssistant> {
  const cached = promptCache.get(name);
  if (cached) return cached;

  const assistant = await assistants.get(name);
  const actPrompt = await promptService.load("act", {
    objective: assistant.objective,
    tone: assistant.tone,
  });

  const resolved: ResolvedAssistant = {
    prompt: actPrompt.content,
    model: assistant.model ?? actPrompt.model!,
    toolFilter: assistant.tools,
  };

  promptCache.set(name, resolved);
  return resolved;
}

export function clearPromptCache(): void {
  promptCache.clear();
}
