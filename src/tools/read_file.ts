import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";

interface ReadFileArgs {
  path: string;
  max_lines?: number;
}

const DEFAULT_MAX_LINES = 100;

async function readFile(args: ReadFileArgs) {
  const maxLines = args.max_lines ?? DEFAULT_MAX_LINES;
  const raw = await files.readText(args.path);
  const allLines = raw.split("\n");
  const truncated = allLines.length > maxLines;
  const lines = truncated ? allLines.slice(0, maxLines) : allLines;

  return {
    path: args.path,
    lines: allLines.length,
    truncated,
    content: lines.join("\n"),
  };
}

export default {
  name: "read_file",
  handler: readFile,
} satisfies ToolDefinition;
