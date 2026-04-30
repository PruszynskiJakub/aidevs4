import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { sandbox as files } from "../infra/sandbox.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";
import { md5 } from "../utils/hash.ts";
import { DomainError } from "../types/errors.ts";

const MAX_STRING_LENGTH = 64 * 1024; // 64 KB

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function unifiedDiff(original: string, modified: string, filePath: string): string {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Simple diff: find first and last differing lines
  let firstDiff = 0;
  while (firstDiff < oldLines.length && firstDiff < newLines.length && oldLines[firstDiff] === newLines[firstDiff]) {
    firstDiff++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > firstDiff && newEnd > firstDiff && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const contextBefore = Math.max(0, firstDiff - 3);
  const contextAfterOld = Math.min(oldLines.length - 1, oldEnd + 3);
  const contextAfterNew = Math.min(newLines.length - 1, newEnd + 3);

  lines.push(`@@ -${contextBefore + 1},${contextAfterOld - contextBefore + 1} +${contextBefore + 1},${contextAfterNew - contextBefore + 1} @@`);

  for (let i = contextBefore; i < firstDiff; i++) {
    lines.push(` ${oldLines[i]}`);
  }
  for (let i = firstDiff; i <= oldEnd; i++) {
    lines.push(`-${oldLines[i]}`);
  }
  for (let i = firstDiff; i <= newEnd; i++) {
    lines.push(`+${newLines[i]}`);
  }
  for (let i = oldEnd + 1; i <= contextAfterOld; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join("\n");
}

async function edit_file(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new DomainError({ type: "validation", message: "file_path is required and must be a non-empty string" });
  }
  assertMaxLength(filePath, "file_path", 1024);

  const oldString = args.old_string as string;
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new DomainError({ type: "validation", message: "old_string is required and must be a non-empty string" });
  }
  assertMaxLength(oldString, "old_string", MAX_STRING_LENGTH);

  const newString = args.new_string as string;
  if (typeof newString !== "string") {
    throw new DomainError({ type: "validation", message: "new_string is required and must be a string" });
  }
  assertMaxLength(newString, "new_string", MAX_STRING_LENGTH);

  if (oldString === newString) {
    throw new DomainError({ type: "validation", message: "old_string and new_string must be different" });
  }

  const replaceAll = args.replace_all === true;
  const checksum = typeof args.checksum === "string" ? args.checksum : "";
  const dryRun = args.dry_run === true;

  // Read file (sandbox enforced by file service)
  const content = await files.readText(filePath);

  // Checksum verification
  if (checksum.length > 0) {
    const actual = md5(content);
    if (actual !== checksum) {
      throw new DomainError({
        type: "conflict",
        message: `File changed since last read (expected ${checksum}, got ${actual}). Re-read the file to get the current checksum.`,
      });
    }
  }

  // Verify old_string exists
  if (!content.includes(oldString)) {
    throw new DomainError({
      type: "not_found",
      message: `old_string not found in ${filePath}. Verify the exact text including whitespace and line breaks.`,
    });
  }

  // Uniqueness check
  const occurrences = countOccurrences(content, oldString);
  if (!replaceAll && occurrences > 1) {
    throw new DomainError({
      type: "validation",
      message: `old_string found ${occurrences} times in ${filePath}. Provide more surrounding context for a unique match, or set replace_all to true.`,
    });
  }

  // Perform replacement
  const result = replaceAll
    ? content.replaceAll(oldString, newString)
    : content.replace(oldString, newString);

  const replacedCount = replaceAll ? occurrences : 1;

  // Dry run: return diff without writing
  if (dryRun) {
    const diff = unifiedDiff(content, result, filePath);
    return text(diff);
  }

  // Write back (sandbox enforced by file service)
  await files.write(filePath, result);

  const newChecksum = md5(result);
  return text(`Edited ${filePath}: replaced ${replacedCount} occurrence(s).\nChecksum: ${newChecksum}`);
}

export default {
  name: "edit_file",
  schema: {
    name: "edit_file",
    description: "Perform exact string replacement in a file. Supports single or bulk replacement, optional checksum verification for concurrency safety, and dry-run preview. Use for modifying existing files, patching code, or updating configuration values.",
    schema: z.object({
      file_path: z.string().describe("Path to the file to edit. Must be within allowed write directories."),
      old_string: z.string().describe("Exact string to find and replace. Must exist in the file."),
      new_string: z.string().describe("Replacement string. Must differ from old_string."),
      replace_all: z.boolean().describe("If true, replace all occurrences. If false, require exactly one occurrence. Defaults to false."),
      checksum: z.string().describe("md5 checksum from a prior read. If non-empty, edit is rejected when the file has changed. Pass empty string to skip check."),
      dry_run: z.boolean().describe("If true, return a diff preview without writing changes. Defaults to false."),
    }),
  },
  handler: edit_file,
} satisfies ToolDefinition;
