import { AsyncLocalStorage } from "async_hooks";

interface SessionStore {
  sessionId: string;
}

const asyncLocalStorage = new AsyncLocalStorage<SessionStore>();

export function runWithSession<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return asyncLocalStorage.run({ sessionId }, fn);
}

export function getSessionId(): string | undefined {
  return asyncLocalStorage.getStore()?.sessionId;
}

export function requireSessionId(): string {
  const id = getSessionId();
  if (!id) throw new Error("No active session context");
  return id;
}
