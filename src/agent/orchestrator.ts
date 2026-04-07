import { runAgent } from "./loop.ts";
import { sessionService } from "./session.ts";
import { agentsService } from "./agents.ts";
import { log } from "../infra/log/logger.ts";
import { moderateInput, assertNotFlagged } from "../infra/guard.ts";
import { bus } from "../infra/events.ts";
import { randomUUID } from "node:crypto";
import { randomSessionId } from "../utils/id.ts";
import type { LLMMessage } from "../types/llm.ts";
import type { AgentState } from "../types/agent-state.ts";
import type { Session } from "../types/session.ts";
import { emptyMemoryState } from "../types/memory.ts";
import { loadState } from "./memory/persistence.ts";
import * as dbOps from "../infra/db/index.ts";

interface ExecuteTurnOpts {
  sessionId?: string;
  prompt: string;
  assistant?: string;
  model?: string;
  parentAgentId?: string;
  parentRootAgentId?: string;
  parentTraceId?: string;
  parentDepth?: number;
  sourceCallId?: string;
}

interface ExecuteTurnResult {
  answer: string;
  sessionId: string;
}

function pickAssistantName(
  session: Session,
  sessionId: string,
  requestedAssistant?: string,
): string {
  if (session.assistant) {
    if (requestedAssistant && requestedAssistant !== session.assistant) {
      log.info(
        `[${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`,
      );
    }
    return session.assistant;
  }
  return requestedAssistant ?? "default";
}

export async function executeTurn(opts: ExecuteTurnOpts): Promise<ExecuteTurnResult> {
  const sessionId = opts.sessionId ?? randomSessionId();
  const session = sessionService.getOrCreate(sessionId);
  const assistantName = pickAssistantName(session, sessionId, opts.assistant);

  // Validate agent exists before proceeding (throws "Unknown agent" if not found)
  await agentsService.get(assistantName);

  // Moderation guardrail — check user input before it enters the session
  const moderationStart = Date.now();
  const moderation = await moderateInput(opts.prompt);
  const moderationDurationMs = Date.now() - moderationStart;

  if (moderation.flagged) {
    const flaggedCategories = Object.entries(moderation.categories)
      .filter(([, v]) => v)
      .map(([k]) => k);
    bus.emit("input.flagged", {
      categories: flaggedCategories,
      categoryScores: moderation.categoryScores,
    });
  } else {
    bus.emit("input.clean", { durationMs: moderationDurationMs });
  }

  assertNotFlagged(moderation);

  if (!session.assistant) {
    sessionService.setAssistant(sessionId, assistantName);
  }

  const agentId = randomUUID();
  const traceId = opts.parentTraceId ?? randomUUID();
  const depth = opts.parentAgentId ? (opts.parentDepth ?? 0) + 1 : 0;

  // Persist agent row
  dbOps.createAgent({
    id: agentId,
    sessionId,
    parentId: opts.parentAgentId,
    sourceCallId: opts.sourceCallId,
    template: assistantName,
    task: opts.prompt,
  });

  // Set root agent for the session if this is the root agent
  if (!opts.parentAgentId) {
    dbOps.setRootAgent(sessionId, agentId);
  }

  dbOps.updateAgentStatus(agentId, "running");

  // Append user message to DB
  sessionService.appendMessage(sessionId, agentId, { role: "user", content: opts.prompt });

  // Load full conversation for this agent
  const messages: LLMMessage[] = sessionService.getMessages(sessionId, agentId);

  const persisted = await loadState(sessionId);

  const state: AgentState = {
    sessionId,
    agentName: assistantName,
    agentId,
    rootAgentId: opts.parentRootAgentId ?? agentId,
    parentAgentId: opts.parentAgentId,
    traceId,
    depth,
    messages,
    tokens: { promptTokens: 0, completionTokens: 0 },
    iteration: 0,
    assistant: assistantName,
    model: opts.model ?? "",
    tools: [],
    memory: persisted ?? emptyMemoryState(),
  };

  try {
    const result = await runAgent(state);

    // Persist the turn messages produced by the agent loop
    sessionService.appendTurn(sessionId, agentId, result.messages);

    dbOps.updateAgentStatus(agentId, "completed", result.answer);

    return { answer: result.answer, sessionId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    dbOps.updateAgentStatus(agentId, "failed", undefined, errorMsg);
    throw err;
  }
}
