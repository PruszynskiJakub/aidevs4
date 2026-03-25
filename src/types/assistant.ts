import type { ToolFilter } from "./tool.ts";

export interface AgentConfig {
  name: string;
  model: string;
  prompt: string;
  tools?: ToolFilter;
  capabilities?: string[];
}

/** @deprecated Use AgentConfig instead */
export type AssistantConfig = AgentConfig;
