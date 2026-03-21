import { assistantsService } from "./assistants.ts";
import { promptService } from "../../ai/prompt.ts";
import type { ToolFilter } from "../../../types/tool.ts";

interface ResolvedAssistant {
  prompt: string;
  model: string;
  toolFilter?: ToolFilter;
}

export function createAssistantResolverService() {
  const promptCache = new Map<string, ResolvedAssistant>();

  return {
    async resolve(name: string): Promise<ResolvedAssistant> {
      const cached = promptCache.get(name);
      if (cached) return cached;

      const assistant = await assistantsService.get(name);
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
    },

    clearCache(): void {
      promptCache.clear();
    },
  };
}

export const assistantResolverService = createAssistantResolverService();
