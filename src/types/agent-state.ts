import type { LLMMessage } from "./llm.ts";
import type { ToolFilter } from "./tool.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentState {
  sessionId: string;
  messages: LLMMessage[];
  tokens: { plan: TokenUsage; act: TokenUsage };
  iteration: number;
  assistant: string;
  model: string;
  toolFilter?: ToolFilter;
}