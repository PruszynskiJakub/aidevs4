import { resolve } from "path";
import { $ } from "bun";
import { OUTPUT_DIR } from "../config.ts";
import type { ToolDefinition } from "../types/tool.ts";

const MAX_OUTPUT = 20_000;
const cwd = resolve(OUTPUT_DIR);

async function bash(args: { command: string }): Promise<string> {
  const result = await $`bash -c ${args.command}`.cwd(cwd).quiet().nothrow();

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  let output = [stdout, stderr].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    output = `[exit code ${result.exitCode}]\n${output}`;
  }

  if (!output) return "(no output)";

  if (output.length > MAX_OUTPUT) {
    return output.slice(0, MAX_OUTPUT) + "\n...(truncated)";
  }

  return output;
}

export default {
  name: "bash",
  handler: bash,
} satisfies ToolDefinition;