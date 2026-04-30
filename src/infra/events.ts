import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  EventType,
  EventInput,
  EventEnvelope,
  Listener,
  WildcardListener,
  EventBus,
} from "../types/events.ts";
import { getSessionId, getRunId, getRootRunId, getParentRunId, getTraceId, getDepth } from "../agent/context.ts";

// ── Bus implementation ──────────────────────────────────────

function createEventBus(): EventBus {
  const exact = new Map<EventType, Set<Listener<any>>>();
  const wildcards = new Set<WildcardListener>();

  function emit<T extends EventType>(
    type: T,
    data: EventInput<T>,
    envelope?: EventEnvelope,
  ): void {
    // Prefer explicit envelope; fall back to ALS for legacy callers.
    // The ALS fallback will be removed once every caller passes ctx.
    const event = {
      id: randomUUID(),
      type,
      ts: Date.now(),
      sessionId: envelope?.sessionId ?? getSessionId(),
      runId: envelope?.runId ?? getRunId(),
      rootRunId: envelope?.rootRunId ?? getRootRunId(),
      parentRunId: envelope?.parentRunId ?? getParentRunId(),
      traceId: envelope?.traceId ?? getTraceId(),
      depth: envelope?.depth ?? getDepth(),
      ...data,
    } as AgentEvent;

    const listeners = exact.get(type);
    if (listeners) {
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          console.error(`[event-bus] listener error on "${type}":`, err);
        }
      }
    }

    for (const fn of wildcards) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[event-bus] wildcard listener error on "${type}":`, err);
      }
    }
  }

  function on<T extends EventType>(type: T, listener: Listener<T>): () => void {
    let set = exact.get(type);
    if (!set) {
      set = new Set();
      exact.set(type, set);
    }
    set.add(listener as Listener<any>);
    return () => off(type, listener);
  }

  function off<T extends EventType>(type: T, listener: Listener<T>): void {
    exact.get(type)?.delete(listener as Listener<any>);
  }

  function onAny(listener: WildcardListener): () => void {
    wildcards.add(listener);
    return () => offAny(listener);
  }

  function offAny(listener: WildcardListener): void {
    wildcards.delete(listener);
  }

  function clear(): void {
    exact.clear();
    wildcards.clear();
  }

  return { emit, on, onAny, off, offAny, clear };
}

/** Process-wide singleton event bus. */
export const bus: EventBus = createEventBus();

/** Exported for testing — create an isolated bus instance. */
export { createEventBus };
