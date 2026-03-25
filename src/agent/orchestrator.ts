import { runAgent } from "./loop.ts";
import { sessionService } from "./session.ts";
import { agentsService } from "./agents.ts";
import { log } from "../infra/log/logger.ts";
import { moderateInput, assertNotFlagged } from "../infra/guard.ts";
import { randomSessionId } from "../utils/id.ts";
import type { LLMMessage } from "../types/llm.ts";
import type { AgentState } from "../types/agent-state.ts";
import type { Session } from "../types/session.ts";
import { emptyMemoryState } from "../types/memory.ts";
import { loadState } from "./memory/persistence.ts";

interface ExecuteTurnOpts {
  sessionId?: string;
  prompt: string;
  assistant?: string;
  model?: string;
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
  const moderation = await moderateInput(opts.prompt);
  assertNotFlagged(moderation);

  if (!session.assistant) {
    session.assistant = assistantName;
  }

  sessionService.appendMessage(sessionId, { role: "user", content: opts.prompt });

  const messages: LLMMessage[] = [...session.messages];

  const persisted = await loadState(sessionId);

  const state: AgentState = {
    sessionId,
    messages,
    tokens: {
      plan: { promptTokens: 0, completionTokens: 0 },
      act: { promptTokens: 0, completionTokens: 0 },
    },
    iteration: 0,
    assistant: assistantName,
    model: opts.model ?? "",
    tools: [],
    memory: persisted ?? emptyMemoryState(),
  };

  const result = await runAgent(state);

  for (const m of result.messages) {
    sessionService.appendMessage(sessionId, m);
  }

  return { answer: result.answer, sessionId };
}
