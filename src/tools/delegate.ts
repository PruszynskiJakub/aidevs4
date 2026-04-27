import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { getRunId, getRootRunId, getTraceId, getDepth, getLogger } from "../agent/context.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createChildRun } from "../agent/orchestrator.ts";
import { bus } from "../infra/events.ts";
import { agentsService } from "../agent/agents.ts";

const MAX_PROMPT_LENGTH = 10_000;

async function delegate(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  const { agent, prompt } = args as { agent: string; prompt: string };

  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);
  if (!prompt.trim()) {
    throw new Error("prompt must not be empty");
  }

  const parentRunId = getRunId();
  if (!parentRunId) throw new Error("delegate requires an active run context");

  const rootRunId = getRootRunId() ?? parentRunId;
  const logger = getLogger();

  const child = await createChildRun({
    prompt,
    assistant: agent,
    parentRunId,
    rootRunId,
    parentTraceId: getTraceId(),
    parentDepth: getDepth(),
    sourceCallId: ctx?.toolCallId,
  });

  if (logger) {
    logger.info(`[delegate] created child run ${child.runId} (agent: ${agent})`);
  }

  bus.emit("run.delegated", {
    childRunId: child.runId,
    childAgent: agent,
    task: prompt,
  });

  // Signal the parent to park — the continuation subscriber will resume it
  // when the child reaches a terminal state.
  return {
    content: [{ type: "text", text: `Delegated to ${agent} (run ${child.runId})` }],
    wait: { kind: "child_run", childRunId: child.runId },
  };
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
