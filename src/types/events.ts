// ── Event payload types ─────────────────────────────────────

export type TokenPair = { promptTokens: number; completionTokens: number };

/**
 * Typed event registry. Each key is a domain state transition;
 * the value is the structured payload for that transition.
 *
 * Extend this interface when new features land — consumers that
 * don't recognise an event type simply ignore it.
 */
export interface EventMap {
  // ── Session ──────────────────────────────────────────────
  "session.opened": { assistant: string; model: string; userInput?: string };
  "session.completed": {
    reason: "answer" | "max_iterations";
    iterations: number;
    tokens: { plan: TokenPair; act: TokenPair };
  };
  "session.failed": {
    iterations: number;
    tokens: { plan: TokenPair; act: TokenPair };
    error: string;
  };

  // ── Turn ─────────────────────────────────────────────────
  "turn.started": {
    iteration: number;
    maxIterations: number;
    model: string;
    messageCount: number;
  };
  "turn.completed": {
    iteration: number;
    outcome: "continue" | "answer" | "max_iterations";
    durationMs: number;
    tokens: { plan: TokenPair; act: TokenPair };
  };

  // ── LLM Generation ─────────────────────────────────────
  "generation.started": {
    name: string;
    model: string;
    startTime: number;
  };
  "generation.completed": {
    name: string;
    model: string;
    input: unknown[];
    output: {
      content: string | null;
      toolCalls?: { id: string; name: string; arguments: string }[];
    };
    usage: { input: number; output: number; total: number };
    durationMs: number;
    startTime: number;
  };

  // ── Tool execution ───────────────────────────────────────
  "tool.called": { callId: string; name: string; args: string; batchIndex: number; batchSize: number; startTime: number };
  "tool.succeeded": { callId: string; name: string; durationMs: number; result: string; args?: string; startTime?: number };
  "tool.failed": { callId: string; name: string; durationMs: number; error: string; args?: string; startTime?: number };
  "batch.started": {
    batchId: string;
    callIds: string[];
    count: number;
  };
  "batch.completed": {
    batchId: string;
    count: number;
    durationMs: number;
    succeeded: number;
    failed: number;
  };

  // ── Memory ───────────────────────────────────────────────
  "memory.observation": {
    tokensBefore: number;
    tokensAfter: number;
  };
  "memory.reflection": {
    level: number;
    tokensBefore: number;
    tokensAfter: number;
  };

  // ── Agent lifecycle ────────────────────────────────────────
  "agent.started": {
    agentName: string;
    model: string;
    task: string;
    parentAgentId?: string;
    depth: number;
  };
  "agent.completed": {
    agentName: string;
    durationMs: number;
    iterations: number;
    tokens: { plan: TokenPair; act: TokenPair };
    result: string | null;
  };
  "agent.failed": {
    agentName: string;
    durationMs: number;
    iterations: number;
    error: string;
  };
  "agent.answered": { text: string | null };

  // ── Moderation ───────────────────────────────────────────
  "input.flagged": { categories: string[] };
  "input.clean": {};
}

// ── Envelope ────────────────────────────────────────────────

export interface BusEvent<T = unknown> {
  id: string;
  type: string;
  ts: number;
  sessionId?: string;
  correlationId?: string;
  agentId?: string;
  rootAgentId?: string;
  parentAgentId?: string;
  traceId?: string;
  depth?: number;
  data: T;
}

// ── Bus interface ───────────────────────────────────────────

export type EventType = keyof EventMap;
export type Listener<K extends EventType> = (event: BusEvent<EventMap[K]>) => void;
export type WildcardListener = (event: BusEvent) => void;

export interface EventBus {
  emit<K extends EventType>(type: K, data: EventMap[K]): void;
  on<K extends EventType>(type: K, listener: Listener<K>): () => void;
  onAny(listener: WildcardListener): () => void;
  off<K extends EventType>(type: K, listener: Listener<K>): void;
  offAny(listener: WildcardListener): void;
  clear(): void;
}