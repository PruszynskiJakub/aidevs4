import { join, resolve } from "path";
import { $ } from "bun";
import { z } from "zod";
import { config } from "../config/index.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { getSessionId } from "../agent/context.ts";

const MAX_OUTPUT = 20_000;

function getBashCwd(): string {
  const sessionId = getSessionId();
  if (sessionId) {
    const dateFolder = new Date().toISOString().slice(0, 10);
    return resolve(join(config.paths.sessionsDir, dateFolder, sessionId));
  }
  return resolve(config.paths.sessionsDir);
}

/**
 * Extract paths that appear as write targets (after >, >>, tee, etc.)
 * and verify they resolve within the session output directory.
 */
function assertWritesInSessionDir(command: string, cwd: string): void {
  // Match redirect targets: > file, >> file, tee file
  const redirectTargets = [
    ...command.matchAll(/>{1,2}\s*([^\s;&|]+)/g),
    ...command.matchAll(/\btee\s+(?:-[a-z]\s+)*([^\s;&|]+)/g),
  ].map((m) => m[1]);

  for (const target of redirectTargets) {
    if (target.startsWith("/dev/")) continue; // /dev/null etc.
    const resolved = resolve(cwd, target);
    if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
      throw new Error(
        `Write target "${target}" resolves to "${resolved}" which is outside the session output directory "${cwd}". ` +
          `Redirect output to a relative path within CWD (e.g., ./tmp.txt), not /tmp or absolute paths.`,
      );
    }
  }
}

async function bash(args: Record<string, unknown>): Promise<ToolResult> {
  const { command } = args as { command: string };

  // Clamp timeout to [1000, 120000], default 30000
  const rawTimeout = typeof args.timeout === "number" ? args.timeout : 30_000;
  const timeout = Math.max(1000, Math.min(120_000, Math.round(rawTimeout)));

  const cwd = getBashCwd();
  assertWritesInSessionDir(command, cwd);

  const shellPromise = $`bash -c ${command}`.cwd(cwd).quiet().nothrow();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout),
  );
  const result = await Promise.race([shellPromise, timeoutPromise]);

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  let output = [stdout, stderr].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    output = `[exit code ${result.exitCode}]\n${output}`;
  }

  if (!output) output = "(no output)";

  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT) + "\n...(truncated)";
  }

  return text(output);
}

export default {
  name: "bash",
  schema: {
    name: "bash",
    description: "Execute a shell command in the session output directory.\n\nUse for: shell operations like unzipping/archiving, downloading, data transformation (jq, awk, sort, cut), system inspection (wc, file, du), running scripts, and operations not covered by dedicated file tools. Always prefer bash over execute_code for file management, CLI commands, and shell operations.\n\nPrefer dedicated tools for file reading, writing, editing, searching, and pattern matching — this tool is for everything else.\n\nCWD is the session directory. All paths in commands should be relative to CWD — do NOT use absolute paths from tool results; strip any prefix up to and including the session ID. All write targets (>, >>, tee) MUST stay within CWD — writing to /tmp or any path outside the session directory will fail. For temporary files, use relative paths (e.g., ./tmp_work.txt).\n\nOutput truncated at 20 KB — for large outputs, redirect to a file and inspect afterward. Returns stdout/stderr with exit code.",
    schema: z.object({
      command: z.string().describe("Shell command to execute. Supports pipes and standard Unix tools."),
      description: z.string().describe("Brief human-readable description of what this command does. Logged for audit, not executed."),
      timeout: z.int().describe("Execution timeout in milliseconds. Clamped to [1000, 120000]. Defaults to 30000 (30s)."),
    }),
  },
  handler: bash,
} satisfies ToolDefinition;
