import { config } from "./config/index.ts";
import { executeRun } from "./agent/orchestrator.ts";
import { resumeRun } from "./agent/resume-run.ts";
import { initServices, shutdownServices, installSignalHandlers } from "./infra/bootstrap.ts";
import { takePendingConfirmation } from "./agent/confirmation.ts";
import type { RunExit } from "./agent/run-exit.ts";
import type { WaitDescriptor } from "./agent/wait-descriptor.ts";
import type { Decision } from "./types/tool.ts";
import * as readline from "node:readline/promises";

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

async function promptApproval(waitingOn: WaitDescriptor): Promise<Record<string, "approve" | "deny">> {
  if (waitingOn.kind !== "user_approval") {
    throw new Error(`CLI cannot resolve wait kind: ${waitingOn.kind}`);
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

try {
  let result = await executeRun({
    sessionId,
    prompt,
    assistant: assistantName,
    model: modelOverride,
  });

  while (result.exit.kind === "waiting") {
    const decisions = await promptApproval(result.exit.waitingOn);
    result = await resumeRun(result.runId, {
      kind: "user_approval",
      confirmationId:
        result.exit.waitingOn.kind === "user_approval"
          ? result.exit.waitingOn.confirmationId
          : "",
      decisions,
    });
  }

  console.log(`\nSession: ${result.sessionId}`);
  printExit(result.exit);
} finally {
  await shutdownServices();
}
