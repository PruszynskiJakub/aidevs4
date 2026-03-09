import { readdir } from "fs/promises";
import { join } from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { downloadFile } from "./download_file.ts";
import { readCsvStructure } from "./read_csv.ts";
import { searchCsv } from "./search_csv.ts";
import { transformCsv } from "./transform_csv.ts";

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");

const handlers: Record<string, (args: any) => Promise<unknown>> = {
  download_file: downloadFile,
  read_csv_structure: readCsvStructure,
  search_csv: searchCsv,
  transform_csv: transformCsv,
};

async function loadSchemas(): Promise<ChatCompletionTool[]> {
  const entries = await readdir(SCHEMAS_DIR);
  const tools: ChatCompletionTool[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const schema = await Bun.file(join(SCHEMAS_DIR, entry)).json();
    tools.push({
      type: "function",
      function: {
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        strict: true,
      },
    });
  }

  return tools;
}

let cachedTools: ChatCompletionTool[] | null = null;

export async function getTools(): Promise<ChatCompletionTool[]> {
  if (!cachedTools) {
    cachedTools = await loadSchemas();
  }
  return cachedTools;
}

export async function dispatch(name: string, argsJson: string): Promise<string> {
  const handler = handlers[name];
  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    const args = JSON.parse(argsJson);
    const result = await handler(args);
    return JSON.stringify(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}
