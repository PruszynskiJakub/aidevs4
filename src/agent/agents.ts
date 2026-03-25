import { resolve, basename } from "path";
import matter from "gray-matter";
import type { AgentConfig } from "../types/assistant.ts";
import type { ToolFilter } from "../types/tool.ts";
import { files } from "../infra/file.ts";

const AGENTS_DIR = resolve(import.meta.dir, "../../workspace/agents");

export interface ResolvedAgent {
  prompt: string;
  model: string;
  toolFilter?: ToolFilter;
}

function stringArray(data: Record<string, unknown>, field: string, filename: string): string[] | undefined {
  if (data[field] === undefined) return undefined;
  if (!Array.isArray(data[field])) {
    throw new Error(`Invalid agent "${filename}": "${field}" must be an array`);
  }
  for (const item of data[field] as unknown[]) {
    if (typeof item !== "string") {
      throw new Error(`Invalid agent "${filename}": "${field}" items must be strings`);
    }
  }
  return data[field] as string[];
}

function validate(data: Record<string, unknown>, body: string, filename: string): AgentConfig {
  for (const field of ["name", "model"] as const) {
    if (typeof data[field] !== "string" || (data[field] as string).trim() === "") {
      throw new Error(`Invalid agent "${filename}": missing required field "${field}"`);
    }
  }

  if (!body.trim()) {
    throw new Error(`Invalid agent "${filename}": markdown body (system prompt) is empty`);
  }

  const tools = stringArray(data, "tools", filename);
  const capabilities = stringArray(data, "capabilities", filename);

  return {
    name: (data.name as string).trim(),
    model: (data.model as string).trim(),
    prompt: body.trim(),
    ...(tools && { tools }),
    ...(capabilities && { capabilities }),
  };
}

async function loadAll(): Promise<Map<string, AgentConfig>> {
  const glob = new Bun.Glob("*.agent.md");
  const map = new Map<string, AgentConfig>();

  for await (const path of glob.scan({ cwd: AGENTS_DIR })) {
    const fullPath = resolve(AGENTS_DIR, path);
    const raw = await files.readText(fullPath);
    const { data, content } = matter(raw);
    const key = basename(path, ".agent.md");
    const config = validate(data as Record<string, unknown>, content, path);
    map.set(key, config);
  }

  if (map.size === 0) {
    throw new Error(`No agent files found in ${AGENTS_DIR}`);
  }

  return map;
}

export function createAgentsService() {
  let cache: Map<string, AgentConfig> | null = null;

  async function ensureLoaded(): Promise<Map<string, AgentConfig>> {
    if (!cache) {
      cache = await loadAll();
    }
    return cache;
  }

  return {
    async get(name: string): Promise<AgentConfig> {
      const map = await ensureLoaded();
      const config = map.get(name);
      if (!config) {
        const available = Array.from(map.keys()).join(", ");
        throw new Error(`Unknown agent: "${name}". Available: ${available}`);
      }
      return config;
    },

    async resolve(name: string): Promise<ResolvedAgent> {
      const agent = await this.get(name);
      return {
        prompt: agent.prompt,
        model: agent.model,
        ...(agent.tools && { toolFilter: { include: agent.tools } }),
      };
    },

    resetCache(): void {
      cache = null;
    },
  };
}

export const agentsService = createAgentsService();
