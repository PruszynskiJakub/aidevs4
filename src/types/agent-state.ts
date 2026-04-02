import type { LLMMessage, LLMTool } from "./llm.ts";
import type { MemoryState } from "./memory.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentState {
  sessionId: string;
  agentName?: string;
  agentId?: string;
  rootAgentId?: string;
  parentAgentId?: string;
  traceId?: string;
  depth?: number;
  messages: LLMMessage[];
  tokens: TokenUsage;
  iteration: number;
  assistant: string;
  model: string;
  tools: LLMTool[];
  memory: MemoryState;
}