import type { LLMMessage } from "./types/llm.ts";
import { config } from "./config/index.ts";
import { runAgent } from "./agent.ts";
import { assistantResolverService } from "./services/agent/assistant/assistant-resolver.ts";

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

const resolved = await assistantResolverService.resolve(assistantName);
const agentModel = modelOverride ?? resolved.model;
const messages: LLMMessage[] = [
  { role: "system", content: resolved.prompt },
  { role: "user", content: prompt },
];

void runAgent(messages, undefined, {
  model: agentModel,
  sessionId,
  toolFilter: resolved.toolFilter,
  assistant: assistantName,
});
