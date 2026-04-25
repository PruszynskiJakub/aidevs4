import { bus } from "../infra/events.ts";
import { resumeRun } from "./resume-run.ts";
import * as dbOps from "../infra/db/index.ts";
import type { BusEvent } from "../types/events.ts";
import type { DbRun } from "../types/db.ts";
import type { WaitDescriptor } from "./wait-descriptor.ts";

/**
 * Register the global continuation subscriber. Called once at process
 * startup from bootstrap.ts. Listens for terminal run events and
 * resumes any parent that was waiting on the completed child.
 */
export function registerContinuationSubscriber(): void {
  bus.on("run.completed", handleChildTerminal);
  bus.on("run.failed", handleChildTerminal);
}

async function handleChildTerminal(
  event: BusEvent<{ [k: string]: unknown }>,
): Promise<void> {
  const childRunId = event.runId;
  if (!childRunId) return;

  const parent = dbOps.findRunWaitingOnChild(childRunId);
  if (!parent) return; // root run or parent not waiting

  const childRun = dbOps.getRun(childRunId);
  if (!childRun) return;

  const result = childExitToResult(childRun);

  bus.emit("run.child_terminal", {
    parentRunId: parent.id,
    childRunId,
    childStatus: childRun.status,
  });

  try {
    await resumeRun(parent.id, {
      kind: "child_run",
      childRunId,
      result,
    });
  } catch (err) {
    console.error(
      `[continuation] Failed to resume parent ${parent.id} after child ${childRunId}:`,
      err,
    );
  }
}

function childExitToResult(child: DbRun): string {
  switch (child.status) {
    case "completed":
      return child.result ?? "(no result)";
    case "failed":
      return `Delegated run failed: ${child.error ?? "unknown error"}`;
    case "cancelled":
      return `Delegated run was cancelled: ${child.error ?? "no reason"}`;
    case "exhausted":
      return `Delegated run hit cycle limit (${child.cycleCount} cycles)`;
    default:
      return `Delegated run ended with unexpected status: ${child.status}`;
  }
}

/**
 * Startup reconciliation: find parents waiting on children that are
 * already terminal, and resume them. Handles crash-gap scenarios where
 * the child completed but the subscriber didn't fire (or fired but
 * the resume failed).
 */
export async function reconcileOrphanedWaits(): Promise<void> {
  const orphaned = dbOps.findOrphanedWaitingRuns();
  for (const parent of orphaned) {
    const waitingOn = JSON.parse(parent.waitingOn!) as WaitDescriptor;
    if (waitingOn.kind !== "child_run") continue;

    const child = dbOps.getRun(waitingOn.childRunId);
    if (!child) continue;

    console.log(
      `[reconcile] Resuming orphaned parent ${parent.id} (child ${child.id} is ${child.status})`,
    );

    try {
      await resumeRun(parent.id, {
        kind: "child_run",
        childRunId: child.id,
        result: childExitToResult(child),
      });
    } catch (err) {
      console.error(`[reconcile] Failed to resume ${parent.id}:`, err);
    }
  }
}
