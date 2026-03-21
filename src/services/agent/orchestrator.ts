import { runAgent } from "../../agent.ts";
import { sessionService } from "./session.ts";
import { assistantResolverService } from "./assistant/assistant-resolver.ts";
import { log } from "../common/logging/logger.ts";
import { randomSessionId } from "../../utils/id.ts";
import type { LLMMessage } from "../../types/llm.ts";
import type { Session } from "../../types/session.ts";

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

  const resolved = await assistantResolverService.resolve(assistantName);

  if (!session.assistant) {
    session.assistant = assistantName;
  }

  if (session.messages.length === 0) {
    sessionService.appendMessage(sessionId, { role: "system", content: resolved.prompt });
  }
  sessionService.appendMessage(sessionId, { role: "user", content: opts.prompt });

  const messages: LLMMessage[] = [...session.messages];
  const result = await runAgent(messages, undefined, {
    model: opts.model ?? resolved.model,
    sessionId,
    toolFilter: resolved.toolFilter,
    assistant: assistantName,
  });

  for (const m of result.messages) {
    sessionService.appendMessage(sessionId, m);
  }

  return { answer: result.answer, sessionId };
}
