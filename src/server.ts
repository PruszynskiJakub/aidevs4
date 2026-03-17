import { Hono } from "hono";
import { runAgent } from "./agent.ts";
import { sessionService } from "./services/agent/session.ts";
import { resolveAssistant } from "./services/agent/assistant/assistant-resolver.ts";
import { log } from "./services/common/logging/logger.ts";
import { config } from "./config/index.ts";
import type { LLMMessage } from "./types/llm.ts";
import type { Session } from "./types/session.ts";

interface ChatRequest {
  sessionId: string;
  msg: string;
  requestedAssistant?: string;
}

function parseChatBody(body: unknown): ChatRequest | { error: string } {
  if (!body || typeof (body as Record<string, unknown>).msg !== "string") {
    return { error: "Body must contain sessionId/sessionID (string) and msg (string)" };
  }

  const b = body as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId
    : typeof b.sessionID === "string" ? b.sessionID
    : undefined;

  if (!sessionId) {
    return { error: "Body must contain sessionId or sessionID (string)" };
  }

  const requestedAssistant = typeof b.assistant === "string" && b.assistant !== ""
    ? b.assistant
    : undefined;

  return { sessionId, msg: b.msg as string, requestedAssistant };
}

function pickAssistantName(
  session: Session,
  sessionId: string,
  requestedAssistant?: string,
): string {
  if (session.assistant) {
    if (requestedAssistant && requestedAssistant !== session.assistant) {
      log.info(
        `/chat [${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`,
      );
    }
    return session.assistant;
  }
  return requestedAssistant ?? "default";
}

async function executeChatTurn(
  sessionId: string,
  msg: string,
  requestedAssistant?: string,
): Promise<string> {
  const session = sessionService.getOrCreate(sessionId);
  const assistantName = pickAssistantName(session, sessionId, requestedAssistant);

  let resolved;
  try {
    resolved = await resolveAssistant(assistantName);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unknown assistant")) {
      throw Object.assign(new Error(err.message), { statusCode: 400 });
    }
    throw err;
  }

  if (!session.assistant) {
    session.assistant = assistantName;
  }

  if (session.messages.length === 0) {
    sessionService.appendMessage(sessionId, { role: "system", content: resolved.prompt });
  }
  sessionService.appendMessage(sessionId, { role: "user", content: msg });

  const messages: LLMMessage[] = [...session.messages];
  const result = await runAgent(messages, undefined, {
    model: resolved.model,
    sessionId,
    toolFilter: resolved.toolFilter,
  });

  const newMessages = messages.slice(session.messages.length);
  for (const m of newMessages) {
    sessionService.appendMessage(sessionId, m);
  }

  return result;
}

const app = new Hono();

app.use("*", async (c, next) => {
  const start = performance.now();
  await next();
  const ms = (performance.now() - start).toFixed(0);
  log.info(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseChatBody(body);

  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const { sessionId, msg, requestedAssistant } = parsed;

  try {
    const answer = await sessionService.enqueue(sessionId, () =>
      executeChatTurn(sessionId, msg, requestedAssistant),
    );
    return c.json({ msg: answer });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    if (statusCode === 400) {
      return c.json({ error: message }, 400);
    }
    log.error(`/chat error [${sessionId}]: ${message}`);
    return c.json({ error: message }, 500);
  }
});

const port = config.server.port;

export default {
  fetch: app.fetch,
  port,
};

log.info(`Server listening on http://localhost:${port}`);
