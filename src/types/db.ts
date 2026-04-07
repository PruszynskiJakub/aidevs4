export type AgentStatus = "pending" | "running" | "completed" | "failed";
export type ItemType = "message" | "function_call" | "function_call_output";

export interface DbSession {
  id: string;
  rootAgentId: string | null;
  assistant: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbAgent {
  id: string;
  sessionId: string;
  parentId: string | null;
  sourceCallId: string | null;
  template: string;
  task: string;
  status: AgentStatus;
  result: string | null;
  error: string | null;
  turnCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DbItem {
  id: string;
  agentId: string;
  sequence: number;
  type: ItemType;
  role: string | null;
  content: string | null;
  callId: string | null;
  name: string | null;
  arguments: string | null;
  output: string | null;
  createdAt: string;
}

export interface CreateAgentOpts {
  id: string;
  sessionId: string;
  parentId?: string;
  sourceCallId?: string;
  template: string;
  task: string;
}

export interface NewItem {
  id: string;
  agentId: string;
  sequence: number;
  type: ItemType;
  role?: string;
  content?: string;
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
}
