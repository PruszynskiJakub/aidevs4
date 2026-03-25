import { resolve, basename } from "path";
import matter from "gray-matter";
import type { AgentConfig } from "../../../types/assistant.ts";
import type { ToolFilter } from "../../../types/tool.ts";
import { files } from "../../common/file.ts";

const AGENTS_DIR = resolve(import.meta.dir, "../../../../workspace/agents");

function validate(data: Record<string, unknown>, body: string, filename: string): AgentConfig {
  for (const field of ["name", "model"] as const) {
    if (typeof data[field] !== "string" || (data[field] as string).trim() === "") {
      throw new Error(
        `Invalid agent "${filename}": missing required field "${field}"`,
      );
    }
  }

  if (!body.trim()) {
    throw new Error(`Invalid agent "${filename}": markdown body (system prompt) is empty`);
  }

  if (data.tools !== undefined) {
    if (typeof data.tools !== "object" || data.tools === null) {
      throw new Error(`Invalid agent "${filename}": "tools" must be an object`);
    }

    const tools = data.tools as Record<string, unknown>;

    if (tools.include !== undefined && tools.exclude !== undefined) {
      throw new Error(
        `Invalid agent "${filename}": "tools" cannot have both "include" and "exclude"`,
      );
    }

    for (const key of ["include", "exclude"] as const) {
      if (tools[key] !== undefined) {
        if (!Array.isArray(tools[key])) {
          throw new Error(
            `Invalid agent "${filename}": "tools.${key}" must be an array`,
          );
        }
        for (const item of tools[key] as unknown[]) {
          if (typeof item !== "string") {
            throw new Error(
              `Invalid agent "${filename}": "tools.${key}" items must be strings`,
            );
          }
        }
      }
    }
  }

  if (data.capabilities !== undefined) {
    if (!Array.isArray(data.capabilities)) {
      throw new Error(`Invalid agent "${filename}": "capabilities" must be an array`);
    }
    for (const item of data.capabilities as unknown[]) {
      if (typeof item !== "string") {
        throw new Error(`Invalid agent "${filename}": "capabilities" items must be strings`);
      }
    }
  }

  return {
    name: (data.name as string).trim(),
    model: (data.model as string).trim(),
    prompt: body.trim(),
    ...(data.tools !== undefined && { tools: data.tools as ToolFilter }),
    ...(data.capabilities !== undefined && { capabilities: data.capabilities as string[] }),
  };
}

async function loadAll(): Promise<Map<string, AgentConfig>> {
  const glob = new Bun.Glob("*.md");
  const map = new Map<string, AgentConfig>();

  for await (const path of glob.scan({ cwd: AGENTS_DIR })) {
    const fullPath = resolve(AGENTS_DIR, path);
    const raw = await files.readText(fullPath);
    const { data, content } = matter(raw);
    const key = basename(path, ".md");
    const config = validate(data as Record<string, unknown>, content, path);
    map.set(key, config);
  }

  if (map.size === 0) {
    throw new Error(`No agent files found in ${AGENTS_DIR}`);
  }

  return map;
}

export function createAssistantsService() {
  let cache: Map<string, AgentConfig> | null = null;

  return {
    async get(name: string): Promise<AgentConfig> {
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
    },

    /** Reset cache — for testing only. */
    resetCache(): void {
      cache = null;
    },
  };
}

export const assistantsService = createAssistantsService();
