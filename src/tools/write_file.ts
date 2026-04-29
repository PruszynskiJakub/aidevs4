import { dirname } from "path";
import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { sandbox as files } from "../infra/sandbox.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";
import { DomainError } from "../types/errors.ts";

async function write_file(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);

  const filePath = args.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    throw new DomainError({ type: "validation", message: "file_path is required and must be a non-empty string" });
  }
  assertMaxLength(filePath, "file_path", 1024);

  const content = args.content;
  if (typeof content !== "string") {
    throw new DomainError({ type: "validation", message: "content is required and must be a string" });
  }

  // Auto-create parent directories
  const dir = dirname(filePath);
  await files.mkdir(dir);

  await files.write(filePath, content);

  const bytes = new TextEncoder().encode(content).length;
  const result = `Wrote ${bytes} bytes to ${filePath}`;
  const hint = "\nNote: Verify contents or process the file further.";

  return text(result + hint);
}

export default {
  name: "write_file",
  schema: {
    name: "write_file",
    description: "Create or overwrite a file. Auto-creates parent directories. Writes to the session output directory. Use for saving generated content, creating configuration files, or writing processed data.",
    schema: z.object({
      file_path: z.string().describe("Path to write to. Must be within the allowed write directories."),
      content: z.string().describe("Text content to write to the file."),
    }),
  },
  handler: write_file,
} satisfies ToolDefinition;
