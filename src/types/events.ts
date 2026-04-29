import type { Wait, WaitResolution } from "./wait.ts";

// ── Shared payload types ───────────────────────────────────

export type RunId = string;
export type SessionId = string;

export type TokenPair = { promptTokens: number; completionTokens: number };

/** LLM call metadata captured from memory observer/reflector calls. */
export type MemoryGeneration = {
  name: string;
  model: string;
  input: unknown[];
  output: { content: string | null };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
};

/** Envelope fields injected by the bus from AsyncLocalStorage. */
type RunScoped = {
  id: string;
  ts: number;
  sessionId?: SessionId;
  correlationId?: string;
  runId: RunId;
  rootRunId?: RunId;
  parentRunId?: RunId;
  traceId?: string;
  depth?: number;
};

/** Subset for events fired before a run exists. */
type Unscoped = Omit<RunScoped, "runId"> & { runId?: RunId };

// ── Flat discriminated union ───────────────────────────────

export type AgentEvent =
  // ── Run lifecycle ─────────────────────────────────────────
  | (RunScoped & { type: "run.started"; assistant: string; model: string; userInput?: string })
  | (RunScoped & { type: "run.completed"; reason: "answer" | "max_iterations"; iterations: number; tokens: TokenPair })
  | (RunScoped & { type: "run.failed"; iterations: number; tokens: TokenPair; error: string })
  | (RunScoped & { type: "run.waiting"; waitingOn: Wait })
  | (RunScoped & { type: "run.resumed"; resolution: WaitResolution })
  | (RunScoped & { type: "run.delegated"; childRunId: RunId; childAgent: string; task: string })
  | (RunScoped & { type: "run.child_terminal"; childRunId: RunId; childStatus: string })

  // ── Turn ──────────────────────────────────────────────────
  | (RunScoped & { type: "turn.started"; index: number; maxTurns: number; model: string; messageCount: number })
  | (RunScoped & { type: "turn.completed"; index: number; outcome: "continue" | "answer" | "max_iterations"; durationMs: number; tokens: TokenPair })

  // ── Generation ────────────────────────────────────────────
  | (RunScoped & { type: "generation.started"; name: string; model: string; startTime: number })
  | (RunScoped & {
      type: "generation.completed";
      name: string; model: string;
      input: unknown[];
      output: { content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };
      usage: { input: number; output: number; total: number };
      durationMs: number; startTime: number;
    })
  | (Unscoped & { type: "llm.call.failed"; model: string; error: string; fatal: boolean; code?: string })

  // ── Tool execution ────────────────────────────────────────
  | (RunScoped & { type: "tool.called"; toolCallId: string; name: string; args: string; batchIndex: number; batchSize: number; startTime: number })
  | (RunScoped & { type: "tool.succeeded"; toolCallId: string; name: string; durationMs: number; result: string; args?: string; startTime?: number })
  | (RunScoped & { type: "tool.failed"; toolCallId: string; name: string; durationMs: number; error: string; args?: string; startTime?: number })
  | (RunScoped & { type: "batch.started"; batchId: string; toolCallIds: string[]; count: number })
  | (RunScoped & { type: "batch.completed"; batchId: string; count: number; durationMs: number; succeeded: number; failed: number })

  // ── Memory ────────────────────────────────────────────────
  | (RunScoped & { type: "memory.observation.started"; tokensBefore: number })
  | (RunScoped & { type: "memory.observation.completed"; tokensBefore: number; tokensAfter: number; generation: MemoryGeneration })
  | (RunScoped & { type: "memory.observation.failed"; error: string })
  | (RunScoped & { type: "memory.reflection.started"; level: number; tokensBefore: number })
  | (RunScoped & { type: "memory.reflection.completed"; level: number; tokensBefore: number; tokensAfter: number; generations: MemoryGeneration[] })
  | (RunScoped & { type: "memory.reflection.failed"; level: number; error: string })

  // ── Agent ─────────────────────────────────────────────────
  | (RunScoped & { type: "agent.started"; agentName: string; model: string; task: string; depth: number })
  | (RunScoped & { type: "agent.completed"; agentName: string; durationMs: number; iterations: number; tokens: TokenPair; result: string | null })
  | (RunScoped & { type: "agent.failed"; agentName: string; durationMs: number; iterations: number; error: string })
  | (RunScoped & { type: "agent.answered"; text: string | null })

  // ── Moderation ────────────────────────────────────────────
  | (Unscoped & { type: "input.flagged"; categories: string[]; categoryScores: Record<string, number> })
  | (Unscoped & { type: "input.clean"; durationMs: number });

// ── Derived helpers ────────────────────────────────────────

export type EventType = AgentEvent["type"];
export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;

/** Payload portion an emitter supplies — bus injects everything in RunScoped/Unscoped. */
export type EventInput<T extends EventType> = Omit<EventOf<T>, keyof RunScoped | "type">;

export type Listener<T extends EventType> = (event: EventOf<T>) => void;
export type WildcardListener = (event: AgentEvent) => void;

export interface EventBus {
  emit<T extends EventType>(type: T, data: EventInput<T>): void;
  on<T extends EventType>(type: T, listener: Listener<T>): () => void;
  onAny(listener: WildcardListener): () => void;
  off<T extends EventType>(type: T, listener: Listener<T>): void;
  offAny(listener: WildcardListener): void;
  clear(): void;
}

import { DomainError } from "./errors.ts";

export const assertNever = (x: never): never => {
  throw new DomainError({
    type: "validation",
    message: "Unhandled event variant",
    internalMessage: `Unhandled event variant: ${JSON.stringify(x)}`,
  });
};
