import type { LLMMessage } from "./llm.ts";
import type { Document } from "./document.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentState {
  sessionId: string;
  messages: LLMMessage[];
  tokens: { plan: TokenUsage; act: TokenUsage };
  iteration: number;
  documents: Document[];
}