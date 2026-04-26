export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "exhausted";
export type ItemType = "message" | "function_call" | "function_call_output";

export interface DbSession {
  id: string;
  rootRunId: string | null;
  assistant: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbRun {
  id: string;
  sessionId: string;
  parentId: string | null;
  rootRunId: string | null;
  sourceCallId: string | null;
  template: string;
  task: string;
  status: RunStatus;
  result: string | null;
  error: string | null;
  waitingOn: string | null;
  exitKind: string | null;
  turnCount: number;
  version: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DbItem {
  id: string;
  runId: string;
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

export interface CreateRunOpts {
  id: string;
  sessionId: string;
  parentId?: string;
  rootRunId?: string;
  sourceCallId?: string;
  template: string;
  task: string;
}

export interface DbJob {
  id: string;
  name: string;
  message: string;
  agent: string | null;
  schedule: string | null;
  runAt: string | null;
  status: "active" | "paused" | "completed";
  runCount: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobOpts {
  id: string;
  name: string;
  message: string;
  agent?: string;
  schedule?: string;
  runAt?: string;
}

export interface NewItem {
  id: string;
  runId: string;
  sequence: number;
  type: ItemType;
  role?: string;
  content?: string;
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
}
