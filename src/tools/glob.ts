import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { sandbox as files } from "../infra/sandbox.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";
import { DomainError } from "../types/errors.ts";

const MAX_RESULTS = 500;

async function glob(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);

  const pattern = args.pattern as string;
  if (!pattern || typeof pattern !== "string") {
    throw new DomainError({ type: "validation", message: "pattern is required and must be a non-empty string" });
  }
  assertMaxLength(pattern, "pattern", 512);

  const path = args.path as string;
  if (!path || typeof path !== "string") {
    throw new DomainError({ type: "validation", message: "path is required and must be a non-empty string" });
  }
  assertMaxLength(path, "path", 1024);

  // Verify directory exists (also triggers sandbox check via file service)
  const st = await files.stat(path);
  if (!st.isDirectory) {
    throw new DomainError({ type: "validation", message: `"${path}" is not a directory` });
  }

  const globber = new Bun.Glob(pattern);
  const results: string[] = [];
  let truncated = false;

  for await (const entry of globber.scan({ cwd: path, absolute: true })) {
    if (results.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    results.push(entry);
  }

  results.sort();

  let output: string;
  if (results.length === 0) {
    output = `No files matched pattern "${pattern}" in ${path}.`;
  } else {
    output = results.join("\n");
    output += `\n\nTotal: ${results.length} file(s)`;
    if (truncated) {
      output += ` (truncated at ${MAX_RESULTS} — narrow the pattern for complete results)`;
    }
  }

  const hint = "\nNote: Read any matched file for full contents, or narrow the pattern to reduce results.";

  return text(output + hint);
}

export default {
  name: "glob",
  schema: {
    name: "glob",
    description: "Find files matching a glob pattern. Returns sorted file paths, capped at 500 results. Use for discovering files by extension, name pattern, or directory structure.",
    schema: z.object({
      pattern: z.string().describe('Glob pattern to match (e.g. "**/*.ts", "src/*.json").'),
      path: z.string().describe("Base directory to search in. Must be an absolute path within allowed read directories."),
    }),
  },
  handler: glob,
} satisfies ToolDefinition;
