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
  | {
      kind: "child_run";
      childRunId: string;
    };

export type Wait = WaitDescriptor;

/**
 * Resolution payload passed to `resumeRun`. The `kind` must match the
 * pending `WaitDescriptor.kind` for the run or the resume is rejected.
 */
export type WaitResolution =
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

