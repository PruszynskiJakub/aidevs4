import { resolve } from "path";
import { z } from "zod";
import matter from "gray-matter";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { getSessionId, getLogger } from "../agent/context.ts";
import { assertMaxLength } from "../utils/parse.ts";

const MAX_PROMPT_LENGTH = 10_000;
const AGENTS_DIR = resolve(import.meta.dir, "../../workspace/agents");

interface AgentInfo {
  name: string;
  description: string;
}

async function scanAgents(): Promise<AgentInfo[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("*.agent.md").scan({ cwd: AGENTS_DIR }),
  );
  const agents: AgentInfo[] = [];
  for (const entry of entries) {
    const raw = await Bun.file(resolve(AGENTS_DIR, entry)).text();
    const { data } = matter(raw);
    const name = (data.name as string) ?? entry.replace(/\.agent\.md$/, "");
    const caps = Array.isArray(data.capabilities)
      ? (data.capabilities as string[]).join(", ")
      : "";
    agents.push({ name, description: caps || name });
  }
  return agents;
}

async function delegate(args: Record<string, unknown>): Promise<Document> {
  const { agent, prompt } = args as { agent: string; prompt: string };

  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);
  if (!prompt.trim()) {
    throw new Error("prompt must not be empty");
  }

  const parentSessionId = getSessionId();
  const logger = getLogger();

  // Lazy import to avoid circular dependency: delegate -> orchestrator -> agents -> tools/index -> delegate
  const { executeTurn } = await import("../agent/orchestrator.ts");

  let result;
  try {
    result = await executeTurn({ prompt, assistant: agent });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Delegation to agent "${agent}" failed: ${msg}`);
  }

  if (logger) {
    logger.info(`[delegate] child session ${result.sessionId} (agent: ${agent})`);
  }

  const snippet = prompt.slice(0, 80);
  return createDocument(
    result.answer,
    `Delegation result from "${agent}": ${snippet}`,
    {
      source: null,
      type: "document",
      mimeType: "text/plain",
    },
    parentSessionId,
  );
}

const agents = await scanAgents();
const agentNames = agents.map((a) => a.name) as [string, ...string[]];
const agentDescriptions = agents
  .map((a) => `- **${a.name}**: ${a.description}`)
  .join("\n");

export default {
  name: "delegate",
  schema: {
    name: "delegate",
    description: `Delegate a subtask to a specialized agent. The child agent runs in an isolated session and returns its final answer.\n\nAvailable agents:\n${agentDescriptions}`,
    schema: z.object({
      agent: z.enum(agentNames).describe("Name of the agent to delegate to"),
      prompt: z.string().describe("The task prompt to send to the child agent"),
    }),
  },
  handler: delegate,
} satisfies ToolDefinition;
