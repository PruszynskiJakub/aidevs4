export interface ToolFilter {
  include?: string[];
  exclude?: string[];
}

export interface AssistantConfig {
  name: string;
  objective: string;
  tone: string;
  model?: string;
  tools?: ToolFilter;
}
