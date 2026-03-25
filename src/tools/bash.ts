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
  if (sessionId) return resolve(join(config.paths.outputDir, sessionId));
  return resolve(config.paths.outputDir);
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
          `Redirect output to a path within the session directory.`,
      );
    }
  }
}

async function bash(args: Record<string, unknown>): Promise<Document> {
  const { command } = args as { command: string };
  const cwd = getBashCwd();
  assertWritesInSessionDir(command, cwd);
  const result = await $`bash -c ${command}`.cwd(cwd).quiet().nothrow();

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
