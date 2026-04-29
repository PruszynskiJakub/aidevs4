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

