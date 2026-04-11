import type { LLMTool } from "./llm.ts";

export interface ResolvedAgent {
  prompt: string;
  model: string;
  tools: LLMTool[];
  memory?: boolean;
}

export interface AgentSummary {
  name: string;
  description: string;
}
