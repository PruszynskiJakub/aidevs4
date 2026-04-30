import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { sandbox as files } from "../infra/sandbox.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";
import { DomainError, isDomainError } from "../types/errors.ts";

const MAX_TOTAL_LINES = 200;
const MAX_FILES_WITH_MATCHES = 50;
const PER_FILE_CAP = 20;

async function grep(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  validateKeys(args);

  const pattern = args.pattern as string;
  if (!pattern || typeof pattern !== "string") {
    throw new DomainError({ type: "validation", message: "pattern is required and must be a non-empty string" });
  }
  assertMaxLength(pattern, "pattern", 512);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
  } catch (err) {
    throw new DomainError({ type: "validation", message: `Invalid regex: "${pattern}"`, cause: err });
  }

  const path = args.path as string;
  if (!path || typeof path !== "string") {
    throw new DomainError({ type: "validation", message: "path is required and must be a non-empty string" });
  }
  assertMaxLength(path, "path", 1024);

  const include = (typeof args.include === "string" && args.include) ? args.include : "*";
  assertMaxLength(include, "include", 256);

  // Verify directory exists (also triggers sandbox check)
  const st = await files.stat(path);
  if (!st.isDirectory) {
    throw new DomainError({ type: "validation", message: `"${path}" is not a directory` });
  }

  const globber = new Bun.Glob(include);
  const matches: string[] = [];
  let filesWithMatches = 0;
  let totalLines = 0;
  let truncated = false;

  for await (const entry of globber.scan({ cwd: path, absolute: true })) {
    if (filesWithMatches >= MAX_FILES_WITH_MATCHES || totalLines >= MAX_TOTAL_LINES) {
      truncated = true;
      break;
    }

    // Skip directories
    let entryStat;
    try {
      entryStat = await files.stat(entry);
    } catch {
      continue;
    }
    if (!entryStat.isFile) continue;

    // Skip files exceeding size limit
    try {
      await files.checkFileSize(entry);
    } catch (err) {
      if (isDomainError(err) && err.type === "capacity") continue;
      throw err;
    }

    let content: string;
    try {
      content = await files.readText(entry);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    let fileMatchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (totalLines >= MAX_TOTAL_LINES) {
        truncated = true;
        break;
      }
      if (fileMatchCount >= PER_FILE_CAP) break;

      if (regex.test(lines[i])) {
        matches.push(`${entry}:${i + 1}: ${lines[i]}`);
        fileMatchCount++;
        totalLines++;
      }
    }

    if (fileMatchCount > 0) {
      filesWithMatches++;
    }
  }

  let output: string;
  if (matches.length === 0) {
    output = `No matches for pattern "${pattern}" in ${path}.`;
  } else {
    output = matches.join("\n");
    output += `\n\nMatches: ${matches.length} line(s) in ${filesWithMatches} file(s)`;
    if (truncated) {
      output += ` (truncated — refine pattern or include filter for complete results)`;
    }
  }

  const hint = "\nNote: Read any matched file for full context around the matches, or refine the pattern to narrow results.";

  return text(output + hint);
}

export default {
  name: "grep",
  schema: {
    name: "grep",
    description: "Search file contents by regex pattern. Returns matches in file:line:content format. Capped at 200 matching lines across 50 files. Use for finding code patterns, string occurrences, or specific content across files.",
    schema: z.object({
      pattern: z.string().describe("Regular expression pattern to search for."),
      path: z.string().describe("Base directory to search in. Must be an absolute path within allowed read directories."),
      include: z.string().describe('Glob filter for file types (e.g. "*.ts", "*.json"). Defaults to "*" (all files).'),
      case_insensitive: z.boolean().describe("If true, match case-insensitively. Defaults to false."),
    }),
  },
  handler: grep,
} satisfies ToolDefinition;
