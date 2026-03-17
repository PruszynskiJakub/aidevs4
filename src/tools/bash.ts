import { join, resolve } from "path";
import { $ } from "bun";
import { config } from "../config/index.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResponse } from "../types/tool.ts";
import { toolOk } from "../utils/tool-response.ts";
import { getSessionId } from "../services/agent/session-context.ts";

const MAX_OUTPUT = 20_000;

function getBashCwd(): string {
  const sessionId = getSessionId();
  if (sessionId) return resolve(join(config.paths.outputDir, sessionId));
  return resolve(config.paths.outputDir);
}

async function bash(args: { command: string }): Promise<string | ToolResponse> {
  const cwd = getBashCwd();
  const result = await $`bash -c ${args.command}`.cwd(cwd).quiet().nothrow();

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  let output = [stdout, stderr].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    output = `[exit code ${result.exitCode}]\n${output}`;
  }

  if (!output) return "(no output)";

  if (output.length > MAX_OUTPUT) {
    return toolOk(
      output.slice(0, MAX_OUTPUT) + "\n...(truncated)",
      ["Output truncated to 20 KB. Full output not available."],
    );
  }

  return output;
}

export default {
  name: "bash",
  handler: bash,
} satisfies ToolDefinition;