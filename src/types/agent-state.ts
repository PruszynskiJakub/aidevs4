import type { LLMMessage, LLMTool } from "./llm.ts";
import type { MemoryState } from "./memory.ts";

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
  tools: LLMTool[];
  memory: MemoryState;
}