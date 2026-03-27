import { resolve } from "path";
import matter from "gray-matter";
import type { AgentConfig } from "../types/assistant.ts";
import type { LLMTool } from "../types/llm.ts";
import { files } from "../infra/file.ts";
import { getTools, getToolsByName } from "../tools/index.ts";

const AGENTS_DIR = resolve(import.meta.dir, "../../workspace/agents");

export interface ResolvedAgent {
  prompt: string;
  model: string;
  tools: LLMTool[];
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

async function loadOne(name: string): Promise<AgentConfig> {
  const filePath = resolve(AGENTS_DIR, `${name}.agent.md`);
  const raw = await files.readText(filePath);
  const { data, content } = matter(raw);
  return validate(data as Record<string, unknown>, content, `${name}.agent.md`);
}

function resolveTools(agentName: string, toolNames: string[]): LLMTool[] {
  const resolved: LLMTool[] = [];
  for (const name of toolNames) {
    const tools = getToolsByName(name);
    if (tools) {
      resolved.push(...tools);
    } else {
      console.warn(`Agent '${agentName}': tool '${name}' not found in registry, skipping`);
    }
  }
  return resolved;
}

export function createAgentsService() {
  return {
    async get(name: string): Promise<AgentConfig> {
      const filePath = resolve(AGENTS_DIR, `${name}.agent.md`);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        throw new Error(`Unknown agent: "${name}". File not found: ${name}.agent.md`);
      }
      return loadOne(name);
    },

    async resolve(name: string): Promise<ResolvedAgent> {
      const agent = await this.get(name);
      const tools = agent.tools
        ? resolveTools(agent.name, agent.tools)
        : await getTools();
      return {
        prompt: agent.prompt,
        model: agent.model,
        tools,
      };
    },
  };
}

export const agentsService = createAgentsService();
