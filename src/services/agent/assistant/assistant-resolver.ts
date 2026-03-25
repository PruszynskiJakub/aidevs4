import { assistantsService } from "./assistants.ts";
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

      const agent = await assistantsService.get(name);

      const resolved: ResolvedAssistant = {
        prompt: agent.prompt,
        model: agent.model,
        toolFilter: agent.tools,
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
