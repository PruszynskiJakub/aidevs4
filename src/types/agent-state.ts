import type { LLMMessage } from "./llm.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentState {
  sessionId: string;
  messages: LLMMessage[];
  tokens: { plan: TokenUsage; act: TokenUsage };
  iteration: number;
}