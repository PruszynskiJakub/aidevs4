import type { LLMTool } from "./llm.ts";

export interface AgentConfig {
  name: string;
  model: string;
  prompt: string;
  tools?: string[];
  capabilities?: string[];
  memory?: boolean;
}

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
