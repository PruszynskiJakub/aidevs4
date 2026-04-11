import type { LLMMessage, LLMTool } from "./llm.ts";
import type { MemoryState } from "./memory.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface RunState {
  sessionId: string;
  agentName?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
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
