import { config } from "./config/index.ts";
import { executeTurn } from "./agent/orchestrator.ts";
import { initServices, shutdownServices } from "./infra/bootstrap.ts";
import { setConfirmationProvider } from "./agent/confirmation.ts";
import type { ConfirmationRequest } from "./agent/confirmation.ts";
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

setConfirmationProvider({
  async confirm(requests: ConfirmationRequest[]) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const results = new Map<string, Decision>();
    try {
      console.log("\nTool confirmation required:");
      for (const req of requests) {
        console.log(`  Tool: ${req.toolName}`);
        console.log(`  Args: ${JSON.stringify(req.args, null, 2)}`);
        const answer = await rl.question("  Approve? [Y/n] ");
        results.set(req.toolCallId, answer.trim().toLowerCase() === "n" ? "deny" : "approve");
      }
    } finally {
      rl.close();
    }
    return results;
  },
});

const { answer, sessionId: resolvedSessionId } = await executeTurn({
  sessionId,
  prompt,
  assistant: assistantName,
  model: modelOverride,
});

console.log(`\nSession: ${resolvedSessionId}`);
if (answer) console.log(answer);

await shutdownServices();
