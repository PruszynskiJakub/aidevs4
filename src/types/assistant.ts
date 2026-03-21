import type { ToolFilter } from "./tool.ts";

export interface AssistantConfig {
  name: string;
  objective: string;
  tone: string;
  model?: string;
  tools?: ToolFilter;
}
