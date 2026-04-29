import { config } from "./config/index.ts";
import { executeRun } from "./agent/orchestrator.ts";
import { resumeRun } from "./agent/resume-run.ts";
import { initServices, shutdownServices, installSignalHandlers } from "./infra/bootstrap.ts";
import { takePendingConfirmation } from "./agent/confirmation.ts";
import { createRuntime } from "./runtime.ts";
import * as dbOps from "./infra/db/index.ts";
import type { RunExit } from "./agent/run-exit.ts";
import type { WaitDescriptor } from "./types/wait.ts";
import type { ExecuteRunResult } from "./agent/orchestrator.ts";
import type { Decision } from "./types/tool.ts";
import * as readline from "node:readline/promises";
import { DomainError } from "./types/errors.ts";

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  args.splice(idx, 2);
  return value;
}

const args = process.argv.slice(2);
const sessionId = extractFlag(args, "--session");
const modelOverride = extractFlag(args, "--model");

// Remaining args: [assistant] "prompt" or just "prompt"
let assistantName: string;
let prompt: string;

if (args.length >= 2) {
  assistantName = args[0];
  prompt = args[1];
} else if (args.length === 1) {
  assistantName = config.assistant ?? "default";
  prompt = args[0];
} else {
  console.error('Usage: bun run agent [assistant] "your prompt" [--session <id>] [--model <model>]');
  process.exit(1);
}

await initServices();
installSignalHandlers();

// Composition root — built once, threaded through every entry into the agent core.
const runtime = createRuntime();

async function promptApproval(waitingOn: WaitDescriptor): Promise<Record<string, "approve" | "deny">> {
  if (waitingOn.kind !== "user_approval") {
    throw new DomainError({ type: "validation", message: `CLI cannot resolve wait kind: ${waitingOn.kind}` });
  }
  const pending = takePendingConfirmation(waitingOn.confirmationId);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const decisions: Record<string, "approve" | "deny"> = {};

  try {
    console.log("\nTool confirmation required:");
    if (pending) {
      for (const req of pending.requests) {
        console.log(`  Tool: ${req.toolName}`);
        console.log(`  Args: ${JSON.stringify(req.args, null, 2)}`);
        const answer = await rl.question("  Approve? [Y/n] ");
        decisions[req.toolCallId] = answer.trim().toLowerCase() === "n" ? "deny" : "approve";
      }
    } else {
      console.log(`  ${waitingOn.prompt}`);
      console.log("  (pending confirmation detail unavailable in this process)");
    }
  } finally {
    rl.close();
  }
  return decisions;
}

function printExit(exit: RunExit): void {
  switch (exit.kind) {
    case "completed":
      if (exit.result) console.log(exit.result);
      break;
    case "failed":
      console.error(`Run failed: ${exit.error.message}`);
      break;
    case "cancelled":
      console.error(`Run cancelled: ${exit.reason}`);
      break;
    case "exhausted":
      console.error(`Run exhausted after ${exit.cycleCount} cycles`);
      break;
    case "waiting":
      // handled by loop below, should not be reached here
      break;
  }
}

/**
 * Wait for the continuation subscriber to resume a parent run that is
 * waiting on a child. Polls the DB until the parent leaves `waiting`.
 */
async function waitForChildResume(parentRunId: string): Promise<ExecuteRunResult> {
  // Poll until the parent is no longer waiting
  while (true) {
    await new Promise((r) => setTimeout(r, 200));
    const run = dbOps.getRun(parentRunId);
    if (!run) {
      return { exit: { kind: "failed", error: { message: "Run disappeared" } }, sessionId: "", runId: parentRunId };
    }
    if (run.status === "waiting") continue;

    // Parent has moved past waiting — return its final state
    let exit: RunExit;
    switch (run.status) {
      case "completed":
        exit = { kind: "completed", result: run.result ?? "" };
        break;
      case "failed":
        exit = { kind: "failed", error: { message: run.error ?? "unknown" } };
        break;
      case "cancelled":
        exit = { kind: "cancelled", reason: run.error ?? "unknown" };
        break;
      case "exhausted":
        exit = { kind: "exhausted", cycleCount: run.cycleCount };
        break;
      default:
        // Still running — keep polling
        continue;
    }
    return { exit, sessionId: run.sessionId, runId: parentRunId };
  }
}

import { isDomainError } from "./types/errors.ts";

try {
  let result = await executeRun({
    sessionId,
    prompt,
    assistant: assistantName,
    model: modelOverride,
  }, runtime);

  while (result.exit.kind === "waiting") {
    if (result.exit.waitingOn.kind === "child_run") {
      // Child run is executing asynchronously. Wait for the continuation
      // subscriber to resume the parent, then read the final result.
      result = await waitForChildResume(result.runId);
    } else {
      const decisions = await promptApproval(result.exit.waitingOn);
      result = await resumeRun(result.runId, {
        kind: "user_approval",
        confirmationId:
          result.exit.waitingOn.kind === "user_approval"
            ? result.exit.waitingOn.confirmationId
            : "",
        decisions,
      }, runtime);
    }
  }

  console.log(`\nSession: ${result.sessionId}`);
  printExit(result.exit);
} catch (err) {
  const userMessage = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${userMessage}`);
  if (!config.isProduction && isDomainError(err) && err.internalMessage) {
    console.error(`(internal: ${err.internalMessage})`);
  }
  process.exitCode = 1;
} finally {
  await shutdownServices();
}
