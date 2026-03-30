import { z } from "zod";
import { join, resolve, relative, extname, basename } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { files } from "../infra/file.ts";
import { config } from "../config/index.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

const KNOWLEDGE_ROOT = join(config.paths.workspaceDir, "knowledge");
const PATH_RE = /^[a-zA-Z0-9_.\-\/]+$/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

function safePath(inputPath: string): string {
  assertMaxLength(inputPath, "path", 256);
  if (inputPath.includes("..") || inputPath.startsWith("/")) {
    throw new Error("Path must be relative and cannot contain '..'");
  }
  if (inputPath && !PATH_RE.test(inputPath)) {
    throw new Error("Path contains invalid characters");
  }
  const resolved = resolve(join(KNOWLEDGE_ROOT, inputPath));
  if (!resolved.startsWith(KNOWLEDGE_ROOT)) {
    throw new Error("Path escapes knowledge base root");
  }
  return resolved;
}

function extractCrossRefs(content: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(LINK_RE)) {
    const [, linkText, href] = match;
    if (!href.startsWith("http") && !href.startsWith("#")) {
      refs.push(`${href} — "${linkText}"`);
    }
  }
  return [...new Set(refs)];
}

async function listKnowledge(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);
  const inputPath = (args.path as string) || "";
  const resolved = safePath(inputPath);

  const indexPath = join(resolved, "_index.md");
  if (await files.exists(indexPath)) {
    const content = await files.readText(indexPath);
    return text(content + "\n\nNote: Read a specific document to see its full content and cross-references.");
  }

  let entries: string[];
  try {
    entries = await files.readdir(resolved);
  } catch {
    throw new Error(`Directory not found: ${inputPath || "(root)"}`);
  }

  const lines: string[] = [];
  for (const entry of entries.sort()) {
    const entryPath = join(resolved, entry);
    const s = await files.stat(entryPath);
    const rel = relative(KNOWLEDGE_ROOT, entryPath);
    const prefix = s.isDirectory ? "[dir]" : `${Math.ceil(s.size / 1024)}KB`;
    lines.push(`${prefix}  ${rel}`);
  }

  if (lines.length === 0) {
    return text("Knowledge base is empty at this path.");
  }

  return text(lines.join("\n") + "\n\nNote: Read a document or list a subdirectory to explore further.");
}

async function readKnowledge(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);
  const inputPath = args.path as string;
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("path is required and must be a non-empty string");
  }
  if (extname(inputPath) !== ".md") {
    throw new Error("Only .md files can be read from the knowledge base");
  }

  const resolved = safePath(inputPath);
  await files.checkFileSize(resolved);
  const raw = await files.readText(resolved);

  let title = basename(inputPath, ".md");
  let tags = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx !== -1) {
      const fm = raw.slice(3, endIdx);
      const titleMatch = fm.match(/title:\s*(.+)/);
      const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
      if (titleMatch) title = titleMatch[1].trim();
      if (tagsMatch) tags = tagsMatch[1].trim();
      body = raw.slice(endIdx + 3).trimStart();
    }
  }

  const numbered = body.split("\n").map((line, i) => `  ${i + 1}\t${line}`).join("\n");
  const crossRefs = extractCrossRefs(raw);

  let result = `# ${title}\n`;
  if (tags) result += `Tags: ${tags}\n`;
  result += `\n${numbered}`;

  if (crossRefs.length > 0) {
    result += `\n\n## Cross-references\n${crossRefs.map(r => `- ${r}`).join("\n")}`;
  }

  result += "\n\nNote: Follow cross-references to explore related topics, or list a directory to discover other documents.";
  return text(result);
}

async function knowledge(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "list":
      return listKnowledge(payload);
    case "read":
      return readKnowledge(payload);
    default:
      throw new Error(`Unknown knowledge action: ${action}`);
  }
}

export default {
  name: "knowledge",
  schema: {
    name: "knowledge",
    description: "Navigate a curated knowledge base of markdown documents. Use list to discover available topics, then read to get document content and cross-references. Documents link to each other — follow cross-references to build full context.",
    actions: {
      list: {
        description: "List available knowledge documents. Returns the index if one exists, otherwise a directory listing. Start here to discover what's available.",
        schema: z.object({
          path: z.string().describe("Subdirectory to list, relative to knowledge root. Empty string for root."),
        }),
      },
      read: {
        description: "Read a knowledge document. Returns content with line numbers and extracted cross-references to related documents.",
        schema: z.object({
          path: z.string().describe("Path to .md file relative to knowledge root. e.g. 'procedures/task-management.md'"),
        }),
      },
    },
  },
  handler: knowledge,
} satisfies ToolDefinition;
