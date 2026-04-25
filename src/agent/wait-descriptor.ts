/**
 * Describes what a run is waiting on when it enters the non-terminal
 * `waiting` state. Serialized as JSON into the `runs.waiting_on` column.
 */
export type WaitDescriptor =
  | {
      kind: "user_approval";
      confirmationId: string;
      prompt: string;
    }
  /**
   * Reserved placeholder for async child-run delegation. Not triggered
   * by any code path in this spec — the descriptor exists so resume
   * logic and persistence formats are future-proof.
   */
  | {
      kind: "child_run";
      childRunId: string;
    };

export type Wait = WaitDescriptor;
export type WaitKind = WaitDescriptor["kind"];

/**
 * Resolution payload passed to `resumeRun`. The `kind` must match the
 * pending `WaitDescriptor.kind` for the run or the resume is rejected.
 */
export type WaitResolution =ķ
  | {
      kind: "user_approval";
      confirmationId: string;
      decisions: Record<string, "approve" | "deny">;
    }
  | {
      kind: "child_run";
      childRunId: string;
      result: string;
    };

/**
 * Error thrown from tool-dispatch paths (currently confirmation.ts) to
 * signal that the current run must pause. Caught at the orchestrator
 * boundary and converted into `{ kind: 'waiting', waitingOn }`.
 */
export class WaitRequested extends Error {
  readonly waitingOn: WaitDescriptor;

  constructor(waitingOn: WaitDescriptor) {
    super(`Run paused: waiting on ${waitingOn.kind}`);
    this.name = "WaitRequested";
    this.waitingOn = waitingOn;
  }
}
