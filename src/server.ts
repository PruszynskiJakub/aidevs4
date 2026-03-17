import { Hono } from "hono";
import { runAgent } from "./agent.ts";
import { sessionService } from "./services/session.ts";
import { resolveAssistant } from "./services/assistant-resolver.ts";
import { log } from "./services/logger.ts";
import { config } from "./config/index.ts";
import type { LLMMessage } from "./types/llm.ts";

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

  if (!body || typeof body.msg !== "string") {
    return c.json(
      { error: "Body must contain sessionId/sessionID (string) and msg (string)" },
      400,
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId
    : typeof body.sessionID === "string" ? body.sessionID
    : undefined;

  if (!sessionId) {
    return c.json(
      { error: "Body must contain sessionId or sessionID (string)" },
      400,
    );
  }

  // Resolve assistant name — from body, existing session, or default
  const requestedAssistant = typeof body.assistant === "string" && body.assistant !== ""
    ? body.assistant
    : undefined;

  const { msg } = body as { msg: string };

  try {
    const answer = await sessionService.enqueue(sessionId, async () => {
      const session = sessionService.getOrCreate(sessionId);

      // Determine assistant: session-pinned > request > "default"
      let assistantName: string;
      if (session.assistant) {
        assistantName = session.assistant;
        if (requestedAssistant && requestedAssistant !== session.assistant) {
          log.info(
            `/chat [${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`,
          );
        }
      } else {
        assistantName = requestedAssistant ?? "default";
      }

      // Resolve assistant — assistants.get() throws with available names if unknown
      let resolved;
      try {
        resolved = await resolveAssistant(assistantName);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Unknown assistant")) {
          throw Object.assign(new Error(err.message), { statusCode: 400 });
        }
        throw err;
      }

      // Pin assistant to session on first interaction
      if (!session.assistant) {
        session.assistant = assistantName;
      }

      // First interaction — prepend system prompt
      if (session.messages.length === 0) {
        sessionService.appendMessage(sessionId, {
          role: "system",
          content: resolved.prompt,
        });
      }

      sessionService.appendMessage(sessionId, { role: "user", content: msg });

      // Pass a copy so runAgent's pushes don't double-add to session
      const messages: LLMMessage[] = [...session.messages];
      const result = await runAgent(messages, undefined, {
        model: resolved.model,
        sessionId,
        toolFilter: resolved.toolFilter,
      });

      // Persist the messages that runAgent appended (assistant + tool messages)
      const newMessages = messages.slice(session.messages.length);
      for (const m of newMessages) {
        sessionService.appendMessage(sessionId, m);
      }

      return result;
    });

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
