export interface AgentConfig {
  name: string;
  model: string;
  prompt: string;
  tools?: string[];
  capabilities?: string[];
}
