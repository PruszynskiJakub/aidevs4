import { z } from "zod";
import type { ToolDefinition, ToolCallContext } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { assertMaxLength } from "../utils/parse.ts";
import { createChildRun } from "../agent/orchestrator.ts";
import { bus } from "../infra/events.ts";
import { agentsService } from "../agent/agents.ts";
import { DomainError } from "../types/errors.ts";
import { errorMessage } from "../utils/parse.ts";

const MAX_PROMPT_LENGTH = 10_000;

async function delegate(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult> {
  const { agent, prompt } = args as { agent: string; prompt: string };

  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);
  if (!prompt.trim()) {
    throw new DomainError({ type: "validation", message: "prompt must not be empty" });
  }

  const runCtx = ctx?.runCtx;
  if (!runCtx?.runId) {
    throw new DomainError({ type: "validation", message: "delegate requires an active run context" });
  }
  const parentRunId = runCtx.runId;
  const rootRunId = runCtx.rootRunId ?? parentRunId;

  let child: { runId: string; sessionId: string };
  try {
    child = await createChildRun({
      prompt,
      assistant: agent,
      parentRunId,
      rootRunId,
      parentTraceId: runCtx.traceId,
      parentDepth: runCtx.depth,
      sourceCallId: ctx?.toolCallId,
    }, runCtx.runtime);
  } catch (err) {
    throw new DomainError({
      type: "external",
      message: `Delegation to agent "${agent}" failed: ${errorMessage(err)}`,
      cause: err,
    });
  }

  runCtx.log.info(`[delegate] created child run ${child.runId} (agent: ${agent})`);

  bus.emit("run.delegated", {
    childRunId: child.runId,
    childAgent: agent,
    task: prompt,
  }, {
    sessionId: runCtx.sessionId,
    runId: parentRunId,
    rootRunId,
    traceId: runCtx.traceId,
    depth: runCtx.depth,
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
