import { AsyncLocalStorage } from "async_hooks";
import type { RunState } from "../types/run-state.ts";
import type { Logger } from "../types/logger.ts"; // used by RunContext
import { DomainError } from "../types/errors.ts";

interface RunContext {
  state: RunState;
  log: Logger;
}

const asyncLocalStorage = new AsyncLocalStorage<RunContext>();

// ── Primary API ───────────────────────────────────────────────

export function runWithContext<T>(
  state: RunState,
  log: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  return asyncLocalStorage.run({ state, log }, fn);
}

export function getState(): RunState | undefined {
  return asyncLocalStorage.getStore()?.state;
}

export function requireState(): RunState {
  const state = getState();
  if (!state) throw new DomainError({ type: "validation", message: "No active run state context" });
  return state;
}

export function getLogger(): Logger | undefined {
  return asyncLocalStorage.getStore()?.log;
}

export function requireLogger(): Logger {
  const log = getLogger();
  if (!log) throw new DomainError({ type: "validation", message: "No active logger context" });
  return log;
}

// ── Convenience sessionId accessors ───────────────────────────

export function getSessionId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.sessionId;
}

export function requireSessionId(): string {
  const id = getSessionId();
  if (!id) throw new DomainError({ type: "validation", message: "No active session context" });
  return id;
}

// ── Agent name accessor ──────────────────────────────────────

export function getAgentName(): string {
  return asyncLocalStorage.getStore()?.state.agentName ?? "default";
}

// ── Tracing identity accessors ──────────────────────────────

export function getRunId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.runId;
}

export function getRootRunId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.rootRunId;
}

export function getParentRunId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.parentRunId;
}

export function getTraceId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.traceId;
}

export function getDepth(): number | undefined {
  return asyncLocalStorage.getStore()?.state.depth;
}
