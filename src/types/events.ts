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
  "session.opened": { assistant: string; model: string };
  "session.closed": {
    reason: "answer" | "max_iterations" | "error";
    iterations: number;
    tokens: { plan: TokenPair; act: TokenPair };
  };

  // ── Turn ─────────────────────────────────────────────────
  "turn.began": {
    iteration: number;
    maxIterations: number;
    model: string;
    messageCount: number;
  };
  "turn.acted": {
    toolCount: number;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
  };
  "turn.ended": {
    iteration: number;
    outcome: "continue" | "answer" | "max_iterations";
  };

  // ── Planning ─────────────────────────────────────────────
  "plan.produced": {
    model: string;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    summary: string;
    fullText: string;
  };

  // ── Tool execution ───────────────────────────────────────
  "tool.dispatched": { callId: string; name: string; args: string; batchIndex: number; batchSize: number };
  "tool.succeeded": { callId: string; name: string; durationMs: number; result: string };
  "tool.failed": { callId: string; name: string; durationMs: number; error: string };
  "batch.completed": {
    count: number;
    durationMs: number;
    succeeded: number;
    failed: number;
  };

  // ── Memory ───────────────────────────────────────────────
  "memory.compressed": {
    phase: "observation" | "reflection";
    level?: number;
    tokensBefore: number;
    tokensAfter: number;
  };

  // ── Agent answer ──────────────────────────────────────────
  "agent.answer": { text: string | null };

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