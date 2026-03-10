import { join, extname } from "path";
import { files } from "../services/file.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { parseCsv } from "../utils/csv.ts";

// --- CSV inspect ---

interface CsvInspectResult {
  file: string;
  format: "csv";
  rows: number;
  columns: string[];
  sample: Record<string, string>[];
}

async function inspectCsv(path: string): Promise<CsvInspectResult> {
  const rows = await parseCsv(path);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    file: path,
    format: "csv",
    rows: rows.length,
    columns,
    sample: rows.slice(0, 3),
  };
}

// --- JSON inspect ---

interface JsonInspectResult {
  file: string;
  format: "json";
  structure: "array" | "object";
  count: number;
  schema: { key: string; type: string }[];
  sample: unknown;
}

async function inspectJson(path: string): Promise<JsonInspectResult> {
  const data = await files.readJson<unknown>(path);

  if (Array.isArray(data)) {
    const sample = data.slice(0, 3);
    const first = data[0];
    const schema =
      first && typeof first === "object" && first !== null
        ? Object.entries(first).map(([key, val]) => ({ key, type: Array.isArray(val) ? "array" : typeof val }))
        : [];
    return {
      file: path,
      format: "json",
      structure: "array",
      count: data.length,
      schema,
      sample,
    };
  }

  if (typeof data === "object" && data !== null) {
    const entries = Object.entries(data as Record<string, unknown>);
    const schema = entries.map(([key, val]) => ({ key, type: Array.isArray(val) ? "array" : typeof val }));
    const sampleKeys = entries.slice(0, 3);
    const sample = Object.fromEntries(sampleKeys);
    return {
      file: path,
      format: "json",
      structure: "object",
      count: entries.length,
      schema,
      sample,
    };
  }

  throw new Error(`JSON file does not contain an object or array: ${path}`);
}

// --- Markdown inspect ---

interface MarkdownHeading {
  level: number;
  text: string;
}

interface MarkdownInspectResult {
  file: string;
  format: "markdown";
  totalLines: number;
  headings: MarkdownHeading[];
  linkCount: number;
  codeBlockCount: number;
}

async function inspectMarkdown(path: string): Promise<MarkdownInspectResult> {
  const content = await files.readText(path);
  const lines = content.split("\n");

  const headings: MarkdownHeading[] = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim() });
    }
  }

  const linkMatches = content.match(/\[.*?\]\(.*?\)/g);
  const linkCount = linkMatches ? linkMatches.length : 0;

  let codeBlockCount = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      codeBlockCount++;
    }
  }
  codeBlockCount = Math.floor(codeBlockCount / 2);

  return {
    file: path,
    format: "markdown",
    totalLines: lines.length,
    headings,
    linkCount,
    codeBlockCount,
  };
}

// --- inspect dispatcher ---

const SUPPORTED_EXTENSIONS = new Set([".csv", ".json", ".md"]);

type InspectResult = CsvInspectResult | JsonInspectResult | MarkdownInspectResult;

async function inspectFile(path: string): Promise<InspectResult> {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".csv":
      return inspectCsv(path);
    case ".json":
      return inspectJson(path);
    case ".md":
      return inspectMarkdown(path);
    default:
      throw new Error(`Unsupported file extension "${ext}". Supported: .csv, .json, .md`);
  }
}

async function inspect(payload: { path: string }): Promise<InspectResult[]> {
  const info = await files.stat(payload.path);

  if (info.isDirectory) {
    const entries = await files.readdir(payload.path);
    const supported = entries.filter((e) => SUPPORTED_EXTENSIONS.has(extname(e).toLowerCase()));
    if (supported.length === 0) {
      throw new Error(`No supported files (.csv, .json, .md) found in directory: ${payload.path}`);
    }
    const results: InspectResult[] = [];
    for (const entry of supported) {
      results.push(await inspectFile(join(payload.path, entry)));
    }
    return results;
  }

  return [await inspectFile(payload.path)];
}

// --- action router ---

const VALID_ACTIONS = ["inspect"] as const;
type Action = (typeof VALID_ACTIONS)[number];

const actionHandlers: Record<Action, (payload: any) => Promise<unknown>> = {
  inspect,
};

async function filesystem({ action, payload }: { action: string; payload: unknown }): Promise<unknown> {
  if (!VALID_ACTIONS.includes(action as Action)) {
    throw new Error(`Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}`);
  }
  return actionHandlers[action as Action](payload);
}

export default {
  name: "filesystem",
  handler: filesystem,
} satisfies ToolDefinition;
