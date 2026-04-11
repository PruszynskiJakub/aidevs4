import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { getSessionId, getLogger, getRunId, getRootRunId, getTraceId, getDepth } from "../agent/context.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { executeRun } from "../agent/orchestrator.ts";
import { agentsService } from "../agent/agents.ts";

const MAX_PROMPT_LENGTH = 10_000;

async function delegate(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  const { agent, prompt } = args as { agent: string; prompt: string };

  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);
  if (!prompt.trim()) {
    throw new Error("prompt must not be empty");
  }

  const parentSessionId = getSessionId();
  const logger = getLogger();

  let result;
  try {
    result = await executeRun({
      prompt,
      assistant: agent,
      parentRunId: getRunId(),
      parentRootRunId: getRootRunId(),
      parentTraceId: getTraceId(),
      parentDepth: getDepth(),
      sourceCallId: ctx?.toolCallId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Delegation to agent "${agent}" failed: ${msg}`);
  }

  if (logger) {
    logger.info(`[delegate] child session ${result.sessionId} (agent: ${agent})`);
  }

  if (result.exit.kind !== "completed") {
    throw new Error(
      `Delegation to agent "${agent}" did not complete (kind=${result.exit.kind})`,
    );
  }

  return text(result.exit.result);
}

const agents = await agentsService.listAgents();
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
