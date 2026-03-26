import { createHash } from "crypto";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { files } from "../infra/file.ts";
import { getSessionId } from "../agent/context.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

const MAX_STRING_LENGTH = 64 * 1024; // 64 KB

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

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

async function edit_file(args: Record<string, unknown>): Promise<Document> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new Error("file_path is required and must be a non-empty string");
  }
  assertMaxLength(filePath, "file_path", 1024);

  const oldString = args.old_string as string;
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("old_string is required and must be a non-empty string");
  }
  assertMaxLength(oldString, "old_string", MAX_STRING_LENGTH);

  const newString = args.new_string as string;
  if (typeof newString !== "string") {
    throw new Error("new_string is required and must be a string");
  }
  assertMaxLength(newString, "new_string", MAX_STRING_LENGTH);

  if (oldString === newString) {
    throw new Error("old_string and new_string must be different");
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
      throw new Error(
        `File changed since last read (expected ${checksum}, got ${actual}). Re-read the file to get the current checksum.`
      );
    }
  }

  // Verify old_string exists
  if (!content.includes(oldString)) {
    throw new Error(`old_string not found in ${filePath}. Verify the exact text including whitespace and line breaks.`);
  }

  // Uniqueness check
  const occurrences = countOccurrences(content, oldString);
  if (!replaceAll && occurrences > 1) {
    throw new Error(
      `old_string found ${occurrences} times in ${filePath}. Provide more surrounding context for a unique match, or set replace_all to true.`
    );
  }

  // Perform replacement
  const result = replaceAll
    ? content.replaceAll(oldString, newString)
    : content.replace(oldString, newString);

  const replacedCount = replaceAll ? occurrences : 1;

  // Dry run: return diff without writing
  if (dryRun) {
    const diff = unifiedDiff(content, result, filePath);
    return createDocument(diff, `Dry run — no changes applied to ${filePath}.`, {
      source: filePath,
      type: "document",
      mimeType: "text/plain",
    }, getSessionId());
  }

  // Write back (sandbox enforced by file service)
  await files.write(filePath, result);

  const newChecksum = md5(result);
  const text = `Edited ${filePath}: replaced ${replacedCount} occurrence(s).\nChecksum: ${newChecksum}`;

  return createDocument(text, `edit_file: ${filePath} (${replacedCount} replacement(s))`, {
    source: filePath,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "edit_file",
  handler: edit_file,
} satisfies ToolDefinition;
