import type { WaitDescriptor } from "../types/wait.ts";

/**
 * The typed union of outcomes for a single `executeRun()` attempt.
 *
 * `waiting` is the only non-terminal variant: it signals that the run
 * has been persisted with `status='waiting'` and a `WaitDescriptor`,
 * and must be resumed via `resumeRun()` to reach a terminal state.
 */
export type RunExit =
  | { kind: "completed"; result: string }
  | { kind: "failed"; error: { message: string; cause?: unknown } }
  | { kind: "cancelled"; reason: string }
  | { kind: "waiting"; waitingOn: WaitDescriptor }
  | { kind: "exhausted"; cycleCount: number };

export function foldExit<T>(exit: RunExit, handlers: {
  completed: (result: string) => T;
  failed: (message: string, cause?: unknown) => T;
  cancelled: (reason: string) => T;
  waiting: (waitingOn: WaitDescriptor) => T;
  exhausted: (cycleCount: number) => T;
}): T {
  switch (exit.kind) {
    case "completed":  return handlers.completed(exit.result);
    case "failed":     return handlers.failed(exit.error.message, exit.error.cause);
    case "cancelled":  return handlers.cancelled(exit.reason);
    case "waiting":    return handlers.waiting(exit.waitingOn);
    case "exhausted":  return handlers.exhausted(exit.cycleCount);
  }
}

