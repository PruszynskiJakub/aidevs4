import type { LLMToolCall } from "./llm.ts";
import type { Decision } from "./tool.ts";

export interface ConfirmationRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ConfirmationProvider {
  confirm(requests: ConfirmationRequest[]): Promise<Map<string, Decision>>;
}

export interface GateResult {
  approved: LLMToolCall[];
  denied: Array<{ call: LLMToolCall; reason: string }>;
}
