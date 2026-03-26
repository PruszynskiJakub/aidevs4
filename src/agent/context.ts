import { AsyncLocalStorage } from "async_hooks";
import type { AgentState } from "../types/agent-state.ts";
import type { Logger } from "../types/logger.ts"; // used by RunContext

interface RunContext {
  state: AgentState;
  log: Logger;
}

const asyncLocalStorage = new AsyncLocalStorage<RunContext>();

// ── Primary API ───────────────────────────────────────────────

export function runWithContext<T>(
  state: AgentState,
  log: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  return asyncLocalStorage.run({ state, log }, fn);
}

export function getState(): AgentState | undefined {
  return asyncLocalStorage.getStore()?.state;
}

export function requireState(): AgentState {
  const state = getState();
  if (!state) throw new Error("No active agent state context");
  return state;
}

export function getLogger(): Logger | undefined {
  return asyncLocalStorage.getStore()?.log;
}

export function requireLogger(): Logger {
  const log = getLogger();
  if (!log) throw new Error("No active logger context");
  return log;
}

// ── Convenience sessionId accessors ───────────────────────────

export function getSessionId(): string | undefined {
  return asyncLocalStorage.getStore()?.state.sessionId;
}

export function requireSessionId(): string {
  const id = getSessionId();
  if (!id) throw new Error("No active session context");
  return id;
}

// ── Agent name accessor ──────────────────────────────────────

export function getAgentName(): string {
  return asyncLocalStorage.getStore()?.state.agentName ?? "default";
}
