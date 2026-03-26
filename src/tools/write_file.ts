import { dirname } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { files } from "../infra/file.ts";
import { getSessionId } from "../agent/context.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

async function write_file(args: Record<string, unknown>): Promise<Document> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new Error("file_path is required and must be a non-empty string");
  }
  assertMaxLength(filePath, "file_path", 1024);

  const content = args.content;
  if (typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }

  // Auto-create parent directories
  const dir = dirname(filePath);
  await files.mkdir(dir);

  await files.write(filePath, content);

  const bytes = new TextEncoder().encode(content).length;
  const text = `Wrote ${bytes} bytes to ${filePath}`;
  const hint = "\nNote: Verify contents or process the file further.";

  return createDocument(text + hint, `write_file: ${filePath} (${bytes} bytes)`, {
    source: filePath,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "write_file",
  handler: write_file,
} satisfies ToolDefinition;
