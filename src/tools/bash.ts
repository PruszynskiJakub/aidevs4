import { join, resolve } from "path";
import { $ } from "bun";
import { config } from "../config/index.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
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

async function bash(args: Record<string, unknown>): Promise<Document> {
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

  const snippet = command.slice(0, 80);
  return createDocument(output, `Bash output for: ${snippet}`, {
    source: null,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "bash",
  handler: bash,
} satisfies ToolDefinition;
