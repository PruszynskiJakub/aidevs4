import { createHash } from "crypto";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { files } from "../infra/file.ts";
import { getSessionId } from "../agent/context.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

async function read_file(args: Record<string, unknown>): Promise<Document> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new Error("file_path is required and must be a non-empty string");
  }
  assertMaxLength(filePath, "file_path", 1024);

  const offset = typeof args.offset === "number" ? args.offset : 1;
  const limit = typeof args.limit === "number" ? args.limit : 2000;

  if (offset < 1) throw new Error("offset must be >= 1");
  if (limit < 1) throw new Error("limit must be >= 1");

  await files.checkFileSize(filePath);

  const content = await files.readText(filePath);
  const checksum = createHash("md5").update(content).digest("hex");
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (offset > totalLines) {
    const text = `File has ${totalLines} lines but offset is ${offset}. Nothing to show.\nChecksum: ${checksum} | Lines: ${totalLines}`;
    return createDocument(text, `read_file: ${filePath} (empty range)`, {
      source: filePath,
      type: "document",
      mimeType: "text/plain",
    }, getSessionId());
  }

  const clampedOffset = Math.min(offset, totalLines);
  const selectedLines = allLines.slice(clampedOffset - 1, clampedOffset - 1 + limit);

  const numbered = selectedLines.map((line, i) => {
    const lineNum = clampedOffset + i;
    return `  ${lineNum}\t${line}`;
  }).join("\n");

  const endLine = clampedOffset + selectedLines.length - 1;
  const text = `${numbered}\nChecksum: ${checksum} | Lines: ${totalLines}`;
  const hint = "\nNote: Adjust offset/limit to read other sections, or search within the file for specific content.";

  return createDocument(text + hint, `read_file: ${filePath} lines ${clampedOffset}-${endLine} of ${totalLines}`, {
    source: filePath,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "read_file",
  handler: read_file,
} satisfies ToolDefinition;
