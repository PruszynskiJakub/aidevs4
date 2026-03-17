import { parse } from "yaml";
import { resolve, basename } from "path";
import type { AssistantConfig, ToolFilter } from "../types/assistant.ts";

const ASSISTANTS_DIR = resolve(import.meta.dir, "../assistants");

let cache: Map<string, AssistantConfig> | null = null;

function validate(raw: unknown, filename: string): AssistantConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid assistant file "${filename}": must be a YAML object`);
  }

  const obj = raw as Record<string, unknown>;

  for (const field of ["name", "objective", "tone"] as const) {
    if (typeof obj[field] !== "string" || (obj[field] as string).trim() === "") {
      throw new Error(
        `Invalid assistant "${filename}": missing required field "${field}"`,
      );
    }
  }

  if (obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error(`Invalid assistant "${filename}": "model" must be a string`);
  }

  if (obj.tools !== undefined) {
    if (typeof obj.tools !== "object" || obj.tools === null) {
      throw new Error(`Invalid assistant "${filename}": "tools" must be an object`);
    }

    const tools = obj.tools as Record<string, unknown>;

    if (tools.include !== undefined && tools.exclude !== undefined) {
      throw new Error(
        `Invalid assistant "${filename}": "tools" cannot have both "include" and "exclude"`,
      );
    }

    for (const key of ["include", "exclude"] as const) {
      if (tools[key] !== undefined) {
        if (!Array.isArray(tools[key])) {
          throw new Error(
            `Invalid assistant "${filename}": "tools.${key}" must be an array`,
          );
        }
        for (const item of tools[key] as unknown[]) {
          if (typeof item !== "string") {
            throw new Error(
              `Invalid assistant "${filename}": "tools.${key}" items must be strings`,
            );
          }
        }
      }
    }
  }

  return {
    name: (obj.name as string).trim(),
    objective: (obj.objective as string).trim(),
    tone: (obj.tone as string).trim(),
    ...(obj.model !== undefined && { model: obj.model as string }),
    ...(obj.tools !== undefined && { tools: obj.tools as ToolFilter }),
  };
}

async function loadAll(): Promise<Map<string, AssistantConfig>> {
  const glob = new Bun.Glob("*.yaml");
  const map = new Map<string, AssistantConfig>();

  for await (const path of glob.scan({ cwd: ASSISTANTS_DIR })) {
    const fullPath = resolve(ASSISTANTS_DIR, path);
    const text = await Bun.file(fullPath).text();
    const raw = parse(text);
    const key = basename(path, ".yaml");
    const config = validate(raw, path);
    map.set(key, config);
  }

  if (map.size === 0) {
    throw new Error(`No assistant files found in ${ASSISTANTS_DIR}`);
  }

  return map;
}

export async function get(name: string): Promise<AssistantConfig> {
  if (!cache) {
    cache = await loadAll();
  }

  const config = cache.get(name);
  if (!config) {
    const available = Array.from(cache.keys()).join(", ");
    throw new Error(
      `Unknown assistant: "${name}". Available: ${available}`,
    );
  }

  return config;
}

/** Reset cache — for testing only. */
export function resetCache(): void {
  cache = null;
}

export const assistants = { get, resetCache };
