// Semantic event types for agent UI streaming

export interface PlanStep {
  index: number;
  status: "done" | "current" | "pending";
  text: string;
}

// Base fields shared by all events
interface BaseEvent {
  id: string;
  timestamp: number;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  sessionId: string;
  prompt: string;
}

export interface PlanStartEvent extends BaseEvent {
  type: "plan_start";
  iteration: number;
  model: string;
}

export interface PlanUpdateEvent extends BaseEvent {
  type: "plan_update";
  iteration: number;
  steps: PlanStep[];
  durationMs: number;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  iteration: number;
  toolName: string;
  arguments: string;
  batchIndex: number;
  batchSize: number;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  iteration: number;
  toolName: string;
  status: "ok" | "error";
  data: string;
  hints?: string[];
  durationMs: number;
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking";
  iteration: number;
  content: string;
}

export interface MessageEvent extends BaseEvent {
  type: "message";
  content: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
}

export interface TokenUsageEvent extends BaseEvent {
  type: "token_usage";
  iteration: number;
  phase: "plan" | "act";
  model: string;
  tokens: { prompt: number; completion: number };
  cumulative: { prompt: number; completion: number };
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  sessionId: string;
  totalDurationMs: number;
  totalTokens: { prompt: number; completion: number };
}

export interface ApprovalRequestEvent extends BaseEvent {
  type: "approval_request";
  iteration: number;
  requestId: string;
  toolCalls: { toolName: string; arguments: string }[];
}

export interface ApprovalResponseEvent extends BaseEvent {
  type: "approval_response";
  requestId: string;
  approved: boolean;
  reason?: "user" | "timeout";
}

export type AgentEvent =
  | SessionStartEvent
  | PlanStartEvent
  | PlanUpdateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ThinkingEvent
  | MessageEvent
  | ErrorEvent
  | TokenUsageEvent
  | SessionEndEvent
  | ApprovalRequestEvent
  | ApprovalResponseEvent;

let counter = 0;

export function makeEventId(): string {
  return `evt_${Date.now()}_${++counter}`;
}

/**
 * Parse plan text (numbered steps with [x]/[>]/[ ] markers) into PlanStep[].
 */
export function parsePlanSteps(planText: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lines = planText.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\.\s*\[(x|>|\s)]\s*(.+)/);
    if (match) {
      const marker = match[2];
      const status: PlanStep["status"] =
        marker === "x" ? "done" : marker === ">" ? "current" : "pending";
      steps.push({ index: steps.length + 1, status, text: match[3].trim() });
    }
  }

  return steps;
}
