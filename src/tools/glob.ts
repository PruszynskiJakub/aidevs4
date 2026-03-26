import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { files } from "../infra/file.ts";
import { getSessionId } from "../agent/context.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

const MAX_RESULTS = 500;

async function glob(args: Record<string, unknown>): Promise<Document> {
  validateKeys(args);

  const pattern = args.pattern as string;
  if (!pattern || typeof pattern !== "string") {
    throw new Error("pattern is required and must be a non-empty string");
  }
  assertMaxLength(pattern, "pattern", 512);

  const path = args.path as string;
  if (!path || typeof path !== "string") {
    throw new Error("path is required and must be a non-empty string");
  }
  assertMaxLength(path, "path", 1024);

  // Verify directory exists (also triggers sandbox check via file service)
  const st = await files.stat(path);
  if (!st.isDirectory) {
    throw new Error(`"${path}" is not a directory`);
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

  let text: string;
  if (results.length === 0) {
    text = `No files matched pattern "${pattern}" in ${path}.`;
  } else {
    text = results.join("\n");
    text += `\n\nTotal: ${results.length} file(s)`;
    if (truncated) {
      text += ` (truncated at ${MAX_RESULTS} — narrow the pattern for complete results)`;
    }
  }

  const hint = "\nNote: Read any matched file for full contents, or narrow the pattern to reduce results.";

  return createDocument(text + hint, `glob: ${pattern} in ${path} → ${results.length} file(s)`, {
    source: path,
    type: "document",
    mimeType: "text/plain",
  }, getSessionId());
}

export default {
  name: "glob",
  handler: glob,
} satisfies ToolDefinition;
