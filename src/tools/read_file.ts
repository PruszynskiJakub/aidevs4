import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { sandbox as files } from "../infra/sandbox.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";
import { md5 } from "../utils/hash.ts";
import { DomainError } from "../types/errors.ts";

async function read_file(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new DomainError({ type: "validation", message: "file_path is required and must be a non-empty string" });
  }
  assertMaxLength(filePath, "file_path", 1024);

  const offset = typeof args.offset === "number" ? args.offset : 1;
  const limit = typeof args.limit === "number" ? args.limit : 2000;

  if (offset < 1) throw new DomainError({ type: "validation", message: "offset must be >= 1" });
  if (limit < 1) throw new DomainError({ type: "validation", message: "limit must be >= 1" });

  await files.checkFileSize(filePath);

  const content = await files.readText(filePath);
  const checksum = md5(content);
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (offset > totalLines) {
    return text(`File has ${totalLines} lines but offset is ${offset}. Nothing to show.\nChecksum: ${checksum} | Lines: ${totalLines}`);
  }

  const clampedOffset = Math.min(offset, totalLines);
  const selectedLines = allLines.slice(clampedOffset - 1, clampedOffset - 1 + limit);

  const numbered = selectedLines.map((line, i) => {
    const lineNum = clampedOffset + i;
    return `  ${lineNum}\t${line}`;
  }).join("\n");

  const endLine = clampedOffset + selectedLines.length - 1;
  const result = `${numbered}\nChecksum: ${checksum} | Lines: ${totalLines}`;
  const hint = "\nNote: Adjust offset/limit to read other sections, or search within the file for specific content.";

  return text(result + hint);
}

export default {
  name: "read_file",
  schema: {
    name: "read_file",
    description: "Read a text file with line numbers. Returns content in cat -n format with md5 checksum. Supports pagination via offset/limit for large files. Use for inspecting file contents, verifying edits, or extracting specific sections.",
    schema: z.object({
      file_path: z.string().describe("Absolute or relative path to the file to read."),
      offset: z.int().describe("1-based line number to start reading from. Defaults to 1."),
      limit: z.int().describe("Maximum number of lines to return. Defaults to 2000."),
    }),
  },
  handler: read_file,
} satisfies ToolDefinition;
