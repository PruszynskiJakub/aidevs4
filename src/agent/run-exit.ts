import type { WaitDescriptor } from "./wait-descriptor.ts";

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
  | { kind: "exhausted"; turnCount: number };

export type RunExitKind = RunExit["kind"];

/** True for every `RunExit` that puts the run row into a terminal status. */
export function isTerminal(exit: RunExit): boolean {
  return exit.kind !== "waiting";
}
